/// <reference types="node" />
// memory-budget.test.ts — THE MEMORY PINS: every way a context's isolate can exceed 128 MiB, each
// run as a real workload (memory-budget.test-support.ts beside it: the real Stream / ProcessorEngine /
// SubscriptionDelivery over node:sqlite) in a Node child process capped at the isolate budget.
// Local workerd enforces no memory limit, so that child is the only local instrument; the deployed
// twin is e2e/isolate-ceilings-deployed.e2e.test.ts (the proof that counts — a real DO on Cloudflare).
//
// A known-red row is a `createFailing` pin (docs/testing.md, "Pinned bugs") whose pattern is the
// failure it dies of, so the suite stays green only while that exact failure holds; unwrapping a row
// back to `test` is how a fix is proven — every plain row here was born red and flipped as its fix
// landed. The CONTROL rows are the same workload at a small size, so a red pin is the size and
// nothing else.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { createFailing } from "@iterate-com/shared/test-support/failing-test";
import type { ScenarioFacts, ScenarioName } from "./memory-budget.test-support.ts";

const SCENARIOS = fileURLToPath(new URL("./memory-budget.test-support.ts", import.meta.url).href);
/** The production Durable Object isolate limit, as a V8 old-space cap on the child. */
const ISOLATE_BUDGET_MB = 128;
/** Every spelling V8 gives a heap-limit death — the local twin of "isolate exceeded its memory limit". */
const OOM_SIGNATURE =
  /Reached heap limit|JavaScript heap out of memory|Ineffective mark-compacts|Allocation failed/;
const MiB = 1024 * 1024;

/** How the child ended: `survived` (it printed its JSON report), `oom` (the pinned death), or
 *  `other` (a broken fixture — never a valid pin). */
type ScenarioRun = { kind: "survived" | "oom" | "other"; facts: ScenarioFacts; tail: string };

/** 144 MiB of legal-sized events — more than the isolate, every one under the append ceiling. */
const LOG_144_MIB = { eventCount: 24, eventChars: 6 * MiB };
const CONTROL = { eventCount: 12, eventChars: 64 * 1024 };
/** The largest legal keyed retry: 4 events at the ceiling is 32 MiB of args, the RPC cap. */
const RETRY_4_AT_CEILING = { eventCount: 4, eventChars: 8 * MiB - 256 };
/** 200 × 1 MiB ephemeral commits behind facets that never answer, across 20 rows. */
const STUCK_ROWS_20 = { rowCount: 20, batchCount: 200, batchChars: 1 * MiB };
/** A 16 MiB log (16 × 1 MiB) every cursor row is behind by — two budgeted pages each. */
const CURSOR_ROWS_BEHIND_16_MIB = { eventCount: 16, eventChars: 1 * MiB, calleeCopy: 0 };
/** Cursor rows on disjoint event types, sinks that never answer, 900 KiB ephemerals (under the
 *  ring's 1 MiB) — two per row. */
const CURSOR_ROWS_EPHEMERALS_FROM_RING = { batchChars: 900 * 1024 };

