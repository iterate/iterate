// Public OAuth admission, principal propagation and Cap’n Web resource teardown.
// The /api one-shot HTTP batch is itself under test here; everything else is WS.
import { newHttpBatchRpcSession, newWebSocketRpcSession } from "capnweb";
import { WebSocket as UndiciWebSocket } from "undici";
import { expect, test } from "vitest";
import { errorCode } from "iterate/lib";
import type { IterateRpcTarget } from "../src/session.ts";
import {
  adminCredentials,
  freshCtx,
  mcpCall,
  openItx,
  processorNames,
  readAll,
  rejection,
  session,
  sleep,
  untilValue,
  workerUrl,
} from "./support/client.ts";
import { oauthSession } from "./support/principal.ts";
import { publishConfigWorker } from "./support/config-worker.ts";
import {
  fetchProjectUrl,
  freshDnsSafeProjectSlug,
  projectUrl,
  projectUrlSocket,
  registerProject,
} from "./support/project-host.ts";
import { SOURCES } from "./support/sources.ts";

test("an OAuth grant: identity, unforgeable append attribution, project boundary and revocation", async () => {
  const slug = freshDnsSafeProjectSlug("identity");
  const member = { email: `${slug}@example.com` };
  const projectId = await registerProject(slug, member);
  const { api, token, principal } = await oauthSession(projectId, member);
  expect(principal).toMatchObject({ email: member.email });
  const itx = api.projects.get(projectId);
  await itx.append({ type: "note", payload: { n: 1 }, source: { principal: { actor: "forged" } } });
  await itx.provide("itx.demo", "itx.builtins.kv");
  const admin = openItx(projectId);
  await admin.append({
    type: "note",
    payload: { n: 2 },
    source: { principal: { actor: "forged" } },
  });
  const events = await readAll(admin);
  expect(events.find((e) => e.type === "note" && e.payload?.n === 1)?.source?.principal).toEqual(
    principal,
  );
  expect(
    events.find((e) => e.type === "events.iterate.com/itx/rewrite-rule-configured")?.source
      ?.principal,
  ).toEqual(principal);
  expect(events.find((e) => e.type === "note" && e.payload?.n === 2)?.source?.principal).toEqual({
    actor: "admin",
  });
  expect(errorCode(await rejection(api.projects.get(`${projectId}-other`).whoami()))).toBe(
    "FORBIDDEN",
  );
  const bad = await fetch(workerUrl("/api"), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}x` },
  });
  expect(bad).toMatchObject({ status: 401 });
  await bad.body?.cancel();
  await api.logout();
  const revoked = await fetch(workerUrl("/api"), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(revoked).toMatchObject({ status: 401 });
  await revoked.body?.cancel();
});

test("a socket opened BARE authenticates in-band — the token in the authenticate call — and is bound to that grant: a wrong token, a second token and a cookie-less cookie form are refused; the HTTP probe stays a 401", async () => {
  // THE STATIC-PAGE ARCHETYPE (apps/spa): a browser cannot put a header on a WebSocket, so the page
  // opens /api with no credential and presents its OAuth access token IN `authenticate` — capnweb's
  // own pattern. The same gate, the same session; nothing is reachable before the call resolves.
  const slug = freshDnsSafeProjectSlug("in-band");
  const member = { email: `${slug}@example.com` };
  const project = await registerProject(slug, member);
  const { token, principal, issuerHeaders } = await oauthSession(project, member);
  // THE BARE SOCKET: /api with no credential on the upgrade — what a browser can open.
  const url = new URL(workerUrl("/api"));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = new UndiciWebSocket(url);
  using bare = newWebSocketRpcSession<IterateRpcTarget>(socket as unknown as WebSocket);
  expect(errorCode(await rejection(bare.authenticate({ type: "from-server-cookie" })))).toBe(
    "UNAUTHENTICATED",
  );
  expect(
    errorCode(await rejection(bare.authenticate({ type: "bearer", token: `${token}x` }))),
  ).toBe("INVALID_CREDENTIALS");
  using api = bare.authenticate({ type: "bearer", token });
  const [whoami, projects] = await Promise.all([api.whoami(), api.projects.list()]); // pipelined
  expect(whoami).toEqual(principal);
  expect(projects.map((row) => row.id)).toContain(project);
  expect(await api.projects.get(project).whoami()).toMatchObject({ projectId: project });
  // one transport, one grant — a later token, and a token racing the first, are both refused
  await expect(bare.authenticate({ type: "bearer", token })).rejects.toThrow(
    /already carries a session/,
  );
  const racing = new UndiciWebSocket(url);
  using bareRacing = newWebSocketRpcSession<IterateRpcTarget>(racing as unknown as WebSocket);
  const outcomes = await Promise.allSettled([
    bareRacing.authenticate({ type: "bearer", token }).whoami(),
    bareRacing.authenticate({ type: "bearer", token }).whoami(),
  ]);
  expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["fulfilled", "rejected"]);
  // THE BROWSER'S ACTUAL SHAPE: the page that just did the OAuth dance also carries the platform's
  // own login cookie, from another origin. The cookie lends it nothing (CSRF); the socket opens bare
  // and the token still works in-band.
  const withCookie = new UndiciWebSocket(url, {
    headers: { ...issuerHeaders, Origin: "http://spa.example" },
  });
  using bareWithCookie = newWebSocketRpcSession<IterateRpcTarget>(
    withCookie as unknown as WebSocket,
  );
  expect(
    errorCode(await rejection(bareWithCookie.authenticate({ type: "from-server-cookie" }))),
  ).toBe("UNAUTHENTICATED");
  expect(await bareWithCookie.authenticate({ type: "bearer", token }).whoami()).toEqual(principal);
  // the HTTP form stays behind the gate: the console's sign-in probe reads this 401
  const probe = await fetch(workerUrl("/api"), { method: "POST", body: "" });
  expect(probe).toMatchObject({ status: 401 });
  await probe.body?.cancel();
});

test("revoking a grant closes its live public socket and held capability within one minute", async () => {
  const slug = freshDnsSafeProjectSlug("live-revoke");
  const member = { email: `${slug}@example.com` };
  const project = await registerProject(slug, member);
  const { api, token } = await oauthSession(project, member);
  const url = new URL(workerUrl("/api"));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = new UndiciWebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
  let onClose!: () => void;
  const closed = new Promise<void>((resolve) => {
    onClose = resolve;
  });
  socket.addEventListener("close", onClose, { once: true });
  using held = newWebSocketRpcSession<IterateRpcTarget>(socket as unknown as WebSocket);
  using itx = await held.authenticate({ type: "from-server-cookie" }).projects.get(project);
  expect(await itx.whoami()).toMatchObject({ projectId: project });
  await api.logout();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // The production lease is thirty seconds, with a sixty-second hard bound.
    await Promise.race([
      closed,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Revoked socket survived its 60-second lease")),
          60_000,
        );
      }),
    ]);
    await expect(itx.whoami()).rejects.toThrow();
  } finally {
    clearTimeout(timer);
    socket.removeEventListener("close", onClose);
    socket.close();
  }
}, 75_000);

test("projects.create({ project }) writes the catalog row on global:/ and opens a saga on /: the `project` processor row, `project/create-requested` under the caller, then the processor seeds /repos/config, publishes it and lands `project/created` — the catalog and the apex say so; the same slug again is the same project and one more request, a harmless fact after the certificate", async () => {
  const slug = freshDnsSafeProjectSlug("create-saga");
  const api = session().authenticate(adminCredentials());
  // returns once the control plane holds the slug (its catalog on `global:/`, which a client
  // cannot read) and the project's own saga is open on / under the caller; the certificate is that
  // processor's to land
  using itx = await api.projects.create({ project: slug });
  const { projectId, projectSlug } = await itx.whoami();
  expect(projectSlug).toBe(slug);
  const projectFacts = async () =>
    (await readAll(itx)).filter(
      (e) =>
        e.type.startsWith("events.iterate.com/project/") ||
        e.type === "events.iterate.com/itx/ingress-configured",
    );
  // the saga SETTLES on `created` or `create-failed`: a failed birth fails here with its own fact,
  // and a wait that runs out names the facts it had (which step the saga was on)
  const settled = await untilValue("project/created on /", projectFacts, (facts) =>
    facts.some((e) => /\/project\/create(d|-failed)$/.test(e.type)),
  );
  const created = settled.find((e) => e.type === "events.iterate.com/project/created");
  if (!created)
    throw new Error(`the project's birth failed on /: ${JSON.stringify(settled.at(-1))}`);
  const [requested, ...rest] = await projectFacts();
  // the saga's own facts on /: the request, the apex pointed at the seeded commit, the certificate
  expect([requested, ...rest].map((e) => e.type)).toEqual([
    "events.iterate.com/project/create-requested",
    "events.iterate.com/itx/ingress-configured",
    "events.iterate.com/project/created",
  ]);
  // the request's facts, as the edge spelled them: the slug, and the organization it landed in —
  // the deployment's own for the admin secret
  expect(requested).toMatchObject({ payload: { slug, orgId: "org_admin" } });
  // appended by the edge UNDER THE ASKER (the request's own stamp), not the platform's
  expect(requested.source?.principal).toEqual({ actor: "admin" });
  // oxlint-disable-next-line iterate/prefer-object-property-match -- exact: the created fact carries nothing but its existence
  expect(created.payload).toEqual({}); // existence only
  expect(await processorNames(itx)).toContain("project");
  // the seed: the config repo in the catalog (its certificate crossed to /), its files on main
  expect((await itx.repos.list()).map((r: { path: string }) => r.path)).toEqual(["/repos/config"]);
  expect(await itx.repos.get("/repos/config").listFiles()).toMatchObject({
    paths: ["AGENTS.md", "package.json", "tsconfig.json", "worker.ts"],
  });
  // published: the apex answers the seeded homepage worker (subdomain routing under the test's base)
  expect((await fetchProjectUrl(projectUrl({ project: slug, path: "/" }))).text.trim()).toBe(
    `Homepage of project ${slug}`,
  );
  // the facet reduces its own certificate: the state the dash renders
  expect(await itx.facets.get("project").liveSnapshot()).toMatchObject({
    state: { creation: { status: "created", offset: created.offset } },
  });
  // the same slug again: the catalog answers the SAME project (the same organization's same
  // slug), and every answer owes / a request — after the certificate a harmless fact the saga
  // ignores (after a failure it would be a new attempt), so exactly one event lands and the
  // creation stays the one that landed (the wake record and the alarm trace are the platform's
  // own, not the create's, so they are left out)
  const rows = async () =>
    (await readAll(itx))
      .filter((e) => !/\/itx\/(woken|alarm-trace)$/.test(e.type))
      .map((e) => ({ offset: e.offset, type: e.type }));
  const before = await rows();
  using again = await api.projects.create({ project: slug });
  expect(await again.whoami()).toMatchObject({ projectId });
  const after = await rows();
  expect(after.slice(0, before.length)).toEqual(before);
  expect(after.slice(before.length).map((row) => row.type)).toEqual([
    "events.iterate.com/project/create-requested",
  ]);
  expect(await itx.facets.get("project").liveSnapshot()).toMatchObject({
    state: { creation: { status: "created", offset: created.offset } },
  });
});

