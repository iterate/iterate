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
// incarnation appends one `itx/woken` on wake, so an actor evicted between reads shows three or
// more wakes, exactly as the control row that holds nothing does. The handle must still answer at
// the end: a path outlives every incarnation.
//
// Wakes see the CONTEXT only. A facet it hosts can outlive it: the context is evicted on time and
// the facet runs on, billed, until the next incarnation's birth resets it — a loaded facet holding
// no claim (FacetHost `resetUnclaimedLoadedFacets`). The careless rows and the rows at the bottom
// read the facet's own start as well.
//
// WHAT THESE ROWS ASSERT is what the platform code decides: a wake, a reset named on a wake record,
// and a careless facet no longer running once its quiet minute is up. What CLOUDFLARE decides — how
// long a facet the context no longer holds keeps running, whether a context stays resident under
// traffic — each row prints, and the opt-in perf/context-residency.perf.test.ts times alone. Here
// those numbers sampled the platform: a facet the platform stopped 0 s and 20 s after its call
// (#2939, #2899), a claimed facet stopped mid-attempt (#2921), a context evicted mid-traffic while
// the control plane stalled 12.8 s (#2899) — each green on its retry, in 3 of 124 e2e jobs.
//
// The three careless rows wait out real quiet minutes (110–180 s), so they are tagged `slow`
// (docs/testing.md#slow-rows): every main push runs them, and a PR runs them when it turns them on or
// edits this file. The claimed-work row waits out one claim's alarm (20 s) and runs on every PR.
import { expect, test } from "vitest";
import {
  adminCredentials,
  disposeSessions,
  EVICTION_IDLES,
  freshCtx,
  freshRepoPath,
  idleAcrossEvictions,
  openItx,
  readAll,
  rejection,
  session,
  sleep,
  until,
} from "./support/client.ts";
import {
  deployedOnly,
  fetchProjectUrl,
  freshDnsSafeProjectSlug,
  projectUrl,
} from "./support/project-host.ts";
import {
  CARELESS_CHATROOM_SOURCE,
  CHATTY_SOURCE,
  facetStartedAt,
  HEARTBEAT_SOURCE,
  RELEASER_SOURCE,
  SLEEPER_SOURCE,
} from "./support/residency-facets.ts";
import { SOURCES } from "./support/sources.ts";

test("control: a session holding only the context handle is evicted between idle reads", async () => {
  const itx = openItx(freshCtx("residency_control"));
  await itx.whoami();
  expect(await wakesAcrossIdles(itx)).toBeGreaterThanOrEqual(EVICTION_IDLES);
}, 90_000);

test("a held repos.get(path) handle does not keep the context resident", async () => {
  const itx = openItx(freshCtx("residency_repo"));
  await itx.whoami();
  const repo = await itx.repos.get("/repos/residency");
  expect(await wakesAcrossIdles(itx)).toBeGreaterThanOrEqual(EVICTION_IDLES);
  expect(await stillAnswers(() => repo.tip())).not.toMatch(
    /Session|closed|RPC_STUB_OFFLINE|disposed/i,
  );
}, 90_000);

test("a held workspaces.get(path) handle does not keep the context resident", async () => {
  const itx = openItx(freshCtx("residency_workspace"));
  await itx.whoami();
  const workspace = await itx.workspaces.get("/workspaces/residency");
  expect(await wakesAcrossIdles(itx)).toBeGreaterThanOrEqual(EVICTION_IDLES);
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
  expect(await wakesAcrossIdles(itx)).toBeGreaterThanOrEqual(EVICTION_IDLES);
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
  expect(await wakesAcrossIdles(itx)).toBeGreaterThanOrEqual(EVICTION_IDLES);
}, 90_000);

// A FACET reaches its own context the other way round: through the SDK's `withItx` on the loopback
// entrypoint — the repo facet's `itx.cfArtifacts.get(path).remote()`, the collection's
// `itx.cd(path)…waitForEvent`. A step such a round trip left holding the context's session kept
// facet → ItxEntrypoint → context resident UNTIL THE NEXT DEPLOY (every project an apps/os preview's
// e2e run created stayed billed for hours, 2026-09-21/22); the context now ends that session with
// the call. What `withItx` leaves undisposed keeps the FACET running instead, so it releases every
// call (the rows at the bottom).
test("a repo read through its facet does not keep its own context resident", async () => {
  const { ctx, path } = await repoBornAndRead("residency_facet");
  const itx = openItx(ctx);
  try {
    expect(await wakesAcrossIdles(await itx.cd(path))).toBeGreaterThanOrEqual(EVICTION_IDLES);
  } finally {
    await itx.cfArtifacts.delete(path); // teardown — the repo, by its path
  }
}, 90_000);