// Every plain row runs its scenario in the capped child, asserts that it survived, then its `facts`
// (exact) and its `bounds` (a numeric fact against a number), within `timeout` (60 s unless named).
const rows: {
  name: string;
  scenario: ScenarioName;
  args: Record<string, number>;
  timeout?: number;
  facts?: ScenarioFacts;
  bounds?: [fact: string, comparison: keyof typeof comparisons, bound: number][];
}[] = [
  // ── reads ──
  {
    name: "control: a client pages a 12 × 64 KiB log within the budget",
    scenario: "read-whole-log",
    args: CONTROL,
    facts: { eventsRead: 12 },
  },
  {
    name: "read: a client pages a 144 MiB log (24 × 6 MiB) — every page fits the isolate and the 32 MiB RPC result cap",
    scenario: "read-whole-log",
    args: LOG_144_MIB,
    timeout: 110_000,
    facts: { eventsRead: 24 },
    bounds: [["maxPageBytes", "<=", 32 * MiB]],
  },
  // Concurrent readers — N clients paging one big log at once — can reset the DO: each read
  // returns a >=1-row page, so N readers coexist as N pages in flight, and the per-read byte
  // budget (the whole read-memory defense) bounds ONE read, not their sum. That is an ACCEPTED
  // client-behaviour limit (a client only resets its OWN DO; the durable log survives; it
  // reconnects) — deliberately not defended, to keep `read()` synchronous. The reproduction and
  // the full rationale (why okay, how it would be fixed) live in the deployed e2e:
  // e2e/isolate-ceilings-deployed.e2e.test.ts CONCURRENT READERS.

  // ── the replay loops: a facet's loopback catch-up, the core re-reduce in the DO constructor ──
  {
    name: "control: a facet catches up over a 12 × 64 KiB log",
    scenario: "facet-catch-up",
    args: CONTROL,
    facts: { reducedCount: 12 },
  },
  {
    name: "facet catch-up: a processor reduces a 144 MiB log (24 × 6 MiB) through its loopback read",
    scenario: "facet-catch-up",
    args: LOG_144_MIB,
    timeout: 110_000,
    facts: { reducedCount: 24 },
  },
  {
    name: "constructor re-reduce: a core-version bump re-reduces a 144 MiB log (24 × 6 MiB) inside the constructor (else a reboot loop)",
    scenario: "constructor-rereduce",
    args: LOG_144_MIB,
    timeout: 110_000,
  },

  // ── the delivery loop ──
  {
    name: "delivery backlog: 200 × 1 MiB commits behind ONE facet that never answers stay bounded",
    scenario: "stuck-facet-rows",
    args: { rowCount: 1, batchCount: 200, batchChars: 1 * MiB, disjointTypes: 0 },
    timeout: 110_000,
    facts: { appended: 200 },
  },

  // ── appends ──
  {
    name: "append: one event past the platform ceiling is refused on append with EVENT_TOO_LARGE",
    scenario: "append-oversize",
    args: { eventChars: 9 * MiB },
    facts: { refusedCode: "EVENT_TOO_LARGE" },
  },
  {
    name: "control: a 4 × 8 MiB idempotent retry (32 MiB of args, every event a dedupe hit) fits the isolate and both RPC caps",
    scenario: "idempotency-dedupe-retry",
    args: RETRY_4_AT_CEILING,
    facts: { dedupedCount: 4 },
    bounds: [
      ["argsBytes", "<=", 32 * MiB],
      ["echoBytes", "<=", 32 * MiB],
    ],
  },

  // ── live state: a large projection ──
  {
    name: "control: a 6 MiB live-state projection edited every batch survives — each one-item edit ships the whole array as the delta",
    scenario: "live-state-large-projection",
    args: { itemCount: 6, itemChars: 1 * MiB, batchCount: 5 },
    facts: { deltasRefused: 0 },
    bounds: [["deltasCommitted", ">=", 5]],
  },
  // A 12 MiB projection's every delta is a whole-array replace past the append ceiling. The ceiling
  // measures only what is STORED and an ephemeral delta rides the pending-push budget instead, so none
  // is refused: a refused delta is swallowed by LiveState.set as a "lost notification", and the
  // watcher gets nothing, not even a chain gap. Each set still costs its diff (stringify + parse of
  // both sides, ~6× the projection transient).
  {
    name: "live state: a 12 MiB projection still emits its deltas — an ephemeral is never stored, so the append ceiling does not apply to it",
    scenario: "live-state-large-projection",
    args: { itemCount: 12, itemChars: 1 * MiB, batchCount: 3 },
    facts: { deltasRefused: 0 },
  },

  // ── the delivery loop: many rows ──
  {
    name: "control: 20 stuck facet rows consuming the SAME events retain one backlog between them (the StreamEvent objects are shared)",
    scenario: "stuck-facet-rows",
    args: { ...STUCK_ROWS_20, disjointTypes: 0 },
    bounds: [["callsStarted", ">=", 20]], // every row called (a 16 MiB log is two pages a row)
  },
  // The pending budget is the context's, not each row's: 20 stuck rows on 20 disjoint event types at
  // 8 MiB of undelivered pushes each would be 160 MiB in one isolate. PENDING_PUSHES_TOTAL_BUDGET_CHARS
  // bounds them across rows, and DELIVERY_IN_FLIGHT_BUDGET_CHARS across calls.
  {
    name: "delivery backlog × rows: 20 stuck facet rows on DISJOINT event types share ONE pending budget and ONE in-flight budget — never 20 × 8 MiB",
    scenario: "stuck-facet-rows",
    args: { ...STUCK_ROWS_20, disjointTypes: 1 },
  },
  {
    name: "control: 4 behind cursor rows (the alarm pass's concurrency) drain one commit within the budget",
    scenario: "cursor-rows-behind-one-commit",
    args: { ...CURSOR_ROWS_BEHIND_16_MIB, rowCount: 4 },
    bounds: [["callsStarted", ">=", 4]], // every row called (a page may split under the read budget)
  },
  // One commit wakes every behind cursor row, and each holds a budgeted page across its awaited call:
  // 20 at once would be 160 MiB. A cursor delivery waits for room in the in-flight ledger, so the rows
  // drain a few at a time (`maxCallsInFlight` says how many; the callees here answer after 250 ms).
  // The rows are behind the natural way — a fresh incarnation whose cursors were never acked — and
  // the commit is one small append.
  {
    name: "cursor rows: 20 behind cursor rows and ONE commit — the commit path drains them under the in-flight budget, never a page per row at once",
    scenario: "cursor-rows-behind-one-commit",
    args: { ...CURSOR_ROWS_BEHIND_16_MIB, rowCount: 20 },
    bounds: [
      ["callsStarted", ">=", 20], // every row called (a 16 MiB log is two pages a row)
      ["maxCallsInFlight", "<", 20], // the ledger, not the row count, sets the fan-out
    ],
  },
  {
    name: "control: 2 cursor rows fed 900 KiB ephemerals from the ring stay within the budget",
    scenario: "cursor-rows-ephemerals-from-ring",
    args: { ...CURSOR_ROWS_EPHEMERALS_FROM_RING, rowCount: 2, batchCount: 4 },
    bounds: [["callsStarted", ">=", 1]],
  },
  // A cursor row reads its ephemerals from the stream's recent-ephemerals ring (1 MiB) under the
  // cursor-read budget, and a row waiting for room holds nothing, so what is retained is the in-flight
  // batches (8 MiB) and the ring, whatever the row count. A pushed batch kept per row would be bounded
  // by nothing but the row count: 160 rows × 900 KiB is 140 MiB.
  {
    name: "cursor rows: 160 cursor rows fed 900 KiB ephemerals retain the ring and the in-flight batches, never a batch per row",
    scenario: "cursor-rows-ephemerals-from-ring",
    args: { ...CURSOR_ROWS_EPHEMERALS_FROM_RING, rowCount: 160, batchCount: 320 },
    bounds: [
      ["callsStarted", ">=", 2],
      ["callsStarted", "<", 160], // the budget, not the row count, sets the fan-out
    ],
  },

  // ── the history scan ──
  {
    name: "control: waitForEvent's history scan over a 300 MiB log (38 × 8 MiB, afterOffset 0, a type never seen) stays within the budget — a synchronous stall of scanMs, not a memory one",
    scenario: "wait-for-event-history-scan",
    args: { eventCount: 38, eventChars: 8 * MiB - 256 },
    timeout: 110_000,
    facts: { waitOutcome: "WAIT_TIMEOUT" },
  },
];
for (const { name, scenario, args, timeout = 60_000, facts = {}, bounds = [] } of rows)
  test(name, { timeout }, () => {
    const run = runScenario(scenario, args);
    expectSurvived(run, scenario);
    expect(run.facts, run.tail).toMatchObject(facts);
    for (const [fact, comparison, bound] of bounds)
      expect(Number(run.facts[fact]), `${fact} ${comparison} ${bound}\n${run.tail}`)[
        comparisons[comparison]
      ](bound);
  });