test("the built-in cd carries the OAuth principal to a sibling context", async () => {
  const slug = freshDnsSafeProjectSlug("cd-who");
  const member = { email: `${slug}@example.com` };
  const projectId = await registerProject(slug, member);
  const { api, principal } = await oauthSession(projectId, member);
  const itx = api.projects.get(projectId);
  await itx.invoke("itx.cd('/sibling').append({ type: 'note', payload: { via: 'cd' } })");
  const note = (await readAll(itx.cd("/sibling"))).find((e) => e.type === "note");
  expect(note?.source?.principal).toEqual(principal);
});

/** An app that echoes who the platform says is asking — the stamped principal — and whether the
 *  bearer it was presented with reached it (it must not: the platform's credential is stripped);
 *  on a WebSocket upgrade, it echoes each message. */
const SRC_ECHO_APP = {
  "worker.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class Echo extends WorkerEntrypoint {
  fetch(request) {
    if ((request.headers.get("upgrade") || "").toLowerCase() === "websocket") {
      const pair = new WebSocketPair();
      pair[1].accept();
      pair[1].addEventListener("message", (event) => pair[1].send("echo:" + event.data));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return Response.json({
      principal: JSON.parse(request.headers.get("x-itx-principal") || "null"),
      authorization: request.headers.get("authorization"),
    });
  }
}`,
};

test(
  "a personal access token — the person's own API key — is their one bearer at /api, at /mcp (a handshake and a tool call) and on a covered project's host; an uncovered project is refused at /api and /mcp, and on its host the request arrives anonymous; revoked, it is refused at once at all three, and its live /api socket and project-host WebSocket close",
  { timeout: 75_000 },
  async () => {
    const slug = freshDnsSafeProjectSlug("personal");
    const otherSlug = freshDnsSafeProjectSlug("personal-other");
    const member = { email: `${slug}@example.com` };
    const projectId = await registerProject(slug, member);
    const other = await registerProject(otherSlug, member); // the same org: the USER reaches it, the key will not
    for (const id of [projectId, other])
      await publishConfigWorker(openItx(id), ["itx", "workers", ["get", { source: SRC_ECHO_APP }]]);
    const { issuerHeaders, principal } = await oauthSession(projectId, member);
    // The account's own session (the login cookie) is what the sessions page speaks; a batch session
    // is one-shot, so each account call below opens its own.
    const accountSession = () =>
      // oxlint-disable-next-line iterate/no-capnweb-http-batch -- One bounded account call on the login cookie, as the sessions page makes it.
      newHttpBatchRpcSession<IterateRpcTarget>(
        new Request(workerUrl("/api"), { headers: issuerHeaders }),
      );
    using minter = accountSession();
    const { id, token, expiresAt } = await minter
      .authenticate({ type: "from-server-cookie" })
      .grants.mint({ name: "E2E personal access token", projects: [projectId] });
    expect(id).toMatch(/^pat_[0-9a-f]{16}$/);
    expect(token).toMatch(/^itk_[0-9a-f]{32}_[0-9a-f]{16}_[0-9A-Za-z]{49}$/);
    expect(expiresAt).toBeNull(); // none asked for: it ends when it is revoked

    // A LIVE SOCKET on the key, opened first: its 30 s re-check (src/rpc.ts) must close it after the
    // revocation below
    const url = new URL(workerUrl("/api"));
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new UndiciWebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
    const closed = new Promise<void>((resolve) =>
      socket.addEventListener("close", () => resolve(), { once: true }),
    );
    using held = newWebSocketRpcSession<IterateRpcTarget>(socket as unknown as WebSocket);
    const api = held.authenticate({ type: "from-server-cookie" });

    // /api: the bearer IS the person, within the key's projects
    expect(await api.whoami()).toEqual(principal);
    expect((await api.projects.list()).map((project) => project.id)).toEqual([projectId]);
    expect(errorCode(await rejection(api.projects.get(other).whoami()))).toBe("FORBIDDEN");
    using heldProject = await api.projects.get(projectId);
    expect(await heldProject.whoami()).toMatchObject({ projectId });

    // /mcp: the same key, through an MCP client's handshake and the one tool
    const initialized = await mcpCall(
      "initialize",
      {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "personal-access-token-e2e", version: "1.0.0" },
      },
      token,
    );
    expect(initialized.instructions).toContain(`This token reaches one project, ${slug}`);
    const ran = await mcpCall(
      "tools/call",
      { name: "run", arguments: { script: "async (itx) => itx.whoami()" } },
      token,
    );
    expect(JSON.stringify(ran)).toContain(projectId); // itx.whoami() names the project the key reaches
    const outside = await mcpCall(
      "tools/call",
      { name: "run", arguments: { project: other, script: "async (itx) => itx.whoami()" } },
      token,
    );
    expect(outside).toMatchObject({ isError: true });

    // a project host: the covered project's app sees the stamped principal and no bearer; a project
    // the key does not cover is refused before any Durable Object is dialled
    const echoOf = (project: string) => projectUrl({ project, routingSlug: "echo", path: "/" });
    const bearer = { Authorization: `Bearer ${token}` };
    const covered = await fetchProjectUrl(echoOf(slug), bearer);
    expect(covered, covered.text).toMatchObject({ status: 200 });
    expect(JSON.parse(covered.text)).toEqual({ principal, authorization: null });
    expect(
      await fetchProjectUrl(echoOf(slug), { Authorization: "Bearer itk_forged" }),
    ).toMatchObject({ status: 401 });
    // a project the key does not cover: the request arrives anonymous, the key stamped on nothing
    const uncovered = await fetchProjectUrl(echoOf(otherSlug), bearer);
    expect(uncovered, uncovered.text).toMatchObject({ status: 200 });
    expect(JSON.parse(uncovered.text)).toEqual({ principal: null, authorization: null });
    // a WebSocket the key holds open on the project's host: the edge relays it on the key's lease
    // (src/project-host-lease.ts)
    const hostSocket = projectUrlSocket(echoOf(slug), bearer);
    const hostClosed = new Promise<{ code: number; reason: string }>((resolve) =>
      hostSocket.addEventListener("close", ({ code, reason }) => resolve({ code, reason }), {
        once: true,
      }),
    );
    await new Promise((resolve, reject) => {
      hostSocket.addEventListener("open", resolve, { once: true });
      hostSocket.addEventListener("error", reject, { once: true });
    });
    const echoed = new Promise<string>((resolve) =>
      hostSocket.addEventListener("message", (event) => resolve(String(event.data)), {
        once: true,
      }),
    );
    hostSocket.send("ping");
    expect(await echoed).toBe("echo:ping");

    // the account lists it as what it is, with its projects, never its bearer
    using lister = accountSession();
    const listed = await lister.authenticate({ type: "from-server-cookie" }).grants.list();
    expect(listed.items.find((item) => item.id === id)).toMatchObject({
      name: "E2E personal access token",
      kind: "personal",
      projects: [projectId],
      expiresAt: null,
    });
    expect(JSON.stringify(listed)).not.toContain(token);
    // MCP ran on the project root, with the person and the key stamped on the request (the call on
    // the uncovered project was refused before any root)
    const runPair = (await readAll(openItx(projectId))).filter((e) =>
      e.type.startsWith("events.iterate.com/itx/run-"),
    );
    expect(runPair.map((e) => e.type)).toEqual([
      "events.iterate.com/itx/run-requested",
      "events.iterate.com/itx/run-settled",
    ]);
    expect(runPair[0]).toMatchObject({ source: { principal, grant: id } });
    // THE ACCOUNT'S RECORD: the key's SHA-256, never the key, landed before the mint answered;
    // stamped with the CONNECTION that minted it (the login's grant, the provider's 16 characters)
    // and as the platform's own fact, the only kind the account folds
    const accountEvents = async () => {
      using reader = accountSession();
      return (await reader.authenticate({ type: "from-server-cookie" }).user.readEvents(0, 500))
        .events as { type: string; payload: Record<string, unknown>; source?: unknown }[];
    };
    const events = await accountEvents();
    const minted = events.find(
      (e) => e.type === "events.iterate.com/account/personal-access-token-minted",
    );
    expect(minted).toMatchObject({
      payload: {
        id,
        name: "E2E personal access token",
        hash: expect.stringMatching(/^[0-9a-f]{64}$/),
        email: member.email,
        projects: [projectId],
        expiresAt: null,
        mintedBy: expect.stringMatching(/^[A-Za-z0-9_-]{16}$/),
      },
      source: {
        principal,
        grant: expect.stringMatching(/^[A-Za-z0-9_-]{16}$/),
        platform: true,
      },
    });
    // the session that minted it, by the grant its fact is stamped with
    expect(minted!.payload).toMatchObject({
      mintedBy: (minted!.source as { grant: string }).grant,
    });
    expect(JSON.stringify(events)).not.toContain(token);

    // REVOKED: `grants.end` answers once `account/grant-ended` has landed on the person's account, so
    // every entry refuses the key at once …
    using ender = accountSession();
    await ender.authenticate({ type: "from-server-cookie" }).grants.end(id);
    const endedApi = await fetch(workerUrl("/api"), { method: "POST", headers: bearer });
    expect(endedApi).toMatchObject({ status: 401 });
    await endedApi.body?.cancel();
    await expect(mcpCall("tools/list", {}, token)).rejects.toThrow("answered 401");
    expect(await fetchProjectUrl(echoOf(slug), bearer)).toMatchObject({ status: 401 });
    // … and the sockets it opened close at their next re-check: the /api socket, taking its
    // capability with it, and the project host's WebSocket, closed by the edge with 1008. The
    // platform can drop the host socket's connection to the app before that re-check (about 1 in
    // 90 sockets over their 30 s on previews, measured 2026-09-25); the edge then closes it 1011
    // (project-host-lease.ts) and the lease has nothing left to close. The lease's own 1008 on a
    // relayed socket is pinned without a platform in __workers-tests__/personal-access-tokens.test.ts.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const [, hostClose] = await Promise.race([
        Promise.all([closed, hostClosed]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("The revoked key's sockets survived their 60-second lease")),
            60_000,
          );
        }),
      ]);
      expect([1008, 1011], `the host socket's close: ${JSON.stringify(hostClose)}`).toContain(
        hostClose.code,
      );
    } finally {
      clearTimeout(timer);
      hostSocket.close();
    }
    await expect(heldProject.whoami()).rejects.toThrow();
  },
);

