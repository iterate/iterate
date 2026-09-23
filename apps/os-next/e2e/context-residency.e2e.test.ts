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
// `itx.cd(path)…waitForEvent`. Every step such a round trip pipelined must be released, not only the
// last: one left open held facet → ItxEntrypoint → context resident UNTIL THE NEXT DEPLOY (every
// project an os-next preview's e2e run created stayed billed for hours, 2026-09-21/22).
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

// OPEN (2026-09-23): the root's facet door walks `facet.repos().create(path)` and the returned
// collection stub keeps the `project` facet — and so the root — resident for ~2 min after a create
// (measured: evicted by 150 s; before the withItx fix, held until the next deploy). The fix is a flat
// data method on the project facet; when it lands this row passes and `.fails` must go.
test.fails("creating a repo does not keep the project root resident", async () => {
  const { ctx, path } = await repoBornAndRead("residency_root");
  const itx = openItx(ctx);
  try {
    expect(await wakesAcrossIdles(itx)).toBeGreaterThanOrEqual(IDLES);
  } finally {
    await itx.cfArtifacts.delete(path);
  }
}, 120_000);
