// e2e/context-abort.e2e.test.ts — A RESET ON REQUEST: `itx.abort(reason?)` resets the context it is
// spelled at (Cloudflare's `ctx.abort`: its in-memory state is discarded and the next call builds a
// fresh incarnation from durable storage); `itx.facets.abort(name, reason?)` resets one facet from
// the host and leaves the context alone. Each records its fact first — `context/aborted`,
// `context/facet-aborted` — and the caller's own call RESOLVES with it: the reset is what it asked
// for (iterate-context-durable-object.ts `#abortAfterTheAnswer`). The rows:
//   • the caller's call resolves, the fact is durable, the next call wakes a fresh incarnation
//     (one more `stream/woken`) over the same log, tables and kv
//   • `cd(path).abort()` resets that context and not the one the call came through
//   • a `waitForEvent` pending on the reset context rejects for its waiter
//   • SCOPE: a session aborts only the projects it reaches (another project's id is FORBIDDEN, and a
//     path that spells another project's name is a path of its own); loaded code aborts its own
//     context and those below it, never above
//   • a facet reset: a call hung on the facet rejects FACET_ABORTED, the next call starts it fresh
//     with its storage, and the context's incarnation is the same
//   • a rewrite rule masks `abort` like any name; a jail's bare null takes both verbs away
import { expect, test } from "vitest";
import { errorCode } from "iterate/next/lib";
import { freshCtx, openItx, readAll, rejection, sleep } from "./support/client.ts";
import { oauthSession } from "./support/principal.ts";
import { freshDnsSafeProjectSlug, registerProject } from "./support/project-host.ts";

const ABORTED = "events.iterate.com/context/aborted";
/** A loaded worker that says whatever the test hands it through its own `env.ITX` — loaded code. */
const SAY = {
  "cap.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class extends WorkerEntrypoint {
  async say(call) {
    const itx = this.env.ITX.get();
    try { return { ok: await itx.invoke(call) }; }
    catch (e) { return { error: String((e && e.message) || e) }; }
    finally { itx[Symbol.dispose]?.(); }
  }
}`,
};

/** A facet with memory that dies with its instance, storage that does not, and a call that never
 *  answers. */
const COUNTER = {
  source: {
    "cap.js": `import { FacetDurableObject } from "./processor.js";
