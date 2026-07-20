import { expect, test } from "vitest";
import { withTunnel } from "../test-support/tunnel.ts";
import { waitForCondition } from "../test-support/wait-for-condition.ts";
import { startEgressEcho } from "./itx-capability-fixtures.ts";
import {
  echoedEgressProofHeader,
  EGRESS_PROOF_HEADER,
  egressProbeWorker,
} from "./itx-test-support.ts";
import { adminSecret, withItxSession } from "./test-helpers.ts";

// These are hand written tests - they MUST pass
test("public secret events can change egress but copied ciphertext cannot follow", async () => {
  await using original = await startEgressEcho();
  await using attacker = await startEgressEcho();
  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = itx.projects.create({ slug: `secret-stream-forgery-${crypto.randomUUID()}` });
  const secretPath = `/secrets/stream-forgery/${crypto.randomUUID()}`;
  using secret = project.secrets.get(secretPath);
  await secret.create({
    egress: { urls: [original.url] },
    material: "user-submitted-material",
  });

  const stream = project.streams.get(secretPath);
  const birthCertificate = (await stream.getEvents()).find(
    (event) => event.type === "events.iterate.com/secret/created",
  );
  const encryptedMaterial = (
    birthCertificate?.payload as { config?: Record<string, unknown> } | undefined
  )?.config?.["encryptedMaterial"];
  expect(encryptedMaterial).toBeDefined();

  await stream.append({
    type: "events.iterate.com/secret/updated",
    payload: { egress: { urls: [attacker.url] } },
  });
  expect(await secret.__describe()).toMatchObject({
    egress: { urls: [attacker.url] },
    hasMaterial: false,
  });

  // Supplying the publicly readable old blob does not count as authority:
  // its AES-GCM context names the original origin and committed offset.
  await stream.append({
    type: "events.iterate.com/secret/updated",
    payload: { egress: { urls: [attacker.url] }, encryptedMaterial },
  });
  using probe = egressProbeWorker(project);
  expect(
    await probe.probeFetch({
      headerValue: `Bearer getSecret("${secretPath}")`,
      url: attacker.url,
    }),
  ).toEqual({ error: "secret_not_found" });
});

test("every egress-only update clears retained secret material", async () => {
  await using original = await startEgressEcho();
  await using attacker = await startEgressEcho();
  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = itx.projects.create({ slug: `secret-repin-${crypto.randomUUID()}` });
  using secret = project.secrets.get(`/secrets/repin/${crypto.randomUUID()}`);

  await secret.create({
    egress: { urls: [original.url] },
    material: "user-submitted-material",
  });

  const sameOriginPath = new URL("/narrower-path", original.url).toString();
  await secret.update({ egress: { urls: [sameOriginPath] } });
  expect(await secret.__describe()).toMatchObject({
    egress: { urls: [sameOriginPath] },
    hasMaterial: false,
  });

  await secret.update({ egress: { urls: [attacker.url] } });
  expect(await secret.__describe()).toMatchObject({
    egress: { urls: [attacker.url] },
    hasMaterial: false,
  });

  await expect(
    secret.update({ material: "must-not-inherit-public-egress" } as unknown as Parameters<
      typeof secret.update
    >[0]),
  ).rejects.toThrow("secret.update requires egress with replacement material");
  expect(await secret.__describe()).toMatchObject({
    egress: { urls: [attacker.url] },
    hasMaterial: false,
  });

  await secret.update({
    egress: { urls: [attacker.url] },
    material: "replacement-material",
  });
  expect(await secret.__describe()).toMatchObject({ egress: { urls: [attacker.url] } });

  await secret.update({
    egress: { urls: [original.url, attacker.url] },
    material: "concurrent-update-material",
  });
  const concurrentChanges = await Promise.allSettled([
    secret.update({ egress: { urls: [original.url] } }),
    secret.update({ egress: { urls: [attacker.url] } }),
  ]);
  expect(concurrentChanges.map(({ status }) => status)).toEqual(["fulfilled", "fulfilled"]);
  expect([[original.url], [attacker.url]]).toContainEqual((await secret.__describe()).egress.urls);
  expect(await secret.__describe()).toMatchObject({ hasMaterial: false });
});

