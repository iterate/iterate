// Public OAuth admission, principal propagation and Cap’n Web resource teardown.
// eslint-disable-next-line iterate/no-capnweb-http-batch -- the /api one-shot batch door itself is under test; everything else is WS
import { newHttpBatchRpcSession } from "capnweb";
import { expect, test } from "vitest";
import type { Session } from "../src/session.ts";
import {
  adminCredentials,
  codeOf,
  freshCtx,
  publicSession,
  openItx,
  readAll,
  rejection,
  session,
  sleep,
  workerUrl,
} from "./support/client.ts";
import { oauthSession } from "./support/principal.ts";
import {
  deployedOnly,
  freshDnsSafeProjectId,
  projectHostsAreLocal,
  registerProject,
} from "./support/project-host.ts";
import { SOURCES } from "./support/sources.ts";

test("an OAuth grant: identity, unforgeable append attribution, project boundary and revocation", async () => {
  const projectId = freshDnsSafeProjectId("identity");
  const member = { email: `${projectId}@example.com` };
  await registerProject(projectId, member);
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
  expect(codeOf(await rejection(api.projects.get(`${projectId}-other`).whoami()))).toBe(
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

test("the built-in cd carries the OAuth principal to a sibling context", async () => {
  const projectId = freshDnsSafeProjectId("cd-who");
  const member = { email: `${projectId}@example.com` };
  await registerProject(projectId, member);
  const { api, principal } = await oauthSession(projectId, member);
  const itx = api.projects.get(projectId);
  await itx.invoke("itx.cd('/sibling').append({ type: 'note', payload: { via: 'cd' } })");
  const note = (await readAll(itx.cd("/sibling"))).find((e) => e.type === "note");
  expect(note?.source?.principal).toEqual(principal);
});

deployedOnly(
  "a personal token opens public Cap’n Web and MCP with the same project ceiling",
  async () => {
    const projectId = freshDnsSafeProjectId("personal");
    const member = { email: `${projectId}@example.com` };
    await registerProject(projectId, member);
    const { issuerHeaders } = await oauthSession(projectId, member);
    // eslint-disable-next-line iterate/no-capnweb-http-batch -- A bounded token mint through the account capability.
    using issuer = newHttpBatchRpcSession<Session>(
      new Request(workerUrl("/api"), { headers: issuerHeaders }),
    );
    const { token, expiresAt } = await issuer.grants.mint({
      name: "E2E personal token",
      projects: [projectId],
    });
    expect(expiresAt).toBeGreaterThan(Date.now());
    const api = publicSession(token);
    expect((await api.whoami()).email).toBe(member.email);
    expect((await api.projects.list()).map((project) => project.id)).toEqual([projectId]);
    const mcp = process.env.MCP_BASE_URL || workerUrl("/mcp");
    const response = await fetch(mcp, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list_projects", arguments: {} },
      }),
    });
    const body = await response.text();
    expect(response.status, body).toBe(200);
    expect(body).toContain(projectId);
    await api.logout();
    const ended = await fetch(mcp, { headers: { Authorization: `Bearer ${token}` } });
    expect(ended.status).toBe(401);
    await ended.body?.cancel();
  },
);

// ── the doors ──

test("one-shot HTTP batch whoami at /api, an inline-source worker, and a dotted .fetch(request) through a rewrite rule", async () => {
  // The batch and the live session share ONE ctx (one project DO).
  const ctx = freshDnsSafeProjectId("edge");
  const member = { email: `${ctx}@example.com` };
  await registerProject(ctx, member);
  const { token } = await oauthSession(ctx, member);

  // eslint-disable-next-line iterate/no-capnweb-http-batch -- A public bearer also admits a bounded socketless batch.
  using batch = newHttpBatchRpcSession<Session>(
    new Request(workerUrl("/api"), {
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
  const who: any = await batch.projects.get(ctx).invoke(["itx", ["whoami"]]);
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
