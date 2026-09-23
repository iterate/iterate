// e2e/context-residency.e2e.test.ts — A HANDLE IS A PATH, NOT A LEASE ON THE ACTOR.
//
// What a client holds must never keep a context Durable Object resident. Capabilities lent INTO a
// context (a subscribe callback, a device's provide) are borrowed stubs the DO releases after 30 s
// idle and re-pages on the next use (measured 2026-09-16). But a handle the context hands OUT —
// `repos.get(path)`, `cd(path)`, `facets.get(name)`: an `InvokeHandle` / `FacetHandle` minted INSIDE
// the DO (library.ts `entityHandle`) — crosses the edge as a live Workers-RPC stub and keeps its
// inbound session open for as long as the client keeps it: the actor stays resident and billed
// (prd 2026-09-22: ~125 such sessions parked around the clock, 10.8M wall-seconds against 637 s of
// CPU a day). These handles carry no state — the path is the reference — so the edge can mint them
// itself and send each verb as one dotted expression the DO resolves from scratch.
//
// Each row holds one such handle across three 12 s idles and reads the context's log: every
// incarnation appends one `stream/woken` on wake, so an actor evicted between reads shows three or
// more wakes, exactly as the control row that holds nothing does. The handle must still answer at
// the end: a path outlives every incarnation.
//
// Wakes see the CONTEXT only. A facet it hosts can outlive it: the context is evicted on time and
// the facet runs on, billed, until the next incarnation's birth resets it — a loaded facet holding
// no claim (FacetHost `resetUnclaimedLoadedFacets`). The careless rows and the rows at the bottom
// read the facet's own start as well.
import { expect, test } from "vitest";
import {
  adminCredentials,
  disposeSessions,
  freshCtx,
  openItx,
  readAll,
  rejection,
  runId,
  session,
  sleep,
  until,
  workerSlot,
} from "./support/client.ts";
import {
  deployedOnly,
  fetchProjectUrl,
  freshDnsSafeProjectSlug,
  projectUrl,
} from "./support/project-host.ts";
import { SOURCES } from "./support/sources.ts";

const IDLES = 3;
const IDLE_MS = 12_000; // the platform evicts an idle actor in ~10 s (measured 2026-09-22: 0/6 at 10 s, 48/48 at 12 s+)

/** Wake the context IDLES times with an idle gap between, then count its incarnations. */
async function wakesAcrossIdles(itx: any): Promise<number> {
  for (let i = 0; i < IDLES; i++) {
    await sleep(IDLE_MS);
    await itx.whoami();
  }
  const events = await readAll(itx);
  return events.filter((event: any) => event.type === "events.iterate.com/stream/woken").length;
}