test("an in-flight refresh cannot resurrect material after an egress event", async () => {
  let announceRefresh!: () => void;
  const refreshStarted = new Promise<void>((resolve) => (announceRefresh = resolve));
  let releaseRefresh!: () => void;
  const refreshMayFinish = new Promise<void>((resolve) => (releaseRefresh = resolve));
  await using provider = await withTunnel({
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/oauth/token") {
        announceRefresh();
        await refreshMayFinish;
        return Response.json({ access_token: "fresh-access-token" });
      }
      if (path === "/resource") {
        return Response.json({ stale: true }, { status: 401 });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    },
  });
  await using attacker = await startEgressEcho();
  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = itx.projects.create({ slug: `secret-refresh-race-${crypto.randomUUID()}` });
  const secretPath = `/secrets/refresh-race/${crypto.randomUUID()}`;
  using secret = project.secrets.get(secretPath);
  await secret.create({
    egress: { urls: [provider.url] },
    material: {
      accessToken: "stale-access-token",
      clientId: "public-client",
      refreshToken: "refresh-token",
    },
    refresh: {
      clientCreds: "material",
      kind: "oauth-refresh-token",
      tokenEndpoint: `${provider.url}/oauth/token`,
    },
  });

  using probe = egressProbeWorker(project);
  const request = probe.probeFetch({
    headerValue: `Bearer getSecret("${secretPath}", { field: "accessToken" })`,
    url: `${provider.url}/resource`,
  });
  await refreshStarted;
  await project.streams.get(secretPath).append({
    type: "events.iterate.com/secret/updated",
    payload: { egress: { urls: [attacker.url] } },
  });
  releaseRefresh();

  await expect(request).resolves.toEqual({ stale: true });
  expect(await secret.__describe()).toMatchObject({
    egress: { urls: [attacker.url] },
    hasMaterial: false,
  });
});

test("a repeated refresh event before its snapshot cannot resurrect material", async () => {
  let announceResource!: () => void;
  const resourceStarted = new Promise<void>((resolve) => (announceResource = resolve));
  let releaseResource!: () => void;
  const resourceMayFinish = new Promise<void>((resolve) => (releaseResource = resolve));
  let tokenRequests = 0;
  await using provider = await withTunnel({
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/oauth/token") {
        tokenRequests += 1;
        return Response.json({ access_token: "must-not-be-minted" });
      }
      if (path === "/resource") {
        announceResource();
        await resourceMayFinish;
        return Response.json({ stale: true }, { status: 401 });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    },
  });
  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = itx.projects.create({
    slug: `secret-refresh-cleared-${crypto.randomUUID()}`,
  });
  const secretPath = `/secrets/refresh-cleared/${crypto.randomUUID()}`;
  using secret = project.secrets.get(secretPath);
  const refresh = {
    clientCreds: "material",
    kind: "oauth-refresh-token",
    tokenEndpoint: `${provider.url}/oauth/token`,
  } as const;
  await secret.create({
    egress: { urls: [provider.url] },
    material: {
      accessToken: "stale-access-token",
      clientId: "public-client",
      refreshToken: "refresh-token",
    },
    refresh,
  });

  using probe = egressProbeWorker(project);
  const request = probe.probeFetch({
    headerValue: `Bearer getSecret("${secretPath}", { field: "accessToken" })`,
    url: `${provider.url}/resource`,
  });
  await resourceStarted;
  await project.streams.get(secretPath).append({
    type: "events.iterate.com/secret/updated",
    payload: { refresh },
  });
  releaseResource();

  await expect(request).resolves.toEqual({ stale: true });
  expect(tokenRequests).toBe(0);
  expect(await secret.__describe()).toMatchObject({
    hasMaterial: false,
    refresh: "oauth-refresh-token",
  });
});

test("secret egress rejects a cross-origin redirect without forwarding material", async () => {
  const received: string[] = [];
  await using attacker = await withTunnel({
    path: "/capture",
    fetch(request) {
      received.push(request.headers.get(EGRESS_PROOF_HEADER) ?? "");
      return Response.json({ captured: true });
    },
  });
  await using allowed = await withTunnel({
    path: "/redirect",
    fetch() {
      return Response.redirect(attacker.url, 302);
    },
  });
  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = itx.projects.create({ slug: `secret-redirect-${crypto.randomUUID()}` });
  const secretPath = `/secrets/redirect/${crypto.randomUUID()}`;
  using secret = project.secrets.get(secretPath);

  await secret.create({
    egress: { urls: [allowed.url] },
    material: "redirect-exfiltration-proof",
  });
  using probe = egressProbeWorker(project);
  const responseBody = await probe.probeFetch({
    headerValue: `Bearer getSecret("${secretPath}")`,
    url: allowed.url,
  });

  expect(responseBody).toEqual({ error: "secret_not_allowed_for_origin" });
  expect(received).toEqual([]);
});

