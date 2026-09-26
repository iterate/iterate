// loaded-code.e2e.test.ts — WHAT LOADED CODE MAY SAY (the app wall, context/itx-expression-rewriting.ts
// `admitLoadedCodeExpression`; iterate-context.ts `ItxEntrypoint`): a worker's, a facet's, a script's `env.ITX` runs every
// call as `Caller.app`. On what it hands in, the fixed point `itx.builtins` is not a word and `cd`
// goes down only — self and descendants; the rows a call rewrites through are the owner's and are never
// checked, so a parent link carries a script up exactly as far as its owner said. `provide` and
// `subscribe` are a session's verbs (loaded code writes rows with `itx.append`). A raw `fetch()` is
// `itx.fetch(request)` at the worker's context, through the table — no row below the owner root, no
// egress. The chain a child inherits: own rows → the parent link → … → the root's rows → the built-ins.
import { expect, test, type TestContext } from "vitest";
import { freshCtx, openItx, readAll } from "./support/client.ts";
import { FakeArtifacts } from "./support/fake-artifacts.ts";

/** A loaded worker that hands its `env.ITX` whatever the test asks it to say, and reports the refusal. */
const PROBE = {
  "worker.js": `import { WorkerEntrypoint } from "cloudflare:workers";
import { withItx } from "iterate/sdk";
const outcome = async (fn) => { try { return { ok: await fn() }; } catch (e) { return { error: String(e && e.message || e) }; } };
export default class extends WorkerEntrypoint {
  say(call, ...args) { return outcome(() => withItx(this.env.ITX, (itx) => itx.invoke(call, ...args))); }
  cdWhoami(path) { return outcome(() => withItx(this.env.ITX, (itx) => itx.cd(path).whoami())); }
  lend() { return outcome(() => withItx(this.env.ITX, (itx) => itx.provide("itx.x", "itx.whoami"))); }
  lendLive() { return outcome(() => withItx(this.env.ITX, async (itx) => { await itx.provide("itx.live", () => "from the worker"); return await itx.invoke("itx.live()"); })); }
  watch() { return outcome(() => withItx(this.env.ITX, (itx) => itx.subscribe({ target: "itx.builtins.append" }))); }
  async fetchUrl(url) { const r = await fetch(url); return { status: r.status, text: (await r.text()).slice(0, 60) }; }
  writeRow(match, target) { return outcome(() => withItx(this.env.ITX, (itx) => itx.append({ type: "events.iterate.com/itx/rewrite-rule-configured", payload: { match, target } }))); }
  appendEvent(event) { return outcome(() => withItx(this.env.ITX, (itx) => itx.append(event))); }
  cdInvoke(path, call) { return outcome(() => withItx(this.env.ITX, (itx) => itx.cd(path).invoke(call))); }
}`,
};

