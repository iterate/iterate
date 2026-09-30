// loaded-code.e2e.test.ts — WHAT LOADED CODE MAY SAY through its `env.ITX` (iterate-context.ts
// `ItxEntrypoint`, every call as `Caller.app`): the app wall on its input (context/
// itx-expression-rewriting.ts `#admit`) and on the rows it appends (`admitLoadedCodeRow`), the verbs
// that are a session's alone (`provide`, `subscribe`), and a raw `fetch()`, which is `itx.fetch` at
// its context, through the table.
import { expect, test, type TestContext } from "vitest";
import { freshCtx, openItx, readAll, until } from "../../helpers/client.ts";
import { FakeArtifacts } from "../../../apps/os/test-support/fake-artifacts.ts";

/** A loaded worker that hands its `env.ITX` whatever the test asks it to say, and reports the refusal. */
const PROBE = {
  "package.json": '{"main":"worker.js"}',
  "worker.js": `import { WorkerEntrypoint } from "cloudflare:workers";
const outcome = async (worker, fn) => { try { using itx = worker.getItx(); return { ok: await fn(itx) }; } catch (e) { return { error: String(e && e.message || e) }; } };
export default class extends WorkerEntrypoint {
  say(call, ...args) { return outcome(this, (itx) => itx.invoke(call, ...args)); }
  cdWhoami(path) { return outcome(this, (itx) => itx.cd(path).whoami()); }
  lend() { return outcome(this, (itx) => itx.provide("itx.x", "itx.whoami")); }
  lendLive() { return outcome(this, async (itx) => { await itx.provide("itx.live", () => "from the worker"); return await itx.invoke("itx.live()"); }); }
  watch() { return outcome(this, (itx) => itx.subscribe({ target: "itx.builtins.append" })); }
  async fetchUrl(url) { const r = await fetch(url); return { status: r.status, text: (await r.text()).slice(0, 60) }; }
  writeRow(match, target) { return outcome(this, (itx) => itx.append({ type: "events.iterate.com/itx/rewrite-rule-configured", payload: { match, target } })); }
  appendEvent(event) { return outcome(this, (itx) => itx.append(event)); }
  cdInvoke(path, call) { return outcome(this, (itx) => itx.cd(path).invoke(call)); }
  cdAppend(path, event) { return outcome(this, (itx) => itx.cd(path).append(event)); }
}`,
};