test("URL-path secret material is not returned in Response metadata", async () => {
  const receivedPaths: string[] = [];
  await using endpoint = await withTunnel({
    fetch(request) {
      receivedPaths.push(new URL(request.url).pathname);
      return Response.json({ ok: true });
    },
  });
  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = itx.projects.create({ slug: `secret-response-url-${crypto.randomUUID()}` });
  const secretPath = `/secrets/response-url/${crypto.randomUUID()}`;
  const material = `url-secret-${crypto.randomUUID()}`;
  using secret = project.secrets.get(secretPath);

  await secret.create({
    egress: { urls: [endpoint.url] },
    material,
  });

  using probe = egressProbeWorker(project);
  const response = await probe.probeSecretResponse({
    secretPath,
    url: `${new URL(endpoint.url).origin}/botgetSecret("${secretPath}")/getMe`,
  });

  expect(response).toMatchObject({ url: "", redirected: false });
  // oxlint-disable-next-line iterate/prefer-object-property-match -- toEqual pins the exact body; a subset match would tolerate extra keys
  expect(response.body).toEqual({ ok: true });
  expect(receivedPaths).toEqual([`/bot${material}/getMe`]);
});

test("Project egress substitutes path-addressed secrets for explicit and project worker fetches", async () => {
  const echo = await startEgressEcho();
  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });

  try {
    using project = itx.projects.create({ slug: `project-egress-${crypto.randomUUID()}` });
    const secretPath = `/secrets/egress-proof/${crypto.randomUUID()}`;
    using secret = project.secrets.get(secretPath);
    await secret.create({
      egress: { urls: [echo.url] },
      material: "actual-secret-material",
    });

    const agentPath = `/agents/list-proof/${crypto.randomUUID()}`;
    const repoPath = `/repos/list-proof/${crypto.randomUUID()}`;
    await Promise.all([
      project.agents.get(agentPath).create(),
      project.repos.get(repoPath).create(),
    ]);
    await waitForCondition(
      async () => (await project.secrets.list()).some((item) => item.path === secretPath),
      { description: "secret stream to appear in project processor list" },
    );
    await waitForCondition(async () => (await secret.__describe()).hasMaterial, {
      description: "secret processor to fold the update",
    });

    const described = await secret.__describe();
    expect(described).toMatchObject({
      audit: { usedCount: 0 },
      egress: { urls: [echo.url] },
      hasMaterial: true,
    });
    expect(JSON.stringify(described)).not.toContain("actual-secret-material");

    const secretReference = `Bearer getSecret("${secretPath}")`;
    const expected = "Bearer actual-secret-material";

    const explicitResponse = await project.egress.fetch(
      new Request(echo.url, {
        headers: { [EGRESS_PROOF_HEADER]: secretReference },
      }),
    );
    expect(explicitResponse).toMatchObject({ status: 200 });
    expect(echoedEgressProofHeader(await explicitResponse.json())).toBe(expected);

    using probe = egressProbeWorker(project);
    const workerBody = await probe.probeFetch({
      headerValue: secretReference,
      url: echo.url,
    });
    expect(echoedEgressProofHeader(workerBody)).toBe(expected);

    await waitForCondition(async () => (await secret.__describe()).audit.usedCount === 2, {
      description: "secret usage audit to fold",
    });
    // Child-stream birth certificates propagate to the project root stream
    // asynchronously (child DO → parent chain → project processor), so wait
    // for the fold before asserting its content — same treatment the secret
    // fold gets above. Cold deployments take several seconds here.
    await waitForCondition(
      async () => {
        const streams = (await project.processor.snapshot()).state.streams;
        return [agentPath, repoPath, secretPath].every((path) =>
          streams.some((item) => item.path === path),
        );
      },
      { description: "project processor to fold the created child streams", timeoutMs: 30_000 },
    );
    expect(await project.streams.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "/" }),
        expect.objectContaining({ path: secretPath }),
      ]),
    );
    await waitForCondition(
      async () => {
        const state = (await project.processor.snapshot()).state;
        const streamPaths = new Set(state.streams.map((item) => item.path));
        const repoPaths = new Set(state.repos.map((item) => item.path));
        return (
          streamPaths.has(agentPath) &&
          streamPaths.has(repoPath) &&
          streamPaths.has(secretPath) &&
          repoPaths.has(repoPath)
        );
      },
      { description: "project processor to fold agent, repo, and secret stream lists" },
    );
    const projectState = (await project.processor.snapshot()).state;
    expect(projectState).toMatchObject({
      streams: expect.arrayContaining([
        expect.objectContaining({ path: "/" }),
        expect.objectContaining({ path: agentPath }),
        expect.objectContaining({ path: repoPath }),
        expect.objectContaining({ path: secretPath }),
      ]),
      repos: expect.arrayContaining([
        expect.objectContaining({ path: "/repos/config" }),
        expect.objectContaining({ path: repoPath }),
      ]),
      secrets: expect.arrayContaining([expect.objectContaining({ path: secretPath })]),
    });
    await waitForCondition(
      async () =>
        Object.hasOwn((await project.agents.processor.snapshot()).state.agents, agentPath),
      {
        description: "agent collection processor to fold the created agent",
        timeoutMs: 30_000,
      },
    );
    const agentDatabase = (await project.agents.processor.snapshot()).state;
    expect(agentDatabase.agents).toMatchObject({
      [agentPath]: expect.objectContaining({ path: agentPath }),
    });
    expect(await project.secrets.list()).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: secretPath })]),
    );
    expect((await project.agents.list()).some((item) => item.path.startsWith("/agents/"))).toBe(
      true,
    );
    expect((await project.repos.list()).some((item) => item.path === "/repos/config")).toBe(true);
    expect((await project.repos.list()).some((item) => item.path.startsWith("/repos/"))).toBe(true);
    // Birth seeds keyed boot context in the system lane (platform context:
    // project id, agent path, repo layout), so no LLM turn runs. Ingest is
    // async: wait for the processor to fold the birth events before asserting
    // (cold slots under CI load have been seen to lag).
    const agentProcessor = project.agents.get(agentPath).processor;
    await waitForCondition(
      async () =>
        (await agentProcessor.snapshot()).state.context.system.some(
          (item) => item.key === "agent/boot-context",
        ),
      {
        description: "agent boot context to fold into system context",
        timeoutMs: 30_000,
      },
    );
    expect((await agentProcessor.snapshot()).state).toMatchObject({
      context: {
        system: expect.arrayContaining([
          expect.objectContaining({
            role: "system",
            key: "agent/boot-context",
            content: expect.stringContaining(`Your agent stream path: ${agentPath}`),
          }),
        ]),
      },
    });
    expect((await project.repo.processor.snapshot()).state).toMatchObject({
      birthCertificate: { config: {} },
      ready: true,
    });
    // oxlint-disable-next-line iterate/prefer-object-property-match -- toEqual pins the exact egress config; a subset match would tolerate extra keys
    expect((await secret.processor.snapshot()).state.egress).toEqual({ urls: [echo.url] });
  } finally {
    await echo.close();
  }
});