// ═══ A pinned row's comment says what it dies of — `oom` (the child hit the heap limit) or a
// named fact — so unwrapping it to `test` is the proof of its fix. The CONTROL rows beside them bound
// the same path at a size that survives. ═══

// Dies of: the echo fact. 40,000 × 780-char events serialize to 31.1 MiB of args (legal); the
// commit lands (durableOffset = 40,000); the reply — the same events plus offset, createdAt and
// path each — serializes to 33.3 MiB, over the 32 MiB RPC result cap: the caller gets an RPC error
// for a batch that is in the log, and a keyless retry doubles it.
createFailing(test, /the echo should fit the 32 MiB RPC result cap/, { timeoutMs: 60_000 })(
  "append echo: a legal 32 MiB batch (40,000 × 780 chars) commits, then its echo serializes past the 32 MiB RPC result cap — a committed-but-errored append",
  () => {
    const run = runScenario("append-echo-over-rpc-cap", {
      eventCount: 40_000,
      eventChars: 780,
    });
    expectSurvived(run, "append-echo-over-rpc-cap");
    expect(Number(run.facts.committed)).toBe(40_000);
    expect(
      Number(run.facts.echoBytes),
      `the echo should fit the 32 MiB RPC result cap\n${run.tail}`,
    ).toBeLessThanOrEqual(32 * MiB);
  },
);