/** The handle still answers after the actor was evicted underneath it — never a dead-stub error. */
const stillAnswers = (call: () => Promise<unknown>) =>
  call().then(
    () => "answered",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

test("control: a session holding only the context handle is evicted between idle reads", async () => {
  const itx = openItx(freshCtx("residency_control"));
  await itx.whoami();
  expect(await wakesAcrossIdles(itx)).toBeGreaterThanOrEqual(IDLES);
}, 90_000);

test("a held repos.get(path) handle does not keep the context resident", async () => {
  const itx = openItx(freshCtx("residency_repo"));
  await itx.whoami();
  const repo = await itx.repos.get("/repos/residency");
  expect(await wakesAcrossIdles(itx)).toBeGreaterThanOrEqual(IDLES);
  expect(await stillAnswers(() => repo.tip())).not.toMatch(
    /Session|closed|RPC_STUB_OFFLINE|disposed/i,
  );
}, 90_000);

test("a held workspaces.get(path) handle does not keep the context resident", async () => {
  const itx = openItx(freshCtx("residency_workspace"));
  await itx.whoami();
  const workspace = await itx.workspaces.get("/workspaces/residency");
  expect(await wakesAcrossIdles(itx)).toBeGreaterThanOrEqual(IDLES);
  expect(await stillAnswers(() => workspace.listFiles())).not.toMatch(
    /Session|closed|RPC_STUB_OFFLINE|disposed/i,
  );
}, 90_000);

// `cd` is already answered at the edge with a path wrapper (iterate-context.ts): the guard that
// keeps it so.
test("a held cd(path) handle does not keep the context resident", async () => {
  const itx = openItx(freshCtx("residency_cd"));
  await itx.whoami();
  const child = await itx.cd("/residency");
  expect(await wakesAcrossIdles(itx)).toBeGreaterThanOrEqual(IDLES);
  expect(await stillAnswers(() => child.whoami())).not.toMatch(
    /Session|closed|RPC_STUB_OFFLINE|disposed/i,
  );
}, 90_000);

// A SCRIPT'S RESULT crosses Workers RPC from its loaded isolate into the context's runner, and a live
// value in it (a function) arrives as a stub. The runner releases it once serialized (library.ts
// `runSettlementOf`); dropped undisposed, it held the context (__workers-tests__/context-runs.test.ts).
test("a run whose script returned a live value does not keep its context resident", async () => {
  const itx = openItx(freshCtx("residency_run_result"));
  expect(await itx.run("async () => ({ n: 1, f: () => 1 })")).toEqual({ n: 1 });
  expect(await wakesAcrossIdles(itx)).toBeGreaterThanOrEqual(IDLES);
}, 90_000);

// A FACET reaches its own context the other way round: through the SDK's `withItx` on the loopback
// entrypoint — the repo facet's `itx.cfArtifacts.get(path).remote()`, the collection's
// `itx.cd(path)…waitForEvent`. A step such a round trip left holding the context's session kept
// facet → ItxEntrypoint → context resident UNTIL THE NEXT DEPLOY (every project an os-next preview's
// e2e run created stayed billed for hours, 2026-09-21/22); the context now ends that session with
// the call. What `withItx` leaves undisposed keeps the FACET running instead, so it releases every
// call (the rows at the bottom).
let repoCounter = 0;
/** A repo born through the collection and read through its facet, then the client's session closed:
 *  what stays behind is the platform's own doing, not a handle this test holds. */
async function repoBornAndRead(prefix: string): Promise<{ ctx: string; path: string }> {
  const ctx = freshCtx(prefix);
  // Per run and per worker process, inside Artifacts' name grammar (cfartifacts.e2e.test.ts).
  const path = `/e2e/residency-${runId()}-${workerSlot()}-${repoCounter++}`;
  const itx = openItx(ctx);
  expect(await itx.repos.create(path)).toEqual({ path });
  expect(await itx.repos.get(path).tip()).toBeNull(); // the facet's remote + token, via withItx
  disposeSessions();
  return { ctx, path };
}

test("a repo read through its facet does not keep its own context resident", async () => {
  const { ctx, path } = await repoBornAndRead("residency_facet");
  const itx = openItx(ctx);
  try {
    expect(await wakesAcrossIdles(await itx.cd(path))).toBeGreaterThanOrEqual(IDLES);
  } finally {
    await itx.cfArtifacts.delete(path); // teardown — the repo, by its path
  }
}, 120_000);

// The root answers `repos.create` / `repos.list` by walking `facets.get('project').repos().create(…)`:
// the collection stub the facet answers `repos()` with is walked on, never answered — the resolver
// releases it once the answer is in (itx-expression-rewriting.ts `invoke`). Kept, it held the project
// facet and so the root resident (~2 min after a create; until the next deploy before #2846).
test("creating a repo does not keep the project root resident", async () => {
  const { ctx, path } = await repoBornAndRead("residency_root");
  const itx = openItx(ctx);
  try {
    expect(await wakesAcrossIdles(itx)).toBeGreaterThanOrEqual(IDLES);
  } finally {
    await itx.cfArtifacts.delete(path);
  }
}, 120_000);

test("listing repos does not keep the project root resident", async () => {
  const ctx = freshCtx("residency_list");
  expect(await openItx(ctx).repos.list()).toEqual(expect.any(Array));
  disposeSessions();
  expect(await wakesAcrossIdles(openItx(ctx))).toBeGreaterThanOrEqual(IDLES);
}, 90_000);

// ── CARELESS CALLERS: a context's inbound session ends with the call, whatever the caller keeps ──
// Userspace code will never dispose correctly, so residency must not rest on it: the context
// enforces the rule itself, at its RPC `invoke` (expression.ts `itxAnswerDetachedFromSession`). The
// holders below are DELIBERATELY CARELESS — they are the test subject: each keeps everything
// `env.ITX` handed it, in a facet of the context (an actor that outlives the call), and disposes
// nothing. Measured on a preview of main (2026-09-23): the data row, the live row and the client
// row saw ONE wake across the three idles — resident throughout; the LiveState row already evicted.
// The careless facet itself kept running on what it kept, billed per minute under the context's
// object with no request, until V8 happened to collect it (19 min and counting, measured) — so
// each row also reads the facet's own start: the next incarnation's birth resets it (it is loaded
// and holds no claim), and a fresh instance answers.

/** A loaded worker whose answer is DATA — `{ a: 1 }`, handed through the context to the facet. */
const DATA_WORKER_SOURCE = {
  "cap.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class Data extends WorkerEntrypoint { data() { return { a: 1 }; } }`,
};
/** A loaded worker whose answer is LIVE — an RpcTarget, a new one per `make()`. */
const LIVE_WORKER_SOURCE = {
  "cap.js": `import { WorkerEntrypoint, RpcTarget } from "cloudflare:workers";
let made = 0;
class Made extends RpcTarget {
  constructor(n) { super(); this.n = n; }
  ping() { return "pong-" + this.n; }
}
export default class LiveMaker extends WorkerEntrypoint { make() { made += 1; return new Made(made); } }`,
};
/** The careless holder, the Keeper fixture's manners (support/sources.ts): it keeps its `env.ITX`
 *  scope and every answer, and releases none of them. */
const CARELESS_HOLDER_SOURCE = {
  "cap.js": `import { FacetDurableObject } from "./processor.js";
export class CarelessHolderDurableObject extends FacetDurableObject {
  static publicMethods = [...super.publicMethods, "keepData", "keepSiblingSnapshot", "keepLiveAndPing"];
  kept = [];
  startedAt = Date.now();
  started() { return this.startedAt; }
  async keepData(source) {
    const itx = this.env.ITX.get();
    const answer = await itx.workers.get({ source }).data();
    this.kept.push(itx, answer);
    return JSON.stringify(answer); // never the answer itself: returning it would hand its release on
  }
  async keepSiblingSnapshot(path) {
    const itx = this.env.ITX.get();
    const answer = await itx.cd(path).facets.get("core").snapshot();
    this.kept.push(itx, answer);
    return typeof answer;
  }
  async keepLiveAndPing(source) {
    const itx = this.env.ITX.get();
    const made = await itx.workers.get({ source }).make();
    this.kept.push(itx, made);
    return await made.ping();
  }
}`,
};
const carelessHolder = (itx: any, method: string, ...args: unknown[]) =>
  itx.invoke([
    "itx",
    "facets",
    [
      "get",
      "careless",
      { source: CARELESS_HOLDER_SOURCE, className: "CarelessHolderDurableObject" },
    ],
    [method, ...args],
  ]);

test("a facet keeping a loaded worker's data answer its context handed through keeps neither the context nor itself running", async () => {
  const itx = openItx(freshCtx("residency_careless_data"));
  expect(await carelessHolder(itx, "keepData", DATA_WORKER_SOURCE)).toBe('{"a":1}');
  const started = await carelessHolder(itx, "started");
  expect(await wakesAcrossIdles(itx)).toBeGreaterThanOrEqual(IDLES);
  expect(await carelessHolder(itx, "started")).toBeGreaterThan(started);
}, 90_000);

test("a facet keeping a loaded worker's live RpcTarget keeps neither the context nor itself running", async () => {
  const itx = openItx(freshCtx("residency_careless_live"));
  // A live answer leaves the context as the expression that made it: every verb re-runs `make()`
  // (the risk the rule accepts — identity per verb), so the ping answers from a fresh `Made`.
  expect(await carelessHolder(itx, "keepLiveAndPing", LIVE_WORKER_SOURCE)).toMatch(/^pong-\d+$/);
  const started = await carelessHolder(itx, "started");
  expect(await wakesAcrossIdles(itx)).toBeGreaterThanOrEqual(IDLES);
  expect(await carelessHolder(itx, "started")).toBeGreaterThan(started);
}, 90_000);

// The prd shape (a project site's page load, 2026-09-23): loaded code asks its ROOT for a sibling's
// facet snapshot, `env.ITX.get().cd('/domain-sales').facets.get(x).snapshot()`. The root's `cd`
// invokes the sibling, whose answer is data from that hop; forwarded as it arrived, it kept the
// root resident (sessions 142–2424 s) — and the sibling with it.
test("a facet keeping a sibling's data answer, handed through the root's cd, keeps neither context nor itself running", async () => {
  const itx = openItx(freshCtx("residency_careless_sibling"));
  expect(await carelessHolder(itx, "keepSiblingSnapshot", "/residency-sibling")).toBe("object");
  const started = await carelessHolder(itx, "started");
  const [root, sibling] = await Promise.all([
    wakesAcrossIdles(itx),
    wakesAcrossIdles(await itx.cd("/residency-sibling")),
  ]);
  expect(Math.min(root, sibling), JSON.stringify({ root, sibling })).toBeGreaterThanOrEqual(IDLES);
  expect(await carelessHolder(itx, "started")).toBeGreaterThan(started);
}, 90_000);

// LiveState's documented sink (sdk/index.ts): `{ append: (e) => env.ITX.get().append(e) }` — a fresh
// scope per `set`, and neither it nor the append's answer is ever released. The chatroom's live
// state is built with it, so its revision (`rev`, the start time × 4096) names the instance.
test("the LiveState sink that never releases env.ITX keeps neither the context nor its facet running", async () => {
  const itx = openItx(freshCtx("residency_live_state_sink"));
  const chatroom = (method: string, ...args: unknown[]) =>
    itx.invoke([
      "itx",
      "facets",
      ["get", "chatroom", { source: SOURCES.chatroom, className: "ChatroomDurableObject" }],
      [method, ...args],
    ]);
  expect(await chatroom("post", "careless", "hi")).toEqual({ ok: true });
  const started = Math.floor((await chatroom("state")).rev / 4096);
  expect(await wakesAcrossIdles(itx)).toBeGreaterThanOrEqual(IDLES);
  const again = await chatroom("state");
  expect(Math.floor(again.rev / 4096)).toBeGreaterThan(started);
  expect(again.state).toEqual({ messages: [] }); // in memory, as it always was: gone with the instance
}, 90_000);

// The Keeper (support/sources.ts) stashes its `env.ITX` in its own storage and calls through the
// restored one without releasing what it answers.
test("a facet calling through a stashed env.ITX does not outlive its context", async () => {
  const itx = openItx(freshCtx("residency_keeper"));
  const keeper = (method: string) =>
    itx.invoke([
      "itx",
      "facets",
      ["get", "keeper", { source: SOURCES.keeper, className: "KeeperDurableObject" }],
      [method],
    ]);
  expect(await keeper("stash")).toEqual({ stashed: true });
  expect((await keeper("useStashed")).projectId).toEqual(expect.any(String));
  const started = await keeper("started");
  expect(await wakesAcrossIdles(itx)).toBeGreaterThanOrEqual(IDLES);
  expect(await keeper("started")).toBeGreaterThan(started);
}, 90_000);

// A CLIENT is careless the same way: a held `cfArtifacts.get(path)` was the scoped repo RpcTarget,
// live across /api for as long as the socket lived.
deployedOnly(
  "a client holding itx.cfArtifacts.get(path) does not keep the context resident",
  async () => {
    const itx = openItx(freshCtx("residency_cfartifacts"));
    const path = `/e2e/residency-${runId()}-${workerSlot()}-${repoCounter++}`;
    expect(await itx.cfArtifacts.create(path)).toEqual({ created: true });
    try {
      const repo = await itx.cfArtifacts.get(path);
      expect(await wakesAcrossIdles(itx)).toBeGreaterThanOrEqual(IDLES);
      expect(await stillAnswers(() => repo.remote())).toBe("answered");
    } finally {
      await itx.cfArtifacts.delete(path);
    }
  },
  120_000,
);

// ── A FACET DOES NOT OUTLIVE ITS CONTEXT ──
// A facet holding ANY Workers-RPC value from its `env.ITX` round trips — a pipelined step, an answer
// it awaited — keeps running after its context is evicted, until V8 collects the value: each new
// incarnation reattaches to it, and the object stays billed. Wakes cannot see it (the context
// evicts on time), so these rows read the facet's own birth: its live state is built when it starts
// (`liveSnapshot().rev` is that moment × 4096, stream/processor.ts `LiveState`). Measured 2026-09-23
// on previews of main: after one page load a website project's `/` and `/repos/config` were billed
// every minute with no request until the next deploy; both rows below failed there, the facets'
// births unchanged across three evictions, and pass once `withItx` releases every call.

/** When the facet started — the construction time its live state's revision counts from. */
const facetStartedAt = async (facet: any): Promise<number> =>
  Math.floor((await facet.liveSnapshot()).rev / 4096);

test("a website project's facets do not outlive their contexts after a page load", async () => {
  const slug = freshDnsSafeProjectSlug("residency-site");
  const root = await session().authenticate(adminCredentials()).projects.create({ project: slug });
  const { projectId } = await root.whoami();
  await until(
    "project/created",
    async () =>
      (await readAll(root)).find((e: any) => e.type === "events.iterate.com/project/created"),
    60_000,
  );
  disposeSessions();
  // The prd shape: a visitor's page load — the root loads the config worker, whose source the repo
  // facet on /repos/config answers — and the two facets it woke.
  const page = await fetchProjectUrl(projectUrl({ project: slug, path: "/" }));
  expect(page.text.trim()).toBe(`Homepage of project ${slug}`);
  const itx = openItx(projectId);
  const started = {
    project: await facetStartedAt(itx.facets.get("project")),
    repo: await facetStartedAt(itx.repos.get("/repos/config")),
  };
  disposeSessions();
  const wakes = await Promise.all([
    wakesAcrossIdles(openItx(projectId)),
    wakesAcrossIdles(openItx(projectId).cd("/repos/config")),
  ]);
  expect(Math.min(...wakes), JSON.stringify(wakes)).toBeGreaterThanOrEqual(IDLES);
  const again = openItx(projectId);
  expect(await facetStartedAt(again.facets.get("project"))).toBeGreaterThan(started.project);
  expect(await facetStartedAt(again.repos.get("/repos/config"))).toBeGreaterThan(started.repo);
}, 120_000);

/** An SDK facet that reaches its context the way the platform's own facets do: a pipelined chain
 *  (the repo facet's `cfArtifacts.get(path).remote()`), and answers awaited inside the round trip
 *  (the collection's `const context = itx.cd(path)`). */
const REACHER_SOURCE = {
  "cap.js": `import { StreamProcessor, StreamProcessorDurableObject, defineProcessorContract, z } from "./processor.js";
const contract = defineProcessorContract({
  slug: "reacher",
  version: "1.0.0",
  description: "Reaches its context through withItx, the platform's shapes.",
  stateSchema: z.object({}),
  consumes: [],
  emits: [],
});
class ReacherProcessor extends StreamProcessor {
  contract = contract;
  reduce() {}
}
export class ReacherDurableObject extends StreamProcessorDurableObject {
  static publicMethods = [...super.publicMethods, "reach"];
  processor = new ReacherProcessor();
  async reach(path) {
    await this.withItx((itx) => itx.cd(path).whoami());
    await this.withItx(async (itx) => {
      const child = itx.cd(path);
      await child.whoami();
      return child.whoami();
    });
  }
}`,
};

test("an SDK facet that reached its context through withItx does not outlive the context", async () => {
  const ctx = freshCtx("residency_sdk_facet");
  const reacher = (itx: any) =>
    itx.facets.get("reacher", { source: REACHER_SOURCE, className: "ReacherDurableObject" });
  const itx = openItx(ctx);
  await reacher(itx).reach("/child");
  const started = await facetStartedAt(reacher(itx));
  disposeSessions();
  expect(await wakesAcrossIdles(openItx(ctx))).toBeGreaterThanOrEqual(IDLES);
  expect(await facetStartedAt(reacher(openItx(ctx)))).toBeGreaterThan(started);
}, 90_000);

// ── CLAIMED WORK OUTLIVES ITS CONTEXT ON PURPOSE ──
// Work that must outlive the call that started it runs through `runInBackground`: the processor's
// claim on the context's alarm keeps the facet running across the context's incarnations — the
// claim's alarm wakes one mid-attempt, whose birth spares the claimed facet (FacetHost
// `resetUnclaimedLoadedFacets`) — and the attempt finishes on the instance that started it.
const SLEEPER_SOURCE = {
  "cap.js": `import { StreamProcessor, StreamProcessorDurableObject, defineProcessorContract, z } from "./processor.js";
const contract = defineProcessorContract({
  slug: "sleeper",
  version: "1.0.0",
  description: "Sleeps in the background, then says which instance slept.",
  stateSchema: z.object({}),
  consumes: ["sleep"],
  emits: ["slept"],
});
class SleeperProcessor extends StreamProcessor {
  contract = contract;
  startedAt = Date.now();
  reduce() {}
  processEvent({ event, append, runInBackground }) {
    if (event?.type !== "sleep") return;
    runInBackground(async () => {
      await new Promise((resolve) => setTimeout(resolve, event.payload.ms));
      await append({ type: "slept", payload: { startedAt: this.startedAt }, idempotencyKey: "slept:" + event.offset });
    });
  }
}
export class SleeperDurableObject extends StreamProcessorDurableObject {
  processor = new SleeperProcessor();
}`,
};

test("a facet's claimed background work finishes on the instance that started it across its context's incarnations", async () => {
  const ctx = freshCtx("residency_claimed");
  const itx = openItx(ctx);
  await itx.processors.enable("sleeper", {
    source: SLEEPER_SOURCE,
    className: "SleeperDurableObject",
  });
  const started = await facetStartedAt(itx.facets.get("sleeper"));
  await itx.append({ type: "sleep", payload: { ms: 45_000 } });
  disposeSessions();
  await sleep(60_000); // no request meanwhile: a poll would keep the context resident
  const slept = await until(
    "the background sleep's append",
    async () => (await readAll(openItx(ctx))).find((e: any) => e.type === "slept"),
    30_000,
  );
  const woken = (await readAll(openItx(ctx))).filter(
    (e: any) => e.type === "events.iterate.com/stream/woken" && e.offset < slept.offset,
  );
  // The claim's alarm woke the context mid-sleep (20 s, then the revive's 40 s), each birth sparing
  // the claimed facet; the append came from the instance the sleep started on.
  expect(woken.length).toBeGreaterThanOrEqual(2);
  expect(Math.abs(slept.payload.startedAt - started)).toBeLessThan(5_000);
  expect(woken.every((e: any) => !e.payload.facetsReset?.includes("sleeper"))).toBe(true);
}, 150_000);

// ── A REFUSAL DOES NOT HOLD THE CONTEXT ──
// A Workers-RPC call that THREW keeps its session to the callee open until the caller disposes its
// promise: workerd drops a call's pipeline when an answer arrives, never when an exception does. The
// callee here is a facet, and the context hosting it stays resident, billed, until V8 collects the
// promise. Measured 2026-09-23 after a full e2e run: every delete flow's contexts, and the roots
// whose collection refused, were still on their first incarnation 20 minutes later. The context
// releases a rejected answer (expression.ts `awaitAnswerReleasedIfRejected`). Each row reads the
// context's wakes and, since a facet can outlive its context, the facet's own start.

test("a deleted workspace's refusal keeps neither its context nor its facet resident", async () => {
  const ctx = freshCtx("residency_refused_verb");
  const path = "/workspaces/gone";
  const itx = openItx(ctx);
  expect(await itx.workspaces.create(path)).toEqual({ path });
  expect(await itx.workspaces.delete(path)).toEqual({ path });
  // the facet itself refuses: facet-host.ts `#call`
  expect((await rejection(itx.workspaces.get(path).mounts())).message).toMatch(/deleted/);
  const started = await facetStartedAt(itx.cd(path).facets.get("workspace"));
  disposeSessions();
  expect(await wakesAcrossIdles(openItx(ctx).cd(path))).toBeGreaterThanOrEqual(IDLES);
  expect(await facetStartedAt(openItx(ctx).cd(path).facets.get("workspace"))).toBeGreaterThan(
    started,
  );
}, 90_000);

test("a collection's refusal keeps neither the project root nor its project facet resident", async () => {
  const ctx = freshCtx("residency_refused_collection");
  const itx = openItx(ctx);
  // the collection stub the project facet answers `workspaces()` with refuses: the resolver's walk
  expect((await rejection(itx.workspaces.delete("/workspaces/never"))).message).toMatch(
    /not created — nothing to delete/,
  );
  const started = await facetStartedAt(itx.facets.get("project"));
  disposeSessions();
  expect(await wakesAcrossIdles(openItx(ctx))).toBeGreaterThanOrEqual(IDLES);
  expect(await facetStartedAt(openItx(ctx).facets.get("project"))).toBeGreaterThan(started);
}, 90_000);