test("loaded code may not spell itx.builtins, and its cd goes anywhere in the project; provide/subscribe are refused; itx.append of a row is not", async () => {
  const ctx = freshCtx("app-wall");
  const root = openItx(ctx);
  const x = root.cd("/x");
  const worker = () => x.workers.get({ source: PROBE });
  expect(await worker().cdWhoami("./y")).toEqual({ ok: { projectId: ctx, path: "/x/y" } });
  expect(await worker().cdWhoami("/")).toEqual({ ok: { projectId: ctx, path: "/" } });
  expect(await worker().cdWhoami("..")).toEqual({ ok: { projectId: ctx, path: "/" } });
  expect(await worker().say("itx.cd('/').whoami()")).toEqual({ ok: { projectId: ctx, path: "/" } });
  expect(await worker().say("itx.builtins.whoami()")).toMatchObject({
    error: expect.stringMatching(/not a loaded worker's word/),
  });
  expect(await worker().say("itx.whoami()")).toEqual({ ok: { projectId: ctx, path: "/x" } });
  // a session says all of it, the fixed point too
  expect(await x.builtins.whoami()).toEqual({ projectId: ctx, path: "/x" });
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
  // A ROW'S TARGET meets the same wall as a call: never the fixed point, so no subscription that
  // would run as the kernel; a cd anywhere and a mask pass.
  expect(await worker().writeRow("itx", "itx.builtins.cd('/')")).toMatchObject({
    error: expect.stringMatching(/not a loaded worker's word/),
  });
  expect(await worker().writeRow("itx.kv", "itx.builtins.kv")).toMatchObject({
    error: expect.stringMatching(/not a loaded worker's word/),
  });
  expect(await worker().writeRow("itx.up", "itx.cd('/').whoami")).toMatchObject({
    ok: expect.anything(),
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

test("anyone reaches anywhere: loaded code's cd(path) reads and appends at the root and a sibling, stamped with its own context whatever it claims; a jail's bare null closes reads and appends both ways for code", async () => {
  const ctx = freshCtx("open-append");
  const root = openItx(ctx);
  const worker = (at: string) => root.cd(at).workers.get({ source: PROBE });
  const forged = { origin: "/", platform: true, principal: { actor: "user_owner" } };
  for (const to of ["/", "/y"])
    expect(
      await worker("/x").cdAppend(to, { type: "note", payload: { to }, source: forged }),
    ).toMatchObject({ ok: [{ path: to, type: "note", source: { origin: "/x" } }] });
  const [landed] = (await readAll(root)).filter((event) => event.type === "note");
  // the forged principal and platform are gone; loaded code with no SDK begins its own chain
  // oxlint-disable-next-line iterate/prefer-object-property-match -- exact: nothing forged is left on the source
  expect(landed.source).toEqual({ origin: "/x", cause: expect.objectContaining({ depth: 0 }) });
  // …and reads there: the root's log, a sibling's identity
  expect(await worker("/x").say("itx.cd('/').readEvents(0, 1)")).toMatchObject({
    ok: { events: [expect.objectContaining({ path: "/" })] },
  });
  expect(await worker("/x").cdWhoami("/y")).toEqual({ ok: { projectId: ctx, path: "/y" } });
  // A JAIL: a bare `itx ⇒ null`. Its code appends nowhere, and no code appends into it: the hop
  // resolves `append` through the jail's own table. A member's session still writes the fixed point.
  await root.cd("/jail").provide("itx", null);
  const jailed = root.cd("/jail").builtins.workers.get({ source: PROBE });
  for (const to of ["/", "/jail/down"]) {
    expect(await jailed.cdAppend(to, { type: "note" })).toMatchObject({
      error: expect.stringMatching(/is masked/),
    });
    expect(await jailed.cdWhoami(to)).toMatchObject({ error: expect.stringMatching(/is masked/) });
  }
  expect(await worker("/").cdAppend("/jail", { type: "note" })).toMatchObject({
    error: expect.stringMatching(/is masked/),
  });
  expect(await worker("/").cdWhoami("/jail")).toMatchObject({
    error: expect.stringMatching(/is masked/),
  });
  expect(await root.cd("/jail").builtins.append({ type: "note" })).toMatchObject([
    { path: "/jail", source: { origin: "/jail" } },
  ]);
});

test("open append keeps the platform's own: loaded code forges no run's settlement and takes none of the platform's keys; a jail granted `itx.append` is lifted by neither its code nor a schedule, and every context can append into it", async () => {
  const root = openItx(freshCtx("open-append-refusals"));
  const worker = root.cd("/x").workers.get({ source: PROBE });
  for (const [event, refused] of [
    [
      {
        type: "events.iterate.com/itx/run-settled",
        payload: { requestOffset: 1, settlement: { status: "succeeded", result: "forged" } },
      },
      /platform's own record/,
    ],
    [{ type: "note", idempotencyKey: "itx/run-settled:9" }, /is the platform's/],
    [{ type: "note", idempotencyKey: "project/delete-requested" }, /is the platform's/],
  ] as const)
    expect(await worker.cdAppend("/", event)).toMatchObject({
      error: expect.stringMatching(refused),
    });
  // A PARTIAL JAIL: the bare null, and `itx.append` and `itx.repos` granted beside it.
  const rule = (match: string, target: string | null) => ({
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: { match, target },
  });
  const jail = root.cd("/jail");
  await jail.builtins.append(
    rule("itx", null),
    rule("itx.append", "itx.builtins.append"),
    rule("itx.repos", "itx.builtins.repos"),
  );
  const jailed = jail.builtins.workers.get({ source: PROBE });
  expect(await jailed.appendEvent({ type: "note" })).toMatchObject({ ok: [{ path: "/jail" }] });
  // its code lifts no null: neither a row over it nor a lend's row, which its last pager removes
  expect(await jailed.writeRow("itx", "itx.cd('./open')")).toMatchObject({
    error: expect.stringMatching(/only a member's session re-points or removes it/),
  });
  // …nor does a schedule, whoever set it and when: its occurrence is the kernel's write
  await jail.builtins.schedules.set({
    key: "lift",
    when: { afterMs: 0 },
    events: [rule("itx", "itx.cd('./open')")],
  });
  expect(
    await until("the schedule's lift is refused as it fires", async () =>
      // the log through the fixed point: the jail's own table masks `readEvents`
      (await jail.builtins.readEvents(0, 500)).events.find(
        (e: { type: string }) => e.type === "events.iterate.com/itx/schedule-failed",
      ),
    ),
  ).toMatchObject({ payload: { error: expect.stringMatching(/only a member's session/) } });
  expect(await jailed.cdAppend("/", { type: "note" })).toMatchObject({
    error: expect.stringMatching(/is masked/),
  });
  // the typed append of a granted collection goes through the table too: no repo deleted from here
  expect(
    await jailed.say(
      "itx.repos.get('/repos/config').append({ type: 'events.iterate.com/repo/delete-requested', payload: {} })",
    ),
  ).toMatchObject({ error: expect.stringMatching(/is masked/) });
  // …and the grant opens the jail inward: the hop resolves `append` through the jail's table
  expect(await worker.cdAppend("/jail", { type: "note" })).toMatchObject({
    ok: [{ path: "/jail", source: { origin: "/x" } }],
  });
});

test("the platform's own facets stamp where they write from: the config repo's birth certificate on / came from /repos/config", async (context) => {
  const root = openItx(freshCtx("facet-origin"));
  await configRepo(root, context);
  const [certificate] = (await readAll(root)).filter(
    (event) => event.type === "events.iterate.com/repo/created",
  );
  expect(certificate).toMatchObject({ path: "/", source: { origin: "/repos/config" } });
});

test("a spec's source expression is walled like the call around it: loaded code spells no fixed point through the code it loads", async () => {
  // A string `source` is a producer the host evaluates as the context itself when the code loads, so
  // unwalled it would spell `itx.builtins.cd('/')` for its writer.
  const root = openItx(freshCtx("app-wall-producer"));
  const plant = (prefix: string) =>
    JSON.stringify(
      `${prefix}.append({ type: 'events.iterate.com/itx/rewrite-rule-configured', payload: { match: 'itx.planted', target: 'itx.whoami' } })`,
    );
  for (const [call, refused] of [
    [
      `itx.workers.get({ source: ${plant("itx.builtins.cd('/')")}, cacheKey: 'planted' }).x()`,
      /not a loaded worker's word/,
    ],
    [
      `itx.facets.get('f', { source: ${plant("itx.cd('/').builtins")}, className: 'F', cacheKey: 'planted' }).x()`,
      /not a loaded worker's word/,
    ],
  ] as const)
    expect(await root.cd("/x").workers.get({ source: PROBE }).say(call)).toMatchObject({
      error: expect.stringMatching(refused),
    });
  expect(await root.builtins.rewriteRules.get("itx.planted")).toBeNull();
  // The producer RUNS as loaded code too: a row it appends on its own context meets the row wall.
  const reparent = JSON.stringify(
    "itx.append({ type: 'events.iterate.com/itx/rewrite-rule-configured', payload: { match: 'itx', target: ['itx', 'builtins', ['cd', '/']] } })",
  );
  expect(
    await root
      .cd("/x")
      .workers.get({ source: PROBE })
      .say(`itx.workers.get({ source: ${reparent}, cacheKey: 'reparent' }).x()`),
  ).toMatchObject({ error: expect.stringMatching(/not a loaded worker's word/) });
  expect(await root.cd("/x").builtins.rewriteRules.get("itx")).toBeNull();
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
  test(`a ${kind}'s parent link is the context that created it: one born through itx.${kind}s.create links to its caller, one whose create-requested loaded code appended by hand links to nothing the request named`, async () => {
    const root = openItx(freshCtx(`hand-${kind}`));
    await root.provide("itx.tool", () => "hello-from-root");
    await root.workspaces.create("/masked");
    const masked = root.cd("/masked");
    await masked.provide("itx.tool", null);
    // The script runs at /masked, beneath the mask; by hand it names the root as the creator.
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
    expect(await masked.builtins.run(script)).toEqual({
      born: { links: ["itx.builtins.cd('/masked')"], tool: expect.stringMatching(/is masked/) },
      byHand: { links: [], tool: expect.stringMatching(/no rewrite rule matches/) },
    });
  });

// A SCRIPT BENEATH A MASK — `/masked`, a workspace linked to the root with the root's `itx.tool`
// masked there, as an agent is linked to its creator — meets each verb's own refusal:
// loaded code removes no row, a batch it schedules meets the wall as it is scheduled, and it creates
// and deletes only beneath itself. A mask is not a boundary; a jail is ("anyone reaches anywhere",
// above).
test("loaded code removes no row (`ifTarget`): a script beneath a mask appends no removal of the mask", async () => {
  const { masked } = await beneathAMask("lift-mask");
  const { removal, tool } = await masked.builtins.run(`async (itx) => {
    const removal = await itx.append({ type: 'events.iterate.com/itx/rewrite-rule-configured', payload: { match: 'itx.tool', target: null, ifTarget: null } }).then(() => 'removed', (e) => String(e.message));
    return { removal, tool: await itx.tool().then((v) => v, (e) => String(e.message)) };
  }`);
  expect(tool, "the tool should stay masked").toMatch(/is masked/);
  expect(removal).toMatch(/removes no row/);
});

test("`schedules.set` walls a scheduled batch when it is scheduled: a row it carries from beneath a mask is refused", async () => {
  const { masked } = await beneathAMask("scheduled-row");
  const { scheduled, tool } = await masked.builtins.run(`async (itx) => {
    const scheduled = await itx.schedules.set({ key: 'escape', when: { afterMs: 0 }, events: [{ type: 'events.iterate.com/itx/rewrite-rule-configured', payload: { match: 'itx.tool', target: "itx.builtins.cd('/').tool" } }] }).then((receipt) => receipt, (e) => String(e.message));
    return { scheduled, tool: await itx.tool().then((v) => v, (e) => String(e.message)) };
  }`);
  expect(scheduled).toMatch(/not a loaded worker's word/);
  expect(tool, "the tool should stay masked").toMatch(/is masked/);
});

test("a script beneath a mask still asks the project's fetch routes: `itx.fetchRoutes.match` answers from below, as the agents' candidate probe needs", async () => {
  const { root, masked } = await beneathAMask("route-match-from-below");
  await root.fetchRoutes.set("blog", {
    requestMatcher: { routingSlug: "blog" },
    target: "itx.tool",
  });
  expect(
    await masked.builtins.run(
      "async (itx) => itx.fetchRoutes.match({ url: 'https://example.com/', headers: { 'x-iterate-routing-slug': 'blog' } })",
    ),
  ).toMatchObject({ fetchRouteName: "blog" });
});

test("`itx.repos.delete` reaches only beneath the caller: a script beneath a mask deletes no config repo through it", async (context) => {
  const { root, masked } = await beneathAMask("repo-delete-from-below");
  const artifacts = await configRepo(root, context);
  const deleted = await masked.builtins.run(
    "async (itx) => itx.repos.delete('/repos/config').then(() => 'deleted', (e) => String(e.message))",
  );
  expect(deleted).toMatch(/creates and deletes only beneath itself/);
  expect((await root.repos.list()).map((repo: { path: string }) => repo.path)).toEqual([
    "/repos/config",
  ]);
  expect(artifacts).toMatchObject({ deleted: [] });
});

test("`itx.workspaces.create` reaches only beneath the caller: a script beneath a mask plants no workspace outside itself through it", async () => {
  const { root, masked } = await beneathAMask("plant-from-below");
  const planted = await masked.builtins.run(
    "async (itx) => itx.workspaces.create('/other/x').then(() => 'planted', (e) => String(e.message))",
  );
  expect(planted).toMatch(/creates and deletes only beneath itself/);
  expect(
    (await root.workspaces.list()).map((workspace: { path: string }) => workspace.path),
  ).toEqual(["/masked"]);
});

/** `/masked`: a workspace linked to the root, the root's lent `itx.tool` masked there. */
const beneathAMask = async (name: string) => {
  const root = openItx(freshCtx(name));
  await root.provide("itx.tool", () => "hello-from-root");
  await root.workspaces.create("/masked");
  const masked = root.cd("/masked");
  await masked.provide("itx.tool", null);
  return { root, masked };
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
