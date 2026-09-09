// session.e2e.test.ts — the /api SESSION: its identity (src/principal.ts, session.ts, the DO's append
// root), its doors, and the ONE SessionTeardown every context it hands out shares. Pins:
//   • a project token: `whoami`, `source.principal` on every append — set by the DO, so a client's own
//     is overwritten and an anonymous session's is stripped; the platform's own rows carry it too
//   • the token names ONE project (FORBIDDEN elsewhere); a bad or expired token is INVALID_CREDENTIALS;
//     no token is the anonymous session intra-project code holds
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
  codeOf,
  freshCtx,
  openItx,
  readAll,
  rejection,
  session,
  sleep,
  workerUrl,
} from "./support/client.ts";
import { mintProjectToken } from "./support/principal.ts";
import { projectHostsAreLocal } from "./support/project-host.ts";
import { SOURCES } from "./support/sources.ts";

// ── identity ──

test("a project token: whoami, source.principal on every append (unforgeable), the project bound, bad tokens refused", async () => {
  const projectId = freshCtx("identity");
  const principal = { actor: "user_ada", email: "ada@example.com" };
  const token = await mintProjectToken({ projectId, ...principal });
  const api = session();
  const authenticated = api.authenticate({ projectToken: token });
  expect(await authenticated.whoami()).toEqual({ projectId, ...principal });

  // every append the session makes carries the principal — the DO sets it, a client's own is overwritten
  const itx = authenticated.projects.get(projectId);
  await itx.append({ type: "note", payload: { n: 1 }, source: { principal: { actor: "forged" } } });
  await itx.provide("itx.demo", "itx.builtins.kv"); // the platform's own row, appended by the edge for this session
  // an anonymous session's client-supplied principal is stripped
  const anonymous = openItx(projectId);
  await anonymous.append({
    type: "note",
    payload: { n: 2 },
    source: { principal: { actor: "forged" } },
  });
  const events = await readAll(anonymous);
  const note1 = events.find((e) => e.type === "note" && e.payload?.n === 1);
  const rule = events.find((e) => e.type === "events.iterate.com/itx/rewrite-rule-configured");
  const note2 = events.find((e) => e.type === "note" && e.payload?.n === 2);
  expect(note1?.source?.principal).toEqual(principal);
  expect(rule?.source?.principal).toEqual(principal);
  expect(note2?.source?.principal).toBeUndefined();

  // the token names ONE project
  const other = await rejection(authenticated.projects.get(`${projectId}-other`).whoami());
  expect(codeOf(other), other.message).toBe("FORBIDDEN");
  // a bad token, an expired token: refused the same way
  const bad = await rejection(api.authenticate({ projectToken: `${token}x` }).whoami());
  expect(codeOf(bad), bad.message).toBe("INVALID_CREDENTIALS");
  const expired = await mintProjectToken({ projectId, ...principal, expiresAt: Date.now() - 1 });
  expect(codeOf(await rejection(api.authenticate({ projectToken: expired }).whoami()))).toBe(
    "INVALID_CREDENTIALS",
  );
  // no token: the anonymous session, as ever
  expect(await api.authenticate().whoami()).toBeNull();
});

test("the built-in cd carries the principal to a SIBLING context — an event appended through `itx.cd('/x').append(…)` is attributed like one appended at the root", async () => {
  const projectId = freshCtx("cd-who");
  const principal = { actor: "user_ada", email: "ada@example.com" };
  const itx = session()
    .authenticate({ projectToken: await mintProjectToken({ projectId, ...principal }) })
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
  //    session flushes as a single POST to /api; the shape is the same `.authenticate().projects.get(ctx)`.
  // eslint-disable-next-line iterate/no-capnweb-http-batch -- the batch door is what this proves: a socketless CLI client works
  const batch: any = newHttpBatchRpcSession(workerUrl("/api"));
  const who = await batch
    .authenticate()
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

  // 3. a fetch-shaped target through the SESSION (no /expression door): the terminal
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
  // (src/app-config.ts): the e2e lane names itself "e2e", a deployed worker names its environment.
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
  const a = s.authenticate().projects.get(ctx); // the root context ("/")
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
