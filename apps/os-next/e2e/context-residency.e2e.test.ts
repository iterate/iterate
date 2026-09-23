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
import { expect, test } from "vitest";
import {
  disposeSessions,
  freshCtx,
  openItx,
  readAll,
  runId,
  sleep,
  workerSlot,
} from "./support/client.ts";
import { deployedOnly } from "./support/project-host.ts";
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

// A FACET reaches its own context the other way round: through the SDK's `withItx` on the loopback
// entrypoint — the repo facet's `itx.cfArtifacts.get(path).remote()`, the collection's
// `itx.cd(path)…waitForEvent`. A step such a round trip left holding the context's session kept
// facet → ItxEntrypoint → context resident UNTIL THE NEXT DEPLOY (every project an os-next preview's
// e2e run created stayed billed for hours, 2026-09-21/22); the context now ends that session with
// the call, whatever `withItx` releases (the careless-caller rows below).
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
  "cap.js": `import { DurableObject } from "cloudflare:workers";
export class CarelessHolderDurableObject extends DurableObject {
  kept = [];
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

test("a facet keeping a loaded worker's data answer its context handed through does not keep the context resident", async () => {
  const itx = openItx(freshCtx("residency_careless_data"));
  expect(await carelessHolder(itx, "keepData", DATA_WORKER_SOURCE)).toBe('{"a":1}');
  expect(await wakesAcrossIdles(itx)).toBeGreaterThanOrEqual(IDLES);
}, 90_000);

test("a facet keeping a loaded worker's live RpcTarget does not keep the context resident", async () => {
  const itx = openItx(freshCtx("residency_careless_live"));
  // A live answer leaves the context as the expression that made it: every verb re-runs `make()`
  // (the risk the rule accepts — identity per verb), so the ping answers from a fresh `Made`.
  expect(await carelessHolder(itx, "keepLiveAndPing", LIVE_WORKER_SOURCE)).toMatch(/^pong-\d+$/);
  expect(await wakesAcrossIdles(itx)).toBeGreaterThanOrEqual(IDLES);
}, 90_000);

// The prd shape (a project site's page load, 2026-09-23): loaded code asks its ROOT for a sibling's
// facet snapshot, `env.ITX.get().cd('/domain-sales').facets.get(x).snapshot()`. The root's `cd`
// invokes the sibling, whose answer is data from that hop; forwarded as it arrived, it kept the
// root resident (sessions 142–2424 s) — and the sibling with it.
test("a facet keeping a sibling's data answer, handed through the root's cd, keeps neither context resident", async () => {
  const itx = openItx(freshCtx("residency_careless_sibling"));
  expect(await carelessHolder(itx, "keepSiblingSnapshot", "/residency-sibling")).toBe("object");
  const [root, sibling] = await Promise.all([
    wakesAcrossIdles(itx),
    wakesAcrossIdles(await itx.cd("/residency-sibling")),
  ]);
  expect(Math.min(root, sibling), JSON.stringify({ root, sibling })).toBeGreaterThanOrEqual(IDLES);
}, 90_000);

// LiveState's documented sink (sdk/index.ts): `{ append: (e) => env.ITX.get().append(e) }` — a fresh
// scope per `set`, and neither it nor the append's answer is ever released.
test("the LiveState sink that never releases env.ITX does not keep the context resident", async () => {
  const itx = openItx(freshCtx("residency_live_state_sink"));
  expect(
    await itx.invoke([
      "itx",
      "facets",
      ["get", "chatroom", { source: SOURCES.chatroom, className: "ChatroomDurableObject" }],
      ["post", "careless", "hi"],
    ]),
  ).toEqual({ ok: true });
  expect(await wakesAcrossIdles(itx)).toBeGreaterThanOrEqual(IDLES);
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
