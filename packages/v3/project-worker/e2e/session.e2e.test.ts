// session.e2e.test.ts — the /api SESSION on the deployed worker: one row per door, its identity
// (src/principal.ts, session.ts, the DO's append root), and the ONE SessionTeardown every context it
// hands out shares. Pins:
//   • a project token, minted through the real door by a member (`projects.get(p).mintToken()`):
//     `whoami`, `source.principal` on every append — set by the DO, so a client's own is overwritten
//     (the admin session's becomes `{ actor: "admin" }`); the platform's own rows carry it too; the
//     token names ONE project (FORBIDDEN elsewhere); a bad token and a token past its ttl are
//     INVALID_CREDENTIALS
//   • the project secret authenticates over the wire: the key `rotateApiKey` minted opens a session
//     that IS the project (the rest of both doors is __workers-tests__/session-doors.test.ts)
//   • the built-in cd carries the principal to a SIBLING context
//   • one-shot HTTP batch at /api (a socketless CLI client), an inline-source worker, a fetch-shaped
//     target through the session as a dotted `.fetch(request)` behind a rewrite rule (the commissioned
//     fork feature carries the Response back)
//   • `/version` answers `<deployId> <environmentName>` — the deploy stamp a smoke polls
//   • two contexts of one session provide live fns under the SAME rpc-stub key and BOTH stay callable:
//     a key is unique only PER CONTEXT (each context DO has its own `itx.rpcStubs` registry and its own
//     rewrite-rule table), so the teardown keys by (context, rpcStubKey)

// eslint-disable-next-line iterate/no-capnweb-http-batch -- the /api one-shot batch door itself is under test; everything else is WS
import { newHttpBatchRpcSession } from "capnweb";
import { expect, test } from "vitest";
import {
  adminCredentials,
  codeOf,
  freshCtx,
  openItx,
  readAll,
  rejection,
  session,
  sleep,
  workerUrl,
} from "./support/client.ts";
import { mintProjectApiKey, mintProjectToken } from "./support/principal.ts";
import {
  freshDnsSafeProjectId,
  projectHostsAreLocal,
  registerProject,
} from "./support/project-host.ts";
import { SOURCES } from "./support/sources.ts";

/** A member of a fresh project: their `as` (the email; the directory's id for it is `user_<email>`)
 *  and the principal a token they mint carries. */
const memberOf = (projectId: string) => {
  const email = `${projectId}@example.com`;
  return { as: { email }, principal: { actor: `user_${email}`, email } };
};

// ── identity ──

test("a project token: whoami, source.principal on every append (unforgeable), the project bound, bad tokens refused", async () => {
  const projectId = freshDnsSafeProjectId("identity");
  const { as: ada, principal } = memberOf(projectId);
  await registerProject(projectId, ada); // her project, in her org: she mints her own token
  const token = await mintProjectToken(projectId, ada);
  const api = session();
  const authenticated = api.authenticate({ type: "project-token", token });
  expect(await authenticated.whoami()).toEqual({ projectId, ...principal });

  // every append the session makes carries the principal — the DO sets it, a client's own is overwritten
  const itx = authenticated.projects.get(projectId);
  await itx.append({ type: "note", payload: { n: 1 }, source: { principal: { actor: "forged" } } });
  await itx.provide("itx.demo", "itx.builtins.kv"); // the platform's own row, appended by the edge for this session
  // the admin session's client-supplied principal is overwritten with the admin's
  const admin = openItx(projectId);
  await admin.append({
    type: "note",
    payload: { n: 2 },
    source: { principal: { actor: "forged" } },
  });
  const events = await readAll(admin);
  const note1 = events.find((e) => e.type === "note" && e.payload?.n === 1);
  const rule = events.find((e) => e.type === "events.iterate.com/itx/rewrite-rule-configured");
  const note2 = events.find((e) => e.type === "note" && e.payload?.n === 2);
  expect(note1?.source?.principal).toEqual(principal);
  expect(rule?.source?.principal).toEqual(principal);
  expect(note2?.source?.principal).toEqual({ actor: "admin" });

  // the token names ONE project
  const other = await rejection(authenticated.projects.get(`${projectId}-other`).whoami());
  expect(codeOf(other), other.message).toBe("FORBIDDEN");
  // a bad token, and a token past its ttl (one second, minted through the door; a 2 s margin —
  // the mint's clock is the worker's): refused the same way
  const bad = await rejection(
    api.authenticate({ type: "project-token", token: `${token}x` }).whoami(),
  );
  expect(codeOf(bad), bad.message).toBe("INVALID_CREDENTIALS");
  const expiring = await mintProjectToken(projectId, ada, 1);
  await sleep(2000);
  expect(
    codeOf(await rejection(api.authenticate({ type: "project-token", token: expiring }).whoami())),
  ).toBe("INVALID_CREDENTIALS");
});

test("the project secret authenticates over the wire: the key rotateApiKey minted opens a session that IS the project", async () => {
  const projectId = freshDnsSafeProjectId("secret");
  const key = await mintProjectApiKey(projectId);
  expect(
    await session()
      .authenticate({ type: "project-secret", project: projectId, secret: key })
      .whoami(),
  ).toEqual({ projectId, actor: `project:${projectId}` });
});

test("the built-in cd carries the principal to a SIBLING context — an event appended through `itx.cd('/x').append(…)` is attributed like one appended at the root", async () => {
  const projectId = freshDnsSafeProjectId("cd-who");
  const { as: ada, principal } = memberOf(projectId);
  await registerProject(projectId, ada);
  const itx = session()
    .authenticate({ type: "project-token", token: await mintProjectToken(projectId, ada) })
    .projects.get(projectId);
  await itx.invoke("itx.cd('/sibling').append({ type: 'note', payload: { via: 'cd' } })");
  const note = (await readAll(itx.cd("/sibling"))).find((e) => e.type === "note");
  expect(note?.source?.principal).toEqual(principal);
});

// ── the doors ──

test("one-shot HTTP batch whoami at /api, an inline-source worker, and a dotted .fetch(request) through a rewrite rule", async () => {
  // The batch and the live session share ONE ctx (one project DO).
  const ctx = freshCtx("edge");

  // 1. ONE-SHOT HTTP BATCH: a CLI-shaped client — no WebSocket anywhere. Every call chained off the
  //    session flushes as a single POST to /api; the shape is the same `.authenticate(adminCredentials()).projects.get(ctx)`.
  // eslint-disable-next-line iterate/no-capnweb-http-batch -- the batch door is what this proves: a socketless CLI client works
  const batch: any = newHttpBatchRpcSession(workerUrl("/api"));
  const who = await batch
    .authenticate(adminCredentials())
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

test("/version answers `<deployId> <environmentName>` — the deploy stamp a smoke waits for", async () => {
  // The deploy id is Cloudflare's version id of the deploy (what `wrangler deploy` prints) — local
  // workerd mints one too — or "unversioned" where the binding is absent; then the configuration
  // (src/worker.ts `parseAppConfig`): the e2e lane names itself "e2e", a deployed worker names its environment.
  const versionRes = await fetch(workerUrl("/version"));
  expect(versionRes.status).toBe(200);
  const [deployId, environmentName, ...rest] = (await versionRes.text()).trim().split(" ");
  expect(rest).toEqual([]);
  expect(deployId).toMatch(/^(?:[0-9a-f-]{36}|unversioned)$/);
  if (projectHostsAreLocal()) expect(environmentName).toBe("e2e");
  else expect(environmentName).toMatch(/^[a-z][a-z0-9_-]*$/);
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