// ── the checkpoint cell: a reduce whose state outgrows it ──

// 64 × 64 KiB events into a reduce that keeps every payload: the 32nd batch's state no longer fits
// the checkpoint cell and is refused CODED (REDUCE_CHECKPOINT_TOO_LARGE, stamped `retryable: false`)
// before any write — the checkpoint stays consistent — and the engine LATCHES it: every later push
// and wake rejects at once, without re-reading the log (the parent's delivery loop halts the row on
// the same stamp). BORN RED twice: first as a TORN checkpoint (the cursor landed, the state did not,
// the next incarnation silently skipped 33 events — the one-row checkpoint), then as a wedge that
// re-read and re-reduced on every push and wake (the latch).
test(
  "accumulating reducer: a state past the checkpoint cell ceiling is refused coded, the checkpoint stays consistent, and the refusal is latched — no re-read per wake",
  { timeout: 60_000 },
  () => {
    const run = runScenario("accumulating-reducer", {
      eventCount: 64,
      eventChars: 64 * 1024,
    });
    expectSurvived(run, "accumulating-reducer");
    expect(run.facts, run.tail).toMatchObject({
      firstPushErrorCode: "REDUCE_CHECKPOINT_TOO_LARGE",
    });
    expect(Number(run.facts.persistedItems), run.tail).toBe(
      Number(run.facts.persistedBlobsThrough),
    ); // one row: the state holds exactly the durables its cursor claims
    expect(Number(run.facts.readsDuringWakes), run.tail).toBe(0); // the refusal is LATCHED: a wake rejects without re-reading the log
  },
);

// ── the core checkpoint cell: the control plane's ceiling ──

// ~17,000 subscription rows (~123 chars each) fill the core checkpoint cell; the configure that
// would grow it past the ceiling is refused CODED — REDUCE_CHECKPOINT_TOO_LARGE, inside the commit's
// transaction, nothing written — where it was BORN RED as the platform's raw, uncoded SQLITE_TOOBIG
// (flipped with the one-row checkpoint). A shrink still lands; one configure
// at this size costs ~50 ms (the O(rows) spread plus the core live-state diff).
test(
  "core rows: ~17,000 subscription rows fill the core checkpoint cell — the next configure is refused coded, REDUCE_CHECKPOINT_TOO_LARGE, nothing written",
  { timeout: 110_000 },
  () => {
    const run = runCoreRowsUntilCellCap();
    expectSurvived(run, "core-rows-until-cell-cap");
    expect(run.facts, run.tail).toMatchObject({ refusedCode: "REDUCE_CHECKPOINT_TOO_LARGE" });
    expect(Number(run.facts.rowsConfigured)).toBeGreaterThan(10_000);
  },
);

// A core-version bump re-reduces every configure inside the DO constructor. BORN RED (the
// `rereduceMs` fact): each configure spread the whole subscriptions table — O(rows²), 25 s for
// 17,000 rows on this laptop, past the 30 s CPU limit on an edge core (≈ half as fast), and the next
// wake ran the same constructor: a reboot loop. FLIPPED by `reduceCoreEventBatch`: a table is
// copied once per 500-event page, not once per event. The bound stays 15 s for the reason above;
// the fixed cost is well under a second.
test(
  "core re-reduce: a core-version bump over 17,000 rows re-reduces in the constructor in O(rows) per page — under the 15 s that would be a reboot loop against the CPU limit",
  { timeout: 110_000 },
  () => {
    const run = runCoreRowsUntilCellCap();
    expectSurvived(run, "core-rows-until-cell-cap");
    expect(Number(run.facts.rebuiltRows)).toBe(Number(run.facts.rowsConfigured));
    expect(Number(run.facts.rereduceMs), run.tail).toBeLessThan(15_000);
  },
);

