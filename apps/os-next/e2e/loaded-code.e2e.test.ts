// loaded-code.e2e.test.ts — WHAT LOADED CODE MAY SAY (context/itx-expression-rewriting.ts rule 5, the
// app wall; iterate-context.ts `ItxEntrypoint`): a worker's, a facet's, a script's `env.ITX` runs every
// call as `Caller.app`. On what it hands in, the fixed point `itx.builtins` is not a word and `cd`
// goes down only — self and descendants; the rows a call rewrites through are the owner's and are never
// checked, so a parent link carries a script up exactly as far as its owner said. `provide` and
// `subscribe` are a session's verbs (loaded code writes rows with `itx.append`). A raw `fetch()` is
// `itx.fetch(request)` at the worker's context, through the table — no row below the owner root, no
// egress. The chain a child inherits: own rows → the parent link → … → the root's rows → the built-ins.
import { expect, test } from "vitest";
import { freshCtx, openItx, rejection, workerUrl } from "./support/client.ts";

/** A loaded worker that hands its `env.ITX` whatever the test asks it to say, and reports the refusal. */
const PROBE = {
  "cap.js": `import { WorkerEntrypoint } from "cloudflare:workers";
const outcome = async (fn) => { try { return { ok: await fn() }; } catch (e) { return { error: String(e && e.message || e) }; } };
export default class extends WorkerEntrypoint {
  async say(call, ...args) { const itx = this.env.ITX.get(); try { return await outcome(() => itx.invoke(call, ...args)); } finally { itx[Symbol.dispose]?.(); } }
  async cdWhoami(path) { const itx = this.env.ITX.get(); try { return await outcome(() => itx.cd(path).whoami()); } finally { itx[Symbol.dispose]?.(); } }
  async lend() { const itx = this.env.ITX.get(); try { return await outcome(() => itx.provide("itx.x", "itx.whoami")); } finally { itx[Symbol.dispose]?.(); } }
  async lendLive() { const itx = this.env.ITX.get(); try { return await outcome(async () => { using h = await itx.provide("itx.live", () => "from the worker"); return await itx.invoke("itx.live()"); }); } finally { itx[Symbol.dispose]?.(); } }
  async watch() { const itx = this.env.ITX.get(); try { return await outcome(() => itx.subscribe({ target: "itx.builtins.append" })); } finally { itx[Symbol.dispose]?.(); } }
  async fetchUrl(url) { const r = await fetch(url); return { status: r.status, text: (await r.text()).slice(0, 60) }; }
  async writeRow(match, target) { const itx = this.env.ITX.get(); try { return await outcome(() => itx.append({ type: "events.iterate.com/itx/rewrite-rule-configured", payload: { match, target } })); } finally { itx[Symbol.dispose]?.(); } }
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
});

test("a raw fetch() from loaded code is itx.fetch at its context, through the table: refused at a child with no row, egress at the root", async () => {
  const ctx = freshCtx("app-fetch");
  const root = openItx(ctx);
  const target = workerUrl("/version");
  expect(await root.cd("/x").workers.get({ source: PROBE }).fetchUrl(target)).toMatchObject({
    status: 404,
    text: expect.stringMatching(/no rewrite rule matches/), // the child has no `itx.fetch` row
  });
  const atRoot = await root.workers.get({ source: PROBE }).fetchUrl(target);
  expect(atRoot.status).toBeLessThan(500); // the root's implicit `itx.fetch`: egress answered
  // the owner grants egress to the child with one row, and the same fetch goes through
  await root.cd("/x").provide("itx.fetch", "itx.builtins.cd('/').fetch");
  expect((await root.cd("/x").workers.get({ source: PROBE }).fetchUrl(target)).status).toBe(
    atRoot.status,
  );
});

test("THE CHAIN: a subagent two levels down resolves a capability provided at the root through parent links, lists it with its description and origin, and births its own children relative to itself", async () => {
  const ctx = freshCtx("chain");
  const root = openItx(ctx);
  await root.provide({
    match: "itx.tool",
    target: () => "hello-from-root",
    description: "says hello",
  });
  await root.agents.get("/agents/a").create();
  // /agents/a was linked to its creator (the root). An agent's scripts run in ITS SANDBOX
  // (`/agents/a/sandbox`, linked to the agent), so a script there that creates `./b` births
  // `/agents/a/sandbox/b`, linked to the sandbox — a child never holds more than its creator.
  const sub = "/agents/a/sandbox/b";
  expect(
    await root
      .cd("/agents/a")
      .run(
        "async (itx) => { await itx.agents.get('./b').create(); return (await itx.cd('./b').rewriteRules.list()).filter((r) => r.match === 'itx').map((r) => r.target); }",
      ),
  ).toEqual(["itx.builtins.cd('/agents/a/sandbox')"]); // the child's own link, pointing at its creator
  expect(await root.cd(sub).builtins.rewriteRules.get("itx")).toMatchObject({
    target: "itx.builtins.cd('/agents/a/sandbox')",
  });
  // three hops down, the root's stub answers, and the list says where it came from
  expect(await root.cd(sub).run("async (itx) => itx.tool()")).toBe("hello-from-root");
  const rows = (await root.cd(sub).rewriteRules.list()) as {
    match: string;
    context: string;
    description?: string;
  }[];
  expect(rows.find((row) => row.match === "itx.tool")).toMatchObject({
    context: "/",
    description: "says hello",
  });
  expect(rows.find((row) => row.match === "itx.kv")).toMatchObject({ context: "/" });
  expect(rows.find((row) => row.match === "itx.append")).toMatchObject({ context: sub });
  // nothing project-level is implicit below the root: a mask at /agents/a stops the chain there
  await root.cd("/agents/a").provide("itx.tool", null);
  // (a run's failure crosses the log as the settlement's TEXT, never a code)
  expect((await rejection(root.cd(sub).run("async (itx) => itx.tool()"))).message).toMatch(
    /is masked/,
  );
});
