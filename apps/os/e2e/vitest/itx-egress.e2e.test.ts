import { describe, expect, test } from "vitest";
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
describe("itx", () => {
  test("secret control events cannot be forged through the public stream API", async () => {
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
    await secret.update({
      egress: { urls: [original.url] },
      material: "user-submitted-material",
    });

    let appendError: unknown;
    try {
      await project.streams.get(secretPath).append({
        type: "events.iterate.com/secret/updated",
        payload: { egress: { urls: [attacker.url] } },
      });
    } catch (error) {
      appendError = error;
    }

    expect(String(appendError)).toMatch(/Secret Durable Object/);
    expect((await secret.__describe()).egress.urls).toEqual([original.url]);
  });

  test("retained secret material cannot be re-pinned to a new origin", async () => {
    await using original = await startEgressEcho();
    await using attacker = await startEgressEcho();
    using session = withItxSession();
    using itx = session.authenticate({
      type: "admin-secret",
      secret: adminSecret(),
    });
    using project = itx.projects.create({ slug: `secret-repin-${crypto.randomUUID()}` });
    using secret = project.secrets.get(`/secrets/repin/${crypto.randomUUID()}`);

    await secret.update({
      egress: { urls: [original.url] },
      material: "user-submitted-material",
    });

    const sameOriginPath = new URL("/narrower-path", original.url).toString();
    await secret.update({ egress: { urls: [sameOriginPath] } });

    let updateError: unknown;
    try {
      await secret.update({ egress: { urls: [attacker.url] } });
    } catch (error) {
      updateError = error;
    }
    expect(String(updateError)).toMatch(/resubmitting material/);
    expect((await secret.__describe()).egress.urls).toEqual([sameOriginPath]);

    await secret.update({
      egress: { urls: [attacker.url] },
      material: "replacement-material",
    });
    expect((await secret.__describe()).egress.urls).toEqual([attacker.url]);

    await secret.update({
      egress: { urls: [original.url, attacker.url] },
      material: "concurrent-update-material",
    });
    const concurrentNarrowings = await Promise.allSettled([
      secret.update({ egress: { urls: [original.url] } }),
      secret.update({ egress: { urls: [attacker.url] } }),
    ]);
    expect(concurrentNarrowings.map(({ status }) => status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect([[original.url], [attacker.url]]).toContainEqual(
      (await secret.__describe()).egress.urls,
    );
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

    await secret.update({
      egress: { urls: [allowed.url] },
      material: "redirect-exfiltration-proof",
    });
    using probe = egressProbeWorker(project);
    const responseBody = await probe.probeFetch({
      headerValue: `Bearer getSecret({ path: "${secretPath}" })`,
      url: allowed.url,
    });

    expect(responseBody).toEqual({ error: "secret_not_allowed_for_origin" });
    expect(received).toEqual([]);
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
      await secret.update({
        egress: { urls: [echo.url] },
        material: "actual-secret-material",
      });

      const agentPath = `/agents/list-proof/${crypto.randomUUID()}`;
      const repoPath = `/repos/list-proof/${crypto.randomUUID()}`;
      await project.streams.get(agentPath).append({
        type: "events.iterate.test/list-agent",
      });
      await project.streams.get(repoPath).append({
        type: "events.iterate.test/list-repo",
      });
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

      const secretReference = `Bearer getSecret({ path: "${secretPath}" })`;
      const expected = "Bearer actual-secret-material";

      const explicitResponse = await project.egress.fetch(
        new Request(echo.url, {
          headers: { [EGRESS_PROOF_HEADER]: secretReference },
        }),
      );
      expect(explicitResponse.status).toBe(200);
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
      expect(projectState.streams).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "/" }),
          expect.objectContaining({ path: agentPath }),
          expect.objectContaining({ path: repoPath }),
          expect.objectContaining({ path: secretPath }),
        ]),
      );
      expect(projectState.agents).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: agentPath })]),
      );
      expect(projectState.repos).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "/repos/config" }),
          expect.objectContaining({ path: repoPath }),
        ]),
      );
      expect(projectState.secrets).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: secretPath })]),
      );
      expect(await project.secrets.list()).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: secretPath })]),
      );
      expect((await project.agents.list()).some((item) => item.path.startsWith("/agents/"))).toBe(
        true,
      );
      expect((await project.repos.list()).some((item) => item.path === "/repos/config")).toBe(true);
      expect((await project.repos.list()).some((item) => item.path.startsWith("/repos/"))).toBe(
        true,
      );
      // Birth now seeds one boot-context input item (platform context: project
      // id, agent path, repo layout) with dont-trigger-request — so history has
      // exactly that item and no LLM turn ran. Ingest is async: wait for the
      // processor to fold the birth events before asserting (cold slots under
      // CI load have been seen to lag).
      const agentProcessor = project.agents.get(agentPath).processor;
      await waitForCondition(
        async () => (await agentProcessor.snapshot()).state.history.length > 0,
        { description: "agent boot-context input to fold into history", timeoutMs: 30_000 },
      );
      expect((await agentProcessor.snapshot()).state.history).toEqual([
        expect.objectContaining({
          role: "user",
          content: expect.stringContaining(`Your agent stream path: ${agentPath}`),
        }),
      ]);
      expect((await project.repo.processor.snapshot()).state.created).toBe(true);
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
      await secret.update({
        egress: { urls: [echo.url] },
        material: "intercept-secret-material",
      });
      await waitForCondition(async () => (await secret.__describe()).hasMaterial, {
        description: "intercept proof secret to be available",
      });

      const secretReference = `Bearer getSecret({ path: "${secretPath}" })`;
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
      expect((await secret.__describe()).audit.usedCount).toBe(0);

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
});
