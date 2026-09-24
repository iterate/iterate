// Public OAuth admission, principal propagation and Cap’n Web resource teardown.
// eslint-disable-next-line iterate/no-capnweb-http-batch -- the /api one-shot batch door itself is under test; everything else is WS
import { newHttpBatchRpcSession, newWebSocketRpcSession } from "capnweb";
import { WebSocket as UndiciWebSocket } from "undici";
import { expect, test } from "vitest";
import type { IterateRpcTarget } from "../src/session.ts";
import { errorCode } from "iterate/next/lib";
import { adminCredentials, freshCtx, mcpCall, publicSession, openItx, processorNames, readAll, rejection, session, sleep, until, workerUrl } from "./support/client.ts";
import { oauthSession } from "./support/principal.ts";
import {
  fetchProjectUrl,
  freshDnsSafeProjectSlug,
  projectUrl,
  registerProject,
} from "./support/project-host.ts";
import { SOURCES } from "./support/sources.ts";

test("an OAuth grant: identity, unforgeable append attribution, project boundary and revocation", async () => {
  const slug = freshDnsSafeProjectSlug("identity");
  const member = { email: `${slug}@example.com` };
  const projectId = await registerProject(slug, member);
  const { api, token, principal } = await oauthSession(projectId, member);
  expect(principal.email).toBe(member.email);
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
  expect(bad.status).toBe(401);
  await bad.body?.cancel();
  await api.logout();
  const revoked = await fetch(workerUrl("/api"), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(revoked.status).toBe(401);
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
  expect(errorCode(await rejection(bare.authenticate({ type: "bearer", token: `${token}x` })))).toBe(
    "INVALID_CREDENTIALS",
  );
  using api = bare.authenticate({ type: "bearer", token });
  const [whoami, projects] = await Promise.all([api.whoami(), api.projects.list()]); // pipelined
  expect(whoami).toEqual(principal);
  expect(projects.map((row) => row.id)).toContain(project);
  expect((await api.projects.get(project).whoami()).projectId).toBe(project);
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
  // own login cookie, from another origin. The cookie lends it nothing (CSRF — iterate/next/app-server
  // used to answer 403 here); the socket opens bare and the token still works in-band.
  const withCookie = new UndiciWebSocket(url, {
    headers: { ...issuerHeaders, Origin: "http://spa.example" },
  });
  using bareWithCookie = newWebSocketRpcSession<IterateRpcTarget>(
    withCookie as unknown as WebSocket,
  );
  expect(errorCode(await rejection(bareWithCookie.authenticate({ type: "from-server-cookie" })))).toBe(
    "UNAUTHENTICATED",
  );
  expect(await bareWithCookie.authenticate({ type: "bearer", token }).whoami()).toEqual(principal);
  // the HTTP form stays behind the gate: the console's sign-in probe reads this 401
  const probe = await fetch(workerUrl("/api"), { method: "POST", body: "" });
  expect(probe.status).toBe(401);
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
  expect((await itx.whoami()).projectId).toBe(project);
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
    (await readAll(itx)).filter((e) => e.type.startsWith("events.iterate.com/project/"));
  const created = await until("project/created on /", async () =>
    (await projectFacts()).find((e) => e.type === "events.iterate.com/project/created"),
  );
  const [requested, ...rest] = await projectFacts();
  // the saga's own facts on /: the request, the apex pointed at the seeded commit, the certificate
  expect([requested, ...rest].map((e) => e.type)).toEqual([
    "events.iterate.com/project/create-requested",
    "events.iterate.com/project/ingress-configured",
    "events.iterate.com/project/created",
  ]);
  // the request's facts, as the edge spelled them: the slug, and the organization it landed in —
  // the deployment's own for the admin secret
  expect(requested.payload).toEqual({ slug, orgId: "org_admin" });
  // appended by the edge UNDER THE ASKER (the request's own stamp), not the platform's
  expect(requested.source?.principal).toEqual({ actor: "admin" });
  expect(created.payload).toEqual({}); // existence only
  expect(await processorNames(itx)).toContain("project");
  // the seed: the config repo in the catalog (its certificate crossed to /), its two files on main
  expect((await itx.repos.list()).map((r: { path: string }) => r.path)).toEqual(["/repos/config"]);
  expect((await itx.repos.get("/repos/config").listFiles()).paths).toEqual([
    "AGENTS.md",
    "worker.ts",
  ]);
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
      .filter((e) => !/\/stream\/(woken|trace\/)/.test(e.type))
      .map((e) => ({ offset: e.offset, type: e.type }));
  const before = await rows();
  using again = await api.projects.create({ project: slug });
  expect((await again.whoami()).projectId).toBe(projectId);
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
 *  bearer it was presented with reached it (it must not: the platform's credential is stripped). */
const SRC_ECHO_APP = {
  "cap.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class Echo extends WorkerEntrypoint {
  fetch(request) {
    return Response.json({
      principal: JSON.parse(request.headers.get("x-itx-principal") || "null"),
      authorization: request.headers.get("authorization"),
    });
  }
}`,
};

test("a personal access token — one OAuth grant the account mints — is the user's bearer on /api, /mcp and a covered project host; an uncovered project is FORBIDDEN; grants.end refuses it on /api, /mcp and the project host", async () => {
  const slug = freshDnsSafeProjectSlug("personal");
  const otherSlug = freshDnsSafeProjectSlug("personal-other");
  const member = { email: `${slug}@example.com` };
  const projectId = await registerProject(slug, member);
  const other = await registerProject(otherSlug, member); // the same org: the USER reaches it, the token will not
  await openItx(projectId).provide("itx.apps.echo", [
    "itx",
    "workers",
    ["get", { source: SRC_ECHO_APP }],
  ]);
  const { issuerHeaders, principal } = await oauthSession(projectId, member);
  // The account's own session (the login cookie) is what the sessions page speaks; a batch session
  // is one-shot, so each account call below opens its own.
  const accountRequest = () => new Request(workerUrl("/api"), { headers: issuerHeaders });
  // eslint-disable-next-line iterate/no-capnweb-http-batch -- A bounded mint through the account capability, the console's own client.
  using minter = newHttpBatchRpcSession<IterateRpcTarget>(accountRequest());
  const { token, expiresAt } = await minter
    .authenticate({ type: "from-server-cookie" })
    .grants.mint({ name: "E2E personal access token", projects: [projectId] });
  expect(expiresAt).toBeGreaterThan(Date.now());

  // /api: the bearer IS the user, with the token's project ceiling
  const api = publicSession(token);
  expect(await api.whoami()).toEqual(principal);
  expect((await api.projects.list()).map((project) => project.id)).toEqual([projectId]);
  expect(errorCode(await rejection(api.projects.get(other).whoami()))).toBe("FORBIDDEN");

  // /mcp: the one tool is `run`; this token reaches exactly one project, so `run(script)` omits it
  const ran = await mcpCall(
    "tools/call",
    { name: "run", arguments: { script: "async (itx) => itx.whoami()" } },
    token,
  );
  expect(JSON.stringify(ran)).toContain(projectId); // itx.whoami() names the project the token reaches

  // a project host: the covered project's app sees the stamped principal and no bearer; a project
  // the token does not cover is refused before any Durable Object is dialled
  const echoOf = (project: string) => projectUrl({ project, app: "echo", path: "/" });
  const bearer = { Authorization: `Bearer ${token}` };
  const covered = await fetchProjectUrl(echoOf(slug), bearer);
  expect(covered.status, covered.text).toBe(200);
  expect(JSON.parse(covered.text)).toEqual({ principal, authorization: null });
  expect((await fetchProjectUrl(echoOf(otherSlug), bearer)).status).toBe(403);

  // the account lists it as what it is …
  // eslint-disable-next-line iterate/no-capnweb-http-batch -- One bounded inventory read on the account session.
  using lister = newHttpBatchRpcSession<IterateRpcTarget>(accountRequest());
  const listed = await lister.authenticate({ type: "from-server-cookie" }).grants.list();
  const grant = listed.items.find((item) => item.name === "E2E personal access token");
  expect(grant?.kind).toBe("Personal access token");
  // the provider keeps its deadline in seconds; the list shows that, the mint the millisecond one
  expect(Math.abs((grant?.expiresAt ?? 0) - expiresAt)).toBeLessThan(2000);
  // MCP runs on the project root, with the user and grant stamped on the request.
  const runPair = (await readAll(api.projects.get(projectId))).filter((e) =>
    e.type.startsWith("events.iterate.com/context/run-"),
  );
  expect(runPair.map((e) => e.type)).toEqual([
    "events.iterate.com/context/run-requested",
    "events.iterate.com/context/run-settled",
  ]);
  expect(runPair[0].source).toEqual({ principal, grant: grant!.id });
  expect(runPair[1].payload).toEqual({
    requestOffset: runPair[0].offset,
    settlement: {
      status: "succeeded",
      result: expect.objectContaining({ projectId, path: "/" }), // whoami: the slug and url ride along
    },
  });
  // THE ACCOUNT'S RECORD: the mint is a fact on the person's own context, stamped with them and
  // the issuer session it was minted through (best-effort and async: wait for it)
  const accountEvents = async () => {
    // eslint-disable-next-line iterate/no-capnweb-http-batch -- One bounded read of the account context per attempt.
    using reader = newHttpBatchRpcSession<IterateRpcTarget>(accountRequest());
    return (await reader.authenticate({ type: "from-server-cookie" }).user.readEvents(0, 500))
      .events as { type: string; payload: Record<string, unknown>; source?: unknown }[];
  };
  const minted = await until("the mint is on the account context", async () =>
    (await accountEvents()).find(
      (e) =>
        e.type === "events.iterate.com/account/grant-minted" && e.payload.grantId === grant!.id,
    ),
  );
  expect(minted.payload).toEqual({
    grantId: grant!.id,
    name: "E2E personal access token",
    projects: [projectId],
    expiresAt,
  });
  // stamped with the CONNECTION that minted it — the browser session's grant, the provider's 16
  // characters — and as the platform's own fact, the only kind the account folds
  expect(minted.source).toEqual({
    principal,
    grant: expect.stringMatching(/^[A-Za-z0-9_-]{16}$/),
    platform: true,
  });
  // … and ends it: the same bearer is refused on /api, /mcp and the project host at once
  // eslint-disable-next-line iterate/no-capnweb-http-batch -- One bounded revocation on the account session.
  using ender = newHttpBatchRpcSession<IterateRpcTarget>(accountRequest());
  // `grants.end` answers once `account/grant-ended` has landed on the person's account — nothing to
  // clean up later, so nothing to return
  await ender.authenticate({ type: "from-server-cookie" }).grants.end(grant!.id);
  const endedApi = await fetch(workerUrl("/api"), { method: "POST", headers: bearer });
  expect(endedApi.status).toBe(401);
  await endedApi.body?.cancel();
  await expect(mcpCall("tools/list", {}, token)).rejects.toThrow("answered 401");
  expect((await fetchProjectUrl(echoOf(slug), bearer)).status).toBe(401);
  // … and the end is the account's fact too
  const ended = await until("the end is on the account context", async () =>
    (await accountEvents()).find(
      (e) => e.type === "events.iterate.com/account/grant-ended" && e.payload.grantId === grant!.id,
    ),
  );
  expect(ended.source).toEqual({
    principal,
    grant: expect.stringMatching(/^[A-Za-z0-9_-]{16}$/),
    platform: true,
  });
});

// ── the doors ──

test("one-shot HTTP batch whoami at /api, an inline-source worker, and a dotted .fetch(request) through a rewrite rule", async () => {
  // The batch and the live session share ONE ctx (one project DO).
  const slug = freshDnsSafeProjectSlug("edge");
  const member = { email: `${slug}@example.com` };
  const ctx = await registerProject(slug, member);
  const { token } = await oauthSession(ctx, member);

  // eslint-disable-next-line iterate/no-capnweb-http-batch -- A public bearer also admits a bounded socketless batch.
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
    "cap.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class Mine extends WorkerEntrypoint {
  async run() {
    const itx = await this.env.ITX.get();
    return \`from-inline:\${(await itx.whoami()).projectId}\`;
  }
}`,
  };
  const out = await itx.invoke(["itx", "workers", ["get", { source: SRC_MINE }], ["run"]]);
  // an inline source runs as a worker (itx round-trip inside)
  expect(out).toBe(`from-inline:${ctx}`);

  // 3. a fetch-shaped target through the SESSION (no HTTP door): the terminal
  //    `.fetch(request)` rides the DO's fetch channel with the expression in x-itx-expression — one
  //    routing fork, no verb; `itx.site` is an ordinary rewrite rule onto the loaded entrypoint
  await itx.provide("itx.site", ["itx", "workers", ["get", { source: SOURCES.site }]]);
  const resp = await itx.site.fetch(new Request("https://itx.site/"));
  const html = await resp.text();
  // the Response rides back over capnweb
  expect(resp.status).toBe(200);
  expect(html).toContain("dynamic web capability");
});

test("/version answers `<deployId> <platformOrigin>` — the deploy stamp a smoke waits for", async () => {
  // The deploy id is Cloudflare's version id of the deploy (what `wrangler deploy` prints) — local
  // workerd mints one too — or "unversioned" where the binding is absent; then the platform origin:
  // the issuer (src/app-config.ts `urls.os`, or the request's own origin where a deployment leaves
  // it blank) — the one thing that names a deployment, local or deployed.
  const versionRes = await fetch(workerUrl("/version"));
  expect(versionRes.status).toBe(200);
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