test("Project egress intercept catches explicit and worker fetches before secret substitution", async () => {
  const echo = await startEgressEcho();
  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });

  try {
    using project = itx.projects.create({
      slug: `project-egress-intercept-${crypto.randomUUID()}`,
    });
    const secretPath = `/secrets/egress-intercept/${crypto.randomUUID()}`;
    using secret = project.secrets.get(secretPath);
    await secret.create({
      egress: { urls: [echo.url] },
      material: "intercept-secret-material",
    });
    await waitForCondition(async () => (await secret.__describe()).hasMaterial, {
      description: "intercept proof secret to be available",
    });

    const secretReference = `Bearer getSecret("${secretPath}")`;
    using intercept = await project.egress.intercept(async (request) => {
      return Response.json({
        intercepted: true,
        proof: request.headers.get(EGRESS_PROOF_HEADER),
        url: request.url,
      });
    });

    const explicitResponse = await project.egress.fetch(
      new Request(echo.url, {
        headers: { [EGRESS_PROOF_HEADER]: secretReference },
      }),
    );
    await expect(explicitResponse.json()).resolves.toEqual({
      intercepted: true,
      proof: secretReference,
      url: echo.url,
    });

    using probe = egressProbeWorker(project);
    const workerBody = await probe.probeFetch({
      headerValue: secretReference,
      url: echo.url,
    });
    expect(workerBody).toEqual({
      intercepted: true,
      proof: secretReference,
      url: echo.url,
    });
    expect(JSON.stringify(workerBody)).not.toContain("intercept-secret-material");
    expect(await secret.__describe()).toMatchObject({ audit: { usedCount: 0 } });

    await intercept.release();

    const terminalResponse = await project.egress.fetch(
      new Request(echo.url, {
        headers: { [EGRESS_PROOF_HEADER]: secretReference },
      }),
    );
    expect(echoedEgressProofHeader(await terminalResponse.json())).toBe(
      "Bearer intercept-secret-material",
    );
  } finally {
    await echo.close();
  }
});