test("loaded code may not spell itx.builtins, and its cd goes down only; the same from a session is fine; provide/subscribe are refused; itx.append of a row is not", async () => {
  const ctx = freshCtx("app-wall");
  const root = openItx(ctx);
  const x = root.cd("/x");
  const worker = () => x.workers.get({ source: PROBE });
  expect(await worker().cdWhoami("./y")).toEqual({ ok: { projectId: ctx, path: "/x/y" } });
  expect(await worker().cdWhoami("/")).toMatchObject({
    error: expect.stringMatching(/goes down only/),
  });
  expect(await worker().cdWhoami("..")).toMatchObject({
    error: expect.stringMatching(/goes down only/),
  });
  expect(await worker().say("itx.cd('/').whoami()")).toMatchObject({
    error: expect.stringMatching(/goes down only/),
  });
  expect(await worker().say("itx.builtins.whoami()")).toMatchObject({
    error: expect.stringMatching(/not a loaded worker's word/),
  });
  expect(await worker().say("itx.whoami()")).toEqual({ ok: { projectId: ctx, path: "/x" } });
  // a session says all of it
  expect(await x.builtins.whoami()).toEqual({ projectId: ctx, path: "/x" });
  expect(await x.cd("/").whoami()).toEqual({ projectId: ctx, path: "/" });
  // a ROW is itx.append's business; a live stub of the worker's own is lendable and dies with the call
  expect(await worker().lend()).toMatchObject({
    error: expect.stringMatching(/lends a live stub only/),
  });
  expect(await worker().watch()).toMatchObject({
    error: expect.stringMatching(/lends a live callback only/),
  });
  expect(await worker().lendLive()).toEqual({ ok: "from the worker" });
  // …while a row is one append away, and it took effect
  expect(await worker().writeRow("itx.me", "itx.whoami")).toMatchObject({ ok: expect.anything() });
  expect(await worker().say("itx.me()")).toEqual({ ok: { projectId: ctx, path: "/x" } });
  // A ROW'S TARGET meets the same wall as a call: no re-parenting past the creator, no project root
  // granted to itself, no subscription that would run as the kernel above it; a mask passes.
  expect(await worker().writeRow("itx", "itx.builtins.cd('/')")).toMatchObject({
    error: expect.stringMatching(/not a loaded worker's word/),
  });
  expect(await worker().writeRow("itx.kv", "itx.builtins.kv")).toMatchObject({
    error: expect.stringMatching(/not a loaded worker's word/),
  });
  expect(await worker().writeRow("itx.up", "itx.cd('/').whoami")).toMatchObject({
    error: expect.stringMatching(/goes down only/),
  });
  expect(
    await worker().appendEvent({
      type: "events.iterate.com/itx/subscription-configured",
      payload: { name: "leak", target: "itx.builtins.cd('/').append" },
    }),
  ).toMatchObject({ error: expect.stringMatching(/not a loaded worker's word/) });
  expect(await worker().writeRow("itx.kv", null)).toMatchObject({ ok: expect.anything() });
  expect(await x.builtins.rewriteRules.get("itx")).toBeNull(); // nothing of the refused landed
  // the handle's own `invoke` takes a whole call, as the API declares
  expect(await worker().cdInvoke("./y", "itx.whoami()")).toEqual({
    ok: { projectId: ctx, path: "/x/y" },
  });
});

test("a raw fetch() from loaded code is itx.fetch at its context, through the table: refused at a child with no row, egress at the root", async () => {
  const ctx = freshCtx("app-fetch");
  const root = openItx(ctx);
  const target = "https://example.com/"; // egress proper — never this worker's own origin, which a Worker may not fetch on Cloudflare
  expect(await root.cd("/x").workers.get({ source: PROBE }).fetchUrl(target)).toMatchObject({
    status: 404,
    text: expect.stringMatching(/no rewrite rule matches/), // the child has no `itx.fetch` row
  });
  const atRoot = await root.workers.get({ source: PROBE }).fetchUrl(target);
  expect(atRoot.status).toBeLessThan(500); // the root's implicit `itx.fetch`: egress answered
  // the owner grants egress to the child with one row, and the same fetch goes through
  await root.cd("/x").provide("itx.fetch", "itx.builtins.cd('/').fetch");
  expect(await root.cd("/x").workers.get({ source: PROBE }).fetchUrl(target)).toMatchObject({
    status: atRoot.status,
  });
});

test("owner-written physical redirects survive a loaded-code hop, while fresh calls and forwarded row writes still meet admission", async () => {
  const root = openItx(freshCtx("admitted-hop"));
  const child = root.cd("/child");
  const worker = () => child.workers.get({ source: PROBE });
  await child.provide("itx.identity", "itx.builtins.cd('/').builtins.whoami");
  await child.provide("itx.write", "itx.builtins.cd('/').builtins.append");
  expect(await worker().say("itx.identity()")).toMatchObject({ ok: { path: "/" } });
  // A successful owner-granted hop must never authorize the worker's next input.
  expect(await worker().say("itx.builtins.whoami()")).toMatchObject({
    error: expect.stringMatching(/not a loaded worker's word/),
  });
  expect(await worker().say("itx.cd('/').whoami()")).toMatchObject({
    error: expect.stringMatching(/goes down only/),
  });
  expect(
    await worker().say("itx.write", {
      type: "events.iterate.com/itx/rewrite-rule-configured",
      payload: { match: "itx.escape", target: "itx.builtins.kv" },
    }),
  ).toMatchObject({ error: expect.stringMatching(/not a loaded worker's word/) });
  expect(await root.builtins.rewriteRules.get("itx.escape")).toBeNull();
});

// The collection writes a new entity's parent link from the library's caller; a request appended
// by hand names nothing the processor acts on.
for (const kind of ["repo", "workspace"] as const)
  test(`a ${kind}'s parent link is the context that created it: one born through itx.${kind}s.create links to its caller, one whose create-requested loaded code appended by hand links to nothing the request named — a script beneath a mask cannot reach past it`, async () => {
    const root = openItx(freshCtx(`hand-${kind}`));
    await root.provide("itx.tool", () => "hello-from-root");
    await root.workspaces.create("/jail");
    const jail = root.cd("/jail");
    await jail.provide("itx.tool", null);
    // The script runs at /jail, beneath the mask; by hand it names the root as the creator.
    const script = `async (itx) => {
      const outcome = async (child) => {
        const { path } = await child.whoami();
        const rows = await child.rewriteRules.list();
        return {
          links: rows.filter((r) => r.match === 'itx' && r.context === path).map((r) => r.target),
          tool: await child.tool().then((v) => v, (e) => String(e.message)),
        };
      };
      await itx.${kind}s.create('./born');
      const child = itx.cd('./by-hand');
      await child.processors.enable('${kind}');
      const [requested] = await child.append({ type: 'events.iterate.com/${kind}/create-requested', payload: { creator: '/' } });
      await child.waitForEvent({ type: ['events.iterate.com/${kind}/created', 'events.iterate.com/${kind}/create-failed'], afterOffset: requested.offset });
      return { born: await outcome(itx.cd('./born')), byHand: await outcome(child) };
    }`;
    expect(await jail.builtins.run(script)).toEqual({
      born: { links: ["itx.builtins.cd('/jail')"], tool: expect.stringMatching(/is masked/) },
      byHand: { links: [], tool: expect.stringMatching(/no rewrite rule matches/) },
    });
  });

// A SCRIPT BENEATH A MASK — `/jail`, a workspace linked to the root with the root's `itx.tool`
// masked there, as an agent's sandbox is linked to its agent — gets no way round the mask: loaded
// code removes no row, a batch it schedules meets the wall as it is scheduled, it sets no project
// fetch route (the config worker serves those at the root), and it creates and deletes only
// beneath itself, the lifecycle facts included.
test("a script beneath a mask cannot lift it: loaded code removes no row (`ifTarget`)", async () => {
  const { jail } = await beneathAMask("lift-mask");
  const { removal, tool } = await jail.builtins.run(`async (itx) => {
    const removal = await itx.append({ type: 'events.iterate.com/itx/rewrite-rule-configured', payload: { match: 'itx.tool', target: null, ifTarget: null } }).then(() => 'removed', (e) => String(e.message));
    return { removal, tool: await itx.tool().then((v) => v, (e) => String(e.message)) };
  }`);
  expect(tool, "the tool should stay masked").toMatch(/is masked/);
  expect(removal).toMatch(/removes no row/);
});

test("a script beneath a mask cannot schedule a row past it: a scheduled batch meets the wall when it is scheduled", async () => {
  const { jail } = await beneathAMask("scheduled-row");
  const { scheduled, tool } = await jail.builtins.run(`async (itx) => {
    const scheduled = await itx.schedules.set({ key: 'escape', when: { afterMs: 0 }, events: [{ type: 'events.iterate.com/itx/rewrite-rule-configured', payload: { match: 'itx.tool', target: "itx.builtins.cd('/').tool" } }] }).then((receipt) => receipt, (e) => String(e.message));
    return { scheduled, tool: await itx.tool().then((v) => v, (e) => String(e.message)) };
  }`);
  expect(scheduled).toMatch(/not a loaded worker's word/);
  expect(tool, "the tool should stay masked").toMatch(/is masked/);
});

test("a script beneath a mask cannot set a project fetch route, which the config worker would serve at the root", async () => {
  const { root, jail } = await beneathAMask("route-from-below");
  const set = await jail.builtins.run(
    "async (itx) => itx.fetchRoutes.set('leak', { requestMatcher: { routingSlug: 'leak' }, target: 'itx.tool' }).then(() => 'set', (e) => String(e.message))",
  );
  expect(set).toMatch(/fetch routes are set only from the project's root/);
  expect(await root.fetchRoutes.list()).toEqual([]);
});

test("a script beneath a mask still asks the project's fetch routes: `itx.fetchRoutes.match` answers from below, as the agents' candidate probe needs", async () => {
  const { root, jail } = await beneathAMask("route-match-from-below");
  await root.fetchRoutes.set("blog", {
    requestMatcher: { routingSlug: "blog" },
    target: "itx.tool",
  });
  expect(
    await jail.builtins.run(
      "async (itx) => itx.fetchRoutes.match({ url: 'https://example.com/', headers: { 'x-iterate-routing-slug': 'blog' } })",
    ),
  ).toMatchObject({ fetchRouteName: "blog" });
});

test("a script beneath a mask cannot delete the config repo: `itx.repos.delete` reaches only beneath the caller", async (context) => {
  const { root, jail } = await beneathAMask("repo-delete-from-below");
  const artifacts = await configRepo(root, context);
  const deleted = await jail.builtins.run(
    "async (itx) => itx.repos.delete('/repos/config').then(() => 'deleted', (e) => String(e.message))",
  );
  expect(deleted).toMatch(/creates and deletes only beneath itself/);
  expect((await root.repos.list()).map((repo: { path: string }) => repo.path)).toEqual([
    "/repos/config",
  ]);
  expect(artifacts).toMatchObject({ deleted: [] });
});

test("a script beneath a mask cannot delete the config repo by appending its request: the typed append refuses the repo's lifecycle facts", async (context) => {
  const { root, jail } = await beneathAMask("repo-request-from-below");
  await configRepo(root, context);
  const appended = await jail.builtins.run(
    "async (itx) => itx.repos.get('/repos/config').append({ type: 'events.iterate.com/repo/delete-requested', payload: {} }).then(() => 'appended', (e) => String(e.message))",
  );
  expect(appended).toMatch(/is written by the repo itself/);
  expect(
    (await readAll(root.cd("/repos/config"))).filter(
      (e: { type: string }) => e.type === "events.iterate.com/repo/delete-requested",
    ),
  ).toEqual([]);
  expect((await root.repos.list()).map((repo: { path: string }) => repo.path)).toEqual([
    "/repos/config",
  ]);
});

test("a script beneath a mask cannot plant a workspace outside itself: `itx.workspaces.create` reaches only beneath the caller", async () => {
  const { root, jail } = await beneathAMask("plant-from-below");
  const planted = await jail.builtins.run(
    "async (itx) => itx.workspaces.create('/other/x').then(() => 'planted', (e) => String(e.message))",
  );
  expect(planted).toMatch(/creates and deletes only beneath itself/);
  expect(
    (await root.workspaces.list()).map((workspace: { path: string }) => workspace.path),
  ).toEqual(["/jail"]);
});

/** `/jail`: a workspace linked to the root, the root's lent `itx.tool` masked there. */
const beneathAMask = async (name: string) => {
  const root = openItx(freshCtx(name));
  await root.provide("itx.tool", () => "hello-from-root");
  await root.workspaces.create("/jail");
  const jail = root.cd("/jail");
  await jail.provide("itx.tool", null);
  return { root, jail };
};

/** The config repo on a fake Artifacts proxy, created from the root. The test's own
 *  `onTestFinished`: its rows run concurrently, which vitest's global hook does not track. */
const configRepo = async (root: any, { onTestFinished }: TestContext) => {
  const artifacts = await FakeArtifacts.start();
  onTestFinished(() => artifacts.close());
  await root.cd("/repos/config").provide("itx.cfArtifacts", artifacts);
  await root.repos.create("/repos/config");
  return artifacts;
};