// The root answers `repos.create` / `repos.list` by walking `facets.get('project').repos().create(…)`:
// the collection stub the facet answers `repos()` with is walked on, never answered — the resolver
// releases it once the answer is in (itx-expression-rewriting.ts `invoke`). Kept, it held the project
// facet and so the root resident (~2 min after a create).
test("creating a repo does not keep the project root resident", async () => {
  const { ctx, path } = await repoBornAndRead("residency_root");
  const itx = openItx(ctx);
  try {
    expect(await wakesAcrossIdles(itx)).toBeGreaterThanOrEqual(EVICTION_IDLES);
  } finally {
    await itx.cfArtifacts.delete(path);
  }
}, 90_000);

test("listing repos does not keep the project root resident", async () => {
  const ctx = freshCtx("residency_list");
  expect(await openItx(ctx).repos.list()).toEqual(expect.any(Array));
  disposeSessions();
  expect(await wakesAcrossIdles(openItx(ctx))).toBeGreaterThanOrEqual(EVICTION_IDLES);
}, 90_000);

// ── CARELESS CALLERS: a context's inbound session ends with the call, whatever the caller keeps ──
// Userspace code will never dispose correctly, so residency must not rest on it: the context
// enforces the rule itself, at its RPC `invoke` (src/context/dispatch.ts `itxAnswerDetachedFromSession`). The
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
  "worker.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class Data extends WorkerEntrypoint { data() { return { a: 1 }; } }`,
};
/** A loaded worker whose answer is LIVE — an RpcTarget, a new one per `make()`. */
const LIVE_WORKER_SOURCE = {
  "worker.js": `import { WorkerEntrypoint, RpcTarget } from "cloudflare:workers";
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
  // oxlint-disable-next-line iterate/no-raw-itx-get -- the careless holder IS the subject: it keeps its env.ITX scope and every answer
  "worker.js": `import { FacetDurableObject } from "iterate/sdk";
export class CarelessHolderDurableObject extends FacetDurableObject {
  static publicMethods = [...super.publicMethods, "keepData", "keepSiblingSnapshot", "keepLiveAndPing", "started"];
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
test("a facet keeping a loaded worker's data answer its context handed through keeps neither the context nor itself running", async () => {
  const itx = openItx(freshCtx("residency_careless_data"));
  expect(await carelessHolder(itx, "keepData", DATA_WORKER_SOURCE)).toBe('{"a":1}');
  const started = await carelessHolder(itx, "started");
  expect(await wakesAcrossIdles(itx)).toBeGreaterThanOrEqual(EVICTION_IDLES);
  expect(await carelessHolder(itx, "started")).toBeGreaterThan(started);
}, 90_000);

test("a facet keeping a loaded worker's live RpcTarget keeps neither the context nor itself running", async () => {
  const itx = openItx(freshCtx("residency_careless_live"));
  // A live answer leaves the context as the expression that made it: every verb re-runs `make()`
  // (the risk the rule accepts — identity per verb), so the ping answers from a fresh `Made`.
  expect(await carelessHolder(itx, "keepLiveAndPing", LIVE_WORKER_SOURCE)).toMatch(/^pong-\d+$/);
  const started = await carelessHolder(itx, "started");
  expect(await wakesAcrossIdles(itx)).toBeGreaterThanOrEqual(EVICTION_IDLES);
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
  expect(Math.min(root, sibling), JSON.stringify({ root, sibling })).toBeGreaterThanOrEqual(
    EVICTION_IDLES,
  );
  expect(await carelessHolder(itx, "started")).toBeGreaterThan(started);
}, 90_000);

// LiveState's old documented sink, `{ append: (e) => env.ITX.get().append(e) }` — a fresh scope per
// `set`, and neither it nor the append's answer is ever released (support/residency-facets.ts
// CARELESS_CHATROOM_SOURCE). The chatroom's live state is built with it, so its revision (`rev`, the
// start time × 4096) names the instance.
test("the LiveState sink that never releases env.ITX keeps neither the context nor its facet running", async () => {
  const itx = openItx(freshCtx("residency_live_state_sink"));
  const chatroom = (method: string, ...args: unknown[]) =>
    itx.invoke([
      "itx",
      "facets",
      ["get", "chatroom", { source: CARELESS_CHATROOM_SOURCE, className: "ChatroomDurableObject" }],
      [method, ...args],
    ]);
  expect(await chatroom("post", "careless", "hi")).toEqual({ ok: true });
  const started = Math.floor((await chatroom("state")).rev / 4096);
  expect(await wakesAcrossIdles(itx)).toBeGreaterThanOrEqual(EVICTION_IDLES);
  const again = await chatroom("state");
  expect(Math.floor(again.rev / 4096)).toBeGreaterThan(started);
  expect(again).toMatchObject({ state: { messages: [] } }); // in memory, as it always was: gone with the instance
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
  expect(await keeper("useStashed")).toMatchObject({ projectId: expect.any(String) });
  const started = await keeper("started");
  expect(await wakesAcrossIdles(itx)).toBeGreaterThanOrEqual(EVICTION_IDLES);
  expect(await keeper("started")).toBeGreaterThan(started);
}, 90_000);

// A CLIENT is careless the same way: a held `cfArtifacts.get(path)` was the scoped repo RpcTarget,
// live across /api for as long as the socket lived.
deployedOnly(
  "a client holding itx.cfArtifacts.get(path) does not keep the context resident",
  async () => {
    const itx = openItx(freshCtx("residency_cfartifacts"));
    const path = freshRepoPath("residency");
    expect(await itx.cfArtifacts.create(path)).toEqual({ created: true });
    try {
      const repo = await itx.cfArtifacts.get(path);
      expect(await wakesAcrossIdles(itx)).toBeGreaterThanOrEqual(EVICTION_IDLES);
      expect(await stillAnswers(() => repo.remote())).toBe("answered");
    } finally {
      await itx.cfArtifacts.delete(path);
    }
  },
  90_000,
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
  expect(Math.min(...wakes), JSON.stringify(wakes)).toBeGreaterThanOrEqual(EVICTION_IDLES);
  const again = openItx(projectId);
  expect(await facetStartedAt(again.facets.get("project"))).toBeGreaterThan(started.project);
  expect(await facetStartedAt(again.repos.get("/repos/config"))).toBeGreaterThan(started.repo);
}, 90_000);

/** An SDK facet that reaches its context the way the platform's own facets do: a pipelined chain
 *  (the repo facet's `cfArtifacts.get(path).remote()`), and answers awaited inside the round trip
 *  (the collection's `const context = itx.cd(path)`). */
const REACHER_SOURCE = {
  "worker.js": `import { StreamProcessor, StreamProcessorDurableObject, defineProcessorContract, z } from "iterate/sdk";
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
  expect(await wakesAcrossIdles(openItx(ctx))).toBeGreaterThanOrEqual(EVICTION_IDLES);
  expect(await facetStartedAt(reacher(openItx(ctx)))).toBeGreaterThan(started);
}, 90_000);

// ── NOTHING NEEDS TO CALL AGAIN ──
// The next incarnation's birth resets what the last one left running — but after a context's LAST
// call nothing wakes it. A context that materialized a loaded facet arms the unclaimed-facet sweep
// on its alarm (FacetHost `UNCLAIMED_FACET_SWEEP_AFTER_QUIET_MS`): a minute after its last call it
// is woken fresh, and that birth resets the facet. The heartbeat (support/residency-facets.ts) keeps
// its `env.ITX` answer AND beats a timer into its own storage, so its last beat says when it
// stopped, with no call from here. That it stopped is the platform code's doing and asserted here;
// that it ran past its context's eviction until the sweep is Cloudflare's, printed here and timed
// in the opt-in perf file: here the platform stopped it 0 s and 20 s after its call (#2939, #2899),
// with no invocation of the context in between, which no reset of ours can do.

test(
  "a careless loaded facet the last call left running is no longer running a quiet minute later, with no call from outside",
  { tags: ["slow"], timeout: 180_000 },
  async () => {
    const ctx = freshCtx("residency_sweep");
    const heartbeat = (method: string) =>
      openItx(ctx).invoke([
        "itx",
        "facets",
        ["get", "heartbeat", { source: HEARTBEAT_SOURCE, className: "HeartbeatDurableObject" }],
        [method],
      ]);
    const lastCallAt = await heartbeat("beat");
    disposeSessions();
    await sleep(110_000); // no request: the context evicts in ~10 s; the sweep's alarm is its only wake
    const record = await heartbeat("beats");
    console.log(
      `[residency] the careless facet beat on ${record.lastBeat - lastCallAt} ms`,
      record,
    );
    // Stopped by the sweep a quiet minute after the call — or earlier, by the platform — and in either
    // case long before this call: a facet still beating here would beat until the next call's birth.
    expect(record.lastBeat - lastCallAt, JSON.stringify({ lastCallAt, ...record })).toBeLessThan(
      90_000,
    );
  },
);

// ── ONLY OUTSIDE ACTIVITY KEEPS A CONTEXT IN USE ──
// The sweep's quiet clock restarts on activity from outside the project's loaded code — a session,
// HTTP, MCP, a claim, an alarm pass — never on loaded code's own calls, which count only while in
// flight. A careless facet that calls its own context every few seconds keeps that context resident,
// so no birth would ever reset it; it is reset in place a quiet minute after the last outside call.
// That outside HTTP restarts the clock is decided in the Workers suite
// (__workers-tests__/facets.test.ts); that a context under 5 s of traffic keeps one
// instance is Cloudflare's, timed in the opt-in perf file: here that row saw two when the control
// plane stalled 12.8 s mid-traffic and the context, reached by nothing for 16 s, evicted (#2899).

test(
  "a careless loaded facet calling its own context every 5 s is no longer running a quiet minute and a half after the last outside call",
  { tags: ["slow"], timeout: 180_000 },
  async () => {
    const ctx = freshCtx("residency_chatty");
    expect(
      await openItx(ctx).invoke([
        "itx",
        "facets",
        ["get", "chatty", { source: CHATTY_SOURCE, className: "ChattyDurableObject" }],
        ["chatter"],
      ]),
    ).toBe("chattering");
    disposeSessions();
    await sleep(120_000); // no outside call: the facet's own appends are the context's only callers
    const chatter = (await readAll(openItx(ctx)))
      .filter((e: any) => e.type === "chatter")
      .map((e: any) => Date.parse(e.createdAt));
    console.log(`[residency] the chatty facet chattered ${chatter.at(-1)! - chatter[0]!} ms`);
    // Reset in place by the sweep a quiet minute in — or stopped earlier by the platform — and in
    // either case long before this read: a facet still chattering here would chatter forever.
    expect(chatter.at(-1)! - chatter[0]!, JSON.stringify(chatter)).toBeLessThan(90_000);
  },
);

// A CLAIM'S RELEASE is the last thing the facet's work did, so it arms the sweep again: the sweep
// may already have run — and disarmed — while the claim held the facet (the voice call that hangs up
// after a quiet minute is the real case). The releaser (support/residency-facets.ts) keeps its
// env.ITX answer and beats a timer into its own storage; its claim holds past the first sweep and is
// released at 70 s, so the sweep the release armed stops it at ~130 s. A release that armed nothing
// would leave it beating until this row's call at 180 s. That the claimed facet ran on through the
// first sweep, and that the release arms the next, the Workers suite decides; how long it ran is
// printed here and timed in the opt-in perf file.

test(
  "a careless facet whose claim ends is no longer running a quiet minute and a half after the release, though the sweep ran while the claim held it",
  { tags: ["slow"], timeout: 270_000 },
  async () => {
    const ctx = freshCtx("residency_released");
    const releaser = (method: string, ...args: unknown[]) =>
      openItx(ctx).invoke([
        "itx",
        "facets",
        ["get", "releaser", { source: RELEASER_SOURCE, className: "ReleaserDurableObject" }],
        [method, ...args],
      ]);
    const startedAt = await releaser("start", 70_000);
    disposeSessions();
    await sleep(180_000); // nothing from here: the sweep runs at ~60 s, the release lands at 70 s
    const beats = await releaser("beats");
    console.log(`[residency] the releaser beat on ${beats.lastBeat - startedAt} ms`, beats);
    expect(beats.lastBeat - startedAt, JSON.stringify({ startedAt, ...beats })).toBeLessThan(
      160_000,
    );
  },
);

// ── CLAIMED WORK OUTLIVES ITS CONTEXT ON PURPOSE ──
// Work that must outlive the call that started it runs through `runInBackground`: the processor's
// claim on the context's alarm keeps the facet running across the context's incarnations — the
// claim's alarm wakes one mid-attempt, whose birth spares the claimed facet (FacetHost
// `resetUnclaimedLoadedFacets`) — and the attempt finishes. The sleeper keeps the SDK's rule 3 (what
// it owes lives in state), so a revive restarts a sleep an instance the platform stopped still owed
// (#2921 lost one mid-attempt with no reset of ours); that the attempt finishes on the instance
// that started it is Cloudflare's to keep, printed here and timed in the opt-in perf file.

test(
  "a facet's claimed background work finishes across its context's incarnations, and no birth resets the claimed facet",
  { timeout: 75_000 },
  async () => {
    const ctx = freshCtx("residency_claimed");
    const itx = openItx(ctx);
    await itx.processors.enable("sleeper", {
      source: SLEEPER_SOURCE,
      className: "SleeperDurableObject",
    });
    const started = await facetStartedAt(itx.facets.get("sleeper"));
    // 28 s: the claim's alarm (REVIVE_AFTER_MS, 20 s) lands mid-attempt, and the attempt ends before
    // the row reads at 30 s.
    const [sleep28] = await itx.append({ type: "sleep", payload: { ms: 28_000 } });
    disposeSessions();
    await sleep(30_000); // no request meanwhile: a poll would keep the context resident
    const slept = await until(
      "the background sleep's append",
      async () => (await readAll(openItx(ctx))).find((e: any) => e.type === "slept"),
      30_000,
    );
    const woken = (await readAll(openItx(ctx))).filter(
      (e: any) =>
        e.type === "events.iterate.com/itx/woken" &&
        e.offset > sleep28.offset &&
        e.offset < slept.offset,
    );
    console.log(
      `[residency] ${woken.length} wake(s) mid-sleep (${woken.map((e: any) => e.payload.reason).join(", ")}); slept on the instance started ${slept.payload.startedAt - started} ms after the first`,
    );
    // The claim's alarm woke the context mid-sleep (20 s in, the context idle since the append), and
    // every birth mid-sleep spared the claimed facet — a birth names what it reset on its wake record.
    expect(woken.length, JSON.stringify(woken)).toBeGreaterThanOrEqual(1);
    expect(
      woken.filter((e: any) => e.payload.facetsReset?.includes("sleeper")),
      JSON.stringify(woken),
    ).toEqual([]);
  },
);

// ── A REFUSAL DOES NOT HOLD THE CONTEXT ──
// A Workers-RPC call that THREW keeps its session to the callee open until the caller disposes its
// promise: workerd drops a call's pipeline when an answer arrives, never when an exception does. The
// callee here is a facet, and the context hosting it stays resident, billed, until V8 collects the
// promise. Measured 2026-09-23 after a full e2e run: every delete flow's contexts, and the roots
// whose collection refused, were still on their first incarnation 20 minutes later. The context
// releases a rejected answer (src/context/dispatch.ts `awaitAnswerReleasedIfRejected`). Each row reads the
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
  expect(await wakesAcrossIdles(openItx(ctx).cd(path))).toBeGreaterThanOrEqual(EVICTION_IDLES);
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
  expect(await wakesAcrossIdles(openItx(ctx))).toBeGreaterThanOrEqual(EVICTION_IDLES);
  expect(await facetStartedAt(openItx(ctx).facets.get("project"))).toBeGreaterThan(started);
}, 90_000);

/** The context's incarnations across EVICTION_IDLES idles (support/client.ts `idleAcrossEvictions`). */
async function wakesAcrossIdles(itx: any): Promise<number> {
  const events = await idleAcrossEvictions(itx);
  return events.filter((event) => event.type === "events.iterate.com/itx/woken").length;
}

/** The handle still answers after the actor was evicted underneath it — never a dead-stub error. */
const stillAnswers = (call: () => Promise<unknown>) =>
  call().then(
    () => "answered",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

/** A repo born through the collection and read through its facet, then the client's session closed:
 *  what stays behind is the platform's own doing, not a handle this test holds. */
async function repoBornAndRead(prefix: string): Promise<{ ctx: string; path: string }> {
  const ctx = freshCtx(prefix);
  const path = freshRepoPath("residency");
  const itx = openItx(ctx);
  expect(await itx.repos.create(path)).toEqual({ path });
  expect(await itx.repos.get(path).tip()).toBeNull(); // the facet's remote + token, via withItx
  disposeSessions();
  return { ctx, path };
}

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