test("the operator bearer is /api's machine credential: refused at /mcp and on a project's host", async () => {
  const { secret } = adminCredentials();
  const bearer = { Authorization: `Bearer ${secret}` };
  // a project's host: its app would see an operator over every project
  const slug = freshDnsSafeProjectSlug("operator-host");
  await registerProject(slug);
  expect(await fetchProjectUrl(projectUrl({ project: slug, path: "/" }), bearer)).toMatchObject({
    status: 401,
  });
  // oxlint-disable-next-line iterate/no-capnweb-http-batch -- One bounded whoami with the bearer on the request, as the e2e harness and deploy gates use /api.
  using batch = newHttpBatchRpcSession<IterateRpcTarget>(
    new Request(workerUrl("/api"), { headers: bearer }),
  );
  expect(await batch.authenticate({ type: "from-server-cookie" }).whoami()).toEqual({
    actor: "admin",
  });
  await expect(mcpCall("tools/list", {}, secret)).rejects.toThrow("answered 401");
});

// ── the entry points ──

test("one-shot HTTP batch whoami at /api, an inline-source worker, and a dotted .fetch(request) through a rewrite rule", async () => {
  // The batch and the live session share ONE ctx (one project DO).
  const slug = freshDnsSafeProjectSlug("edge");
  const member = { email: `${slug}@example.com` };
  const ctx = await registerProject(slug, member);
  const { token } = await oauthSession(ctx, member);

  // oxlint-disable-next-line iterate/no-capnweb-http-batch -- A public bearer also admits a bounded socketless batch.
  using batch = newHttpBatchRpcSession<IterateRpcTarget>(
    new Request(workerUrl("/api"), {
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
  const who: any = await batch
    .authenticate({ type: "from-server-cookie" })
    .projects.get(ctx)
    .invoke(["itx", ["whoami"]]);
  // one-shot HTTP batch: whoami without a socket
  expect(who?.projectId).toBe(ctx);

  // live session for the rest
  const itx = openItx(ctx);

  // 2. THE SOURCE IS THE MODULES, handed over INLINE: hand the code over, run it
  const SRC_MINE = {
    "worker.js": `import { WorkerEntrypoint } from "cloudflare:workers";
import { withItx } from "iterate/sdk";
export default class Mine extends WorkerEntrypoint {
  async run() {
    const { projectId } = await withItx(this.env.ITX, (itx) => itx.whoami());
    return \`from-inline:\${projectId}\`;
  }
}`,
  };
  const out = await itx.invoke(["itx", "workers", ["get", { source: SRC_MINE }], ["run"]]);
  // an inline source runs as a worker (itx round-trip inside)
  expect(out).toBe(`from-inline:${ctx}`);

  // 3. a fetch-shaped target through the SESSION (no HTTP request): the terminal
  //    `.fetch(request)` rides the DO's fetch channel with the expression in x-itx-expression — one
  //    routing fork, no verb; `itx.site` is an ordinary rewrite rule onto the loaded entrypoint
  await itx.provide("itx.site", ["itx", "workers", ["get", { source: SOURCES.site }]]);
  const resp = await itx.site.fetch(new Request("https://itx.site/"));
  const html = await resp.text();
  // the Response rides back over capnweb
  expect(resp).toMatchObject({ status: 200 });
  expect(html).toContain("dynamic web capability");
});

test("/version answers `<deployId> <platformOrigin>` — the deploy stamp a smoke waits for", async () => {
  // The deploy id is Cloudflare's version id of the deploy (what `wrangler deploy` prints) — local
  // workerd mints one too — or "unversioned" where the binding is absent; then the platform origin:
  // the issuer (src/app-config.ts `urls.os`, or the request's own origin where a deployment leaves
  // it blank) — the one thing that names a deployment, local or deployed.
  const versionRes = await fetch(workerUrl("/version"));
  expect(versionRes).toMatchObject({ status: 200 });
  const [deployId, platformOrigin, ...rest] = (await versionRes.text()).trim().split(" ");
  expect(rest).toEqual([]);
  expect(deployId).toMatch(/^(?:[0-9a-f-]{36}|unversioned)$/);
  expect(platformOrigin).toBe(new URL(workerUrl("/")).origin);
});

// ── THE CROSS-CONTEXT LEND PIN — the reviewer's exact probe: root provides a live fn under `itx.clash`,
// '/sub' provides a DIFFERENT live fn under the SAME key, and BOTH stay callable — including after a
// settle delay, because a recall is ASYNC (dispose → pager close → the DO's socket-close handler lands
// moments later; an immediate-only assertion could pass before a wrongly recalled transport drops) ──

test("TWO CONTEXTS of one session provide live fns under the SAME rpc-stub key — both stay callable", async () => {
  const ctx = freshCtx("ctxclash");
  const s = session();
  const a = s.authenticate(adminCredentials()).projects.get(ctx); // the root context ("/")
  const b = a.cd("/sub"); // another context of the project — SAME session, so the SAME SessionTeardown

  await a.provide("itx.clash", (x: number) => x + 1);
  await b.provide("itx.clash", (x: number) => x + 100);

  // Both callable right away (each resolves through its OWN context's rule and registry) …
  expect(await a.invoke("itx.clash(1)")).toBe(2);
  expect(await b.invoke("itx.clash(1)")).toBe(101);

  // … and STILL callable after the settle: a teardown keyed by the key alone would have recalled a's
  // stub on b's provide, and the resulting pager close drops a stub from its DO's registry
  // asynchronously — a's rule would still be there, answering RPC_STUB_OFFLINE.
  await sleep(2000);
  expect(await a.invoke("itx.clash(1)")).toBe(2); // root's provider survived '/sub''s provide
  expect(await b.invoke("itx.clash(1)")).toBe(101); // and vice versa
});