// ── the read budget's blind spot: parsed cost ──

/** `[[]]` is 5 chars with its comma and ~90 heap bytes parsed: 838,820 of them is a 4 MiB body. */
const DENSE_4_MIB_ITEMS = 838_820;

// Dies of: oom. The read budget adds up JSON CHARS; the isolate pays the PARSED form, and two
// 4 MiB events of nested empty arrays parse to ~76 MiB EACH. Each append fit (the second's parse
// even reclaimed the first's garbage); the one 8 MiB page that carries both did not. Every replay
// loop pages the same way — a facet's catch-up, and the core re-reduce in the constructor: a
// reboot loop for any context holding two such events.
createFailing(test, /read-object-dense-page: child oom at 128 MiB/, { timeoutMs: 60_000 })(
  "read: two 4 MiB object-dense events (each append fit) share one 8 MiB page that parses to ~150 MiB — the byte budget cannot see parsed cost",
  () => {
    const run = runScenario("read-object-dense-page", {
      eventCount: 2,
      itemCount: DENSE_4_MIB_ITEMS,
    });
    expectSurvived(run, "read-object-dense-page");
    expect(Number(run.facts.pageEvents)).toBe(2);
  },
);

// Dies of: oom — before any Stream code runs. One 8 MiB body of nested empty arrays (1,677,640 ×
// `[[]]`, 8,388,273 chars: under the ceiling, under the RPC cap) needs ~150 MiB to deserialize;
// the append size check never gets to measure it. The stand-in for the DO deserializing the RPC args.
createFailing(test, /read-object-dense-page: child oom at 128 MiB/, { timeoutMs: 60_000 })(
  "append: one legal 8 MiB object-dense event needs ~150 MiB to deserialize — the append size check never runs",
  () => {
    const run = runScenario("read-object-dense-page", {
      eventCount: 1,
      itemCount: 2 * DENSE_4_MIB_ITEMS,
    });
    expectSurvived(run, "read-object-dense-page");
  },
);

function runScenario(name: ScenarioName, args: Record<string, number>): ScenarioRun {
  const child = spawnSync(
    process.execPath,
    [
      `--max-old-space-size=${ISOLATE_BUDGET_MB}`,
      "--experimental-strip-types",
      "--disable-warning=ExperimentalWarning",
      SCENARIOS,
      name,
      JSON.stringify(args),
    ],
    { encoding: "utf8", timeout: 110_000, maxBuffer: 64 * MiB },
  );
  const output = `${child.stdout}\n${child.stderr}`;
  const report = /^\{.*\}$/m.exec(child.stdout)?.[0];
  const kind = report ? "survived" : OOM_SIGNATURE.test(output) ? "oom" : "other";
  return {
    kind,
    facts: report ? (JSON.parse(report) as ScenarioFacts) : {},
    tail: output.trim().split("\n").slice(-12).join("\n"),
  };
}

/** The one assertion every row makes: the child survived the budget. The failure message carries
 *  the classification (`oom` is the pinned bug; `other` is a broken fixture, never a valid pin). */
function expectSurvived(run: ScenarioRun, what: string) {
  expect(run, `${what}: child ${run.kind} at ${ISOLATE_BUDGET_MB} MiB\n${run.tail}`).toMatchObject({
    kind: "survived",
  });
}

/** ONE run (17,000 rows configured, then re-reduced after a version bump) feeds the two core-rows
 *  tests above — a memo, so the second row reads the first's facts instead of paying the run again.
 *  Under a second since `reduceCoreEventBatch` (was ~55 s when every configure copied the whole table). */
let coreRowsRun: ScenarioRun | undefined;
function runCoreRowsUntilCellCap() {
  return (coreRowsRun ||= runScenario("core-rows-until-cell-cap", {
    maxRows: 20_000,
    rowsPerAppend: 1000,
  }));
}

/** A row's bound, as the matcher that checks it. */
const comparisons = {
  "<": "toBeLessThan",
  "<=": "toBeLessThanOrEqual",
  ">=": "toBeGreaterThanOrEqual",
} as const;