export class CounterDurableObject extends FacetDurableObject {
  static publicMethods = [...super.publicMethods, "bump", "hang"];
  inMemory = 0;
  async bump() {
    this.inMemory += 1;
    const durable = ((await this.ctx.storage.get("n")) ?? 0) + 1;
    await this.ctx.storage.put("n", durable);
    return { inMemory: this.inMemory, durable };
  }
  hang() { return new Promise(() => {}); }
}`,
  },
  className: "CounterDurableObject",
};

test("itx.abort() resolves for its caller with the durable fact; the next call wakes a fresh incarnation over the same log, tables and kv", async () => {
  const ctx = freshCtx("abort");
  const itx = openItx(ctx);
  await itx.append({ type: "note", payload: { n: 1 } });
  await itx.append({
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: { match: "itx.me", target: "itx.whoami" },
  });
  await itx.kv.put("k", "kept");
  const wakesBefore = wakes(await readAll(itx));

  const aborted = await itx.abort("e2e: reset on request");
  expect(aborted).toMatchObject({
    type: ABORTED,
    path: "/",
    payload: { reason: "e2e: reset on request" },
    source: { principal: { actor: "admin" } },
  });

  // THE NEXT CALL is a fresh incarnation's: one more wake, after the fact.
  expect(await itx.me()).toEqual({ projectId: ctx, path: "/" }); // a durable rule, reduced again
  const events = await readAll(itx);
  expect(wakes(events)).toBe(wakesBefore + 1);
  const at = events.findIndex((event) => event.type === ABORTED);
  expect(events[at]).toMatchObject({
    offset: aborted.offset,
    payload: { reason: "e2e: reset on request" },
  });
  expect(wakes(events.slice(at))).toBe(1);
  expect(events.some((event) => event.type === "note")).toBe(true);
  expect(await itx.kv.get("k")).toBe("kept");
  // …and nothing else resets it: a call now is the same incarnation.
  await itx.whoami();
  expect(wakes(await readAll(itx))).toBe(wakesBefore + 1);
});

test("cd(path).abort() resets that context only — through the root's own cd too, the root's incarnation untouched", async () => {
  const root = openItx(freshCtx("abort_child"));
  const child = root.cd("/child");
  await Promise.all([root.whoami(), child.whoami()]);
  const [rootWakes, childWakes] = [wakes(await readAll(root)), wakes(await readAll(child))];

  // A DO → DO hop: the root's built-in `cd` carries the call to the child, which answers first.
  const aborted = await root.invoke("itx.cd('/child').abort('child only')");
  expect(aborted).toMatchObject({
    type: ABORTED,
    path: "/child",
    payload: { reason: "child only", callerPath: "/" },
  });
  await child.whoami();
  expect(wakes(await readAll(child))).toBe(childWakes + 1);
  // The edge's own `cd` addresses the child directly: the same reset, with no hop to name.
  // oxlint-disable-next-line iterate/prefer-object-property-match -- exact: a direct abort names no reason and no caller hop
  expect((await child.abort()).payload).toEqual({});
  await child.whoami();
  expect(wakes(await readAll(child))).toBe(childWakes + 2);

  const rootEvents = await readAll(root);
  expect(wakes(rootEvents)).toBe(rootWakes);
  expect(rootEvents.some((event) => event.type === ABORTED)).toBe(false);
});

test("a waitForEvent pending on the reset context rejects for its waiter with the reset's message", async () => {
  const itx = openItx(freshCtx("abort_waiter"));
  await itx.whoami();
  const waiting = itx.waitForEvent({ type: "e2e/never-lands", timeoutMs: 60_000 });
  waiting.catch(() => undefined);
  await sleep(1_000); // the wait is registered in this incarnation
  await itx.abort("the waiter goes too");
  const error = await rejection(waiting, "the pending wait");
  expect(error.message).toMatch(/itx\.abort\(\) reset the context \/: the waiter goes too/);
});

test("scope: a user's session aborts only the projects it reaches — another project's id is FORBIDDEN, a path spelling another project's name is a path of its own", async () => {
  const slug = freshDnsSafeProjectSlug("abort-scope");
  const member = { email: `${slug}@example.com` };
  const projectId = await registerProject(slug, member);
  // The deployment's own org: the member belongs to none of it.
  const otherId = await registerProject(freshDnsSafeProjectSlug("abort-other"));
  const { api, principal } = await oauthSession(projectId, member);

  expect(errorCode(await rejection(api.projects.get(otherId).abort("reach")))).toBe("FORBIDDEN");
  // `cd` resolves a PATH of the project the handle holds; the other project's own context name is
  // just a path here, and the reset lands in this project, attributed to the member.
  const spelled = api.projects.get(projectId).cd(`/${otherId}.iterate/`);
  expect(await spelled.whoami()).toMatchObject({ projectId, path: `/${otherId}.iterate` });
  expect(await spelled.abort("spelled")).toMatchObject({
    type: ABORTED,
    path: `/${otherId}.iterate`,
    source: { principal },
  });
  expect((await readAll(openItx(otherId))).some((event) => event.type === ABORTED)).toBe(false);
});

test("scope: loaded code aborts its own context and those below it, never above — cd goes down only, itx.builtins is not its word", async () => {
  const root = openItx(freshCtx("abort_app"));
  const worker = () => root.cd("/x").workers.get({ source: SAY });
  for (const up of ["itx.cd('/').abort('up')", "itx.cd('..').abort('up')"])
    expect(await worker().say(up)).toMatchObject({
      error: expect.stringMatching(/goes down only/),
    });
  expect(await worker().say("itx.cd('/').facets.abort('project')")).toMatchObject({
    error: expect.stringMatching(/goes down only/),
  });
  expect(await worker().say("itx.builtins.abort('fixed point')")).toMatchObject({
    error: expect.stringMatching(/not a loaded worker's word/),
  });
  // Below its own context it may: the fact says loaded code asked, and from where.
  expect(await worker().say("itx.cd('./y').abort('down')")).toMatchObject({
    ok: { type: ABORTED, path: "/x/y", payload: { reason: "down", callerPath: "/x", app: true } },
  });
  for (const itx of [root, root.cd("/x")])
    expect((await readAll(itx)).some((event) => event.type === ABORTED)).toBe(false);
});

test("itx.facets.abort(name) resets that facet from the host: a call hung on it rejects FACET_ABORTED, the next call starts it fresh with its storage, and the context's incarnation is the same", async () => {
  const itx = openItx(freshCtx("abort_facet"));
  const counter = () => itx.facets.get("counter", COUNTER);
  expect(await counter().bump()).toEqual({ inMemory: 1, durable: 1 });
  expect(await counter().bump()).toEqual({ inMemory: 2, durable: 2 });
  const hung = counter().hang();
  hung.catch(() => undefined);
  await sleep(500); // the call is on the facet
  const wakesBefore = wakes(await readAll(itx));

  expect(await itx.facets.abort("counter", "stuck")).toMatchObject({
    type: "events.iterate.com/context/facet-aborted",
    path: "/",
    payload: { name: "counter", reason: "stuck" },
    source: { principal: { actor: "admin" } },
  });
  const cutOff = await rejection(hung, "the hung call");
  expect(errorCode(cutOff)).toBe("FACET_ABORTED");
  expect(cutOff.message).toMatch(/facet "counter" was aborted: stuck/);
  // A fresh instance (its memory at zero) over the same storage, addressed by bare name (the memo).
  expect(await itx.facets.get("counter").bump()).toEqual({ inMemory: 1, durable: 3 });
  expect(wakes(await readAll(itx))).toBe(wakesBefore);

  expect(errorCode(await rejection(itx.facets.abort("never-hosted")))).toBe("NO_FACET");
  expect((await rejection(itx.facets.abort("core"))).message).toMatch(/core reduce/);
});

test("a rewrite rule masks abort like any name, a jail's bare null takes both verbs away, and the physical itx.builtins.abort stays the session's", async () => {
  const root = openItx(freshCtx("abort_mask"));
  await root.provide("itx.abort", null);
  expect((await rejection(root.abort("masked"))).message).toMatch(/is masked/);

  const jail = root.cd("/jail");
  await jail.provide("itx", null);
  expect(errorCode(await rejection(jail.abort("jailed")))).toBe("NO_ITX_EXPRESSION_MATCH");
  expect(errorCode(await rejection(jail.facets.abort("secret")))).toBe("NO_ITX_EXPRESSION_MATCH");
  // Loaded code that reaches the jail meets the jail's table.
  expect(await root.workers.get({ source: SAY }).say("itx.cd('./jail').abort()")).toMatchObject({
    error: expect.stringMatching(/is masked/),
  });
  const jailPage = await jail.builtins.readEvents(0, 500);
  expect(jailPage.events.some((event: { type: string }) => event.type === ABORTED)).toBe(false);
  expect((await readAll(root)).some((event) => event.type === ABORTED)).toBe(false);

  // Rules govern names; the session holds the project, and its physical spelling is not a name.
  expect(await root.builtins.abort("physical")).toMatchObject({
    type: ABORTED,
    payload: { reason: "physical" },
  });
});

/** One `stream/woken` per incarnation: the count is how many times the context started. */
const wakes = (events: { type: string }[]) =>
  events.filter((event) => event.type === "events.iterate.com/stream/woken").length;
