/// <reference types="node" />
// memory-budget.test.ts — THE MEMORY PINS: every way a context's isolate can exceed 128 MiB, each
// run as a real workload (memory-budget-scenarios.ts: the real Stream / ProcessorEngine /
// SubscriptionDelivery over node:sqlite) in a Node child process capped at the isolate budget.
// Local workerd enforces no memory limit, so that child is the only local instrument; the deployed
// twin is e2e/stream-memory-budget.e2e.test.ts (the proof that counts — a real DO on Cloudflare).
//
// `test.fails` is the house convention for a known-red proof: the lane stays green, and flipping a
// row back to `test` is how a fix is proven — every row here was born red (BUILD-LOG 2026-09-04
// records what each died of) and flipped as its fix landed. The CONTROL rows are the same workload
// at a small size, so a red pin is the size and nothing else.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import type { ScenarioFacts, ScenarioName } from "./memory-budget-scenarios.ts";

const SCENARIOS = fileURLToPath(new URL("./memory-budget-scenarios.ts", import.meta.url).href);
/** The production Durable Object isolate limit, as a V8 old-space cap on the child. */
const ISOLATE_BUDGET_MB = 128;
/** Every spelling V8 gives a heap-limit death — the local twin of "isolate exceeded its memory limit". */
const OOM_SIGNATURE =
  /Reached heap limit|JavaScript heap out of memory|Ineffective mark-compacts|Allocation failed/;
const MiB = 1024 * 1024;

/** How the child ended: `survived` (it printed its JSON report), `oom` (the pinned death), or
 *  `other` (a broken fixture — never a valid pin). */
type ScenarioRun = { kind: "survived" | "oom" | "other"; facts: ScenarioFacts; tail: string };

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
const expectSurvived = (run: ScenarioRun, what: string) =>
  expect(run.kind, `${what}: child ${run.kind} at ${ISOLATE_BUDGET_MB} MiB\n${run.tail}`).toBe(
    "survived",
  );

/** 144 MiB of legal-sized events — more than the isolate, every one under the append ceiling. */
const LOG_144_MIB = { eventCount: 24, eventChars: 6 * MiB };
const CONTROL = { eventCount: 12, eventChars: 64 * 1024 };

// ── the read door ──

test("control: a client pages a 12 × 64 KiB log within the budget", { timeout: 60_000 }, () => {
  const run = runScenario("read-whole-log", CONTROL);
  expectSurvived(run, "read-whole-log");
  expect(Number(run.facts.eventsRead)).toBe(12);
});

test(
  "read: a client pages a 144 MiB log (24 × 6 MiB) — every page fits the isolate and the 32 MiB RPC result cap",
  { timeout: 110_000 },
  () => {
    const run = runScenario("read-whole-log", LOG_144_MIB);
    expectSurvived(run, "read-whole-log");
    expect(Number(run.facts.eventsRead)).toBe(24);
    expect(Number(run.facts.maxPageBytes)).toBeLessThanOrEqual(32 * MiB);
  },
);

// ── the replay loops: a facet's loopback catch-up, the core re-reduce in the DO constructor ──

test("control: a facet catches up over a 12 × 64 KiB log", { timeout: 60_000 }, () => {
  const run = runScenario("facet-catch-up", CONTROL);
  expectSurvived(run, "facet-catch-up");
  expect(Number(run.facts.reducedCount)).toBe(12);
});

test(
  "facet catch-up: a processor reduces a 144 MiB log (24 × 6 MiB) through its loopback read",
  { timeout: 110_000 },
  () => {
    const run = runScenario("facet-catch-up", LOG_144_MIB);
    expectSurvived(run, "facet-catch-up");
    expect(Number(run.facts.reducedCount)).toBe(24);
  },
);

test(
  "constructor re-reduce: a core-version bump re-reduces a 144 MiB log (24 × 6 MiB) inside the constructor (else a reboot loop)",
  { timeout: 110_000 },
  () => {
    const run = runScenario("constructor-rereduce", LOG_144_MIB);
    expectSurvived(run, "constructor-rereduce");
  },
);

// ── the delivery loop ──

test(
  "delivery backlog: 200 × 1 MiB commits behind a facet that never answers stay bounded",
  { timeout: 110_000 },
  () => {
    const run = runScenario("delivery-backlog", { batchCount: 200, batchChars: 1 * MiB });
    expectSurvived(run, "delivery-backlog");
    expect(Number(run.facts.appended)).toBe(200);
  },
);

// ── the append door ──

test(
  "append: one event past the platform ceiling is refused at the door with EVENT_TOO_LARGE",
  { timeout: 60_000 },
  () => {
    const run = runScenario("append-oversize", { eventChars: 9 * MiB });
    expectSurvived(run, "append-oversize");
    expect(run.facts.refusedCode, run.tail).toBe("EVENT_TOO_LARGE");
  },
);

// ═══ THE HUNT, round 2 (2026-09-04): the next ways in, each born red. A `test.fails` row's comment
// says what it dies of — `oom` (the child hit the heap limit) or a named fact — so flipping it to
// `test` is the proof of its fix. The CONTROL rows beside them bound the same path at a size that
// survives. ═══

// ── the append door: the idempotent retry, and the echo ──

/** The largest legal keyed retry: 4 events at the ceiling is 32 MiB of args, the RPC cap. */
const RETRY_4_AT_CEILING = { eventCount: 4, eventChars: 8 * MiB - 256 };

test(
  "control: a 4 × 8 MiB idempotent retry (32 MiB of args, every event a dedupe hit) fits the isolate and both RPC caps",
  { timeout: 60_000 },
  () => {
    const run = runScenario("idempotency-dedupe-retry", RETRY_4_AT_CEILING);
    expectSurvived(run, "idempotency-dedupe-retry");
    expect(Number(run.facts.dedupedCount)).toBe(4);
    expect(Number(run.facts.argsBytes)).toBeLessThanOrEqual(32 * MiB);
    expect(Number(run.facts.echoBytes)).toBeLessThanOrEqual(32 * MiB);
  },
);

// Dies of: the echo fact. 40,000 × 780-char events serialize to 31.1 MiB of args (legal); the
// commit lands (durableOffset = 40,000); the reply — the same events plus offset, createdAt and
// path each — serializes to 33.3 MiB, over the 32 MiB RPC result cap: the caller gets an RPC error
// for a batch that is in the log, and a keyless retry doubles it.
test.fails(
  "append echo: a legal 32 MiB batch (40,000 × 780 chars) commits, then its echo serializes past the 32 MiB RPC result cap — a committed-but-errored append",
  { timeout: 60_000 },
  () => {
    const run = runScenario("append-echo-over-rpc-cap", {
      eventCount: 40_000,
      eventChars: 780,
    });
    expectSurvived(run, "append-echo-over-rpc-cap");
    expect(Number(run.facts.committed)).toBe(40_000);
    expect(Number(run.facts.echoBytes), run.tail).toBeLessThanOrEqual(32 * MiB);
  },
);

// ── the checkpoint cell: a reduce whose state outgrows it ──

// 64 × 64 KiB events into a reduce that keeps every payload: the 32nd batch's state no longer fits
// the checkpoint cell and is refused CODED (REDUCE_CHECKPOINT_TOO_LARGE, stamped `retryable: false`)
// before any write — the checkpoint stays consistent — and the engine LATCHES it: every later push
// and wake rejects at once, without re-reading the log (the parent's delivery loop halts the row on
// the same stamp). BORN RED twice: first as a TORN checkpoint (the cursor landed, the state did not,
// the next incarnation silently skipped 33 events — the one-row checkpoint), then as a wedge that
// re-read and re-reduced on every push and wake (the latch). BUILD-LOG 2026-09-04.
test(
  "accumulating reducer: a state past the checkpoint cell ceiling is refused coded, the checkpoint stays consistent, and the refusal is latched — no re-read per wake",
  { timeout: 60_000 },
  () => {
    const run = runScenario("accumulating-reducer", {
      eventCount: 64,
      eventChars: 64 * 1024,
    });
    expectSurvived(run, "accumulating-reducer");
    expect(run.facts.firstPushErrorCode, run.tail).toBe("REDUCE_CHECKPOINT_TOO_LARGE");
    expect(Number(run.facts.persistedItems), run.tail).toBe(
      Number(run.facts.persistedBlobsThrough),
    ); // one row: the state holds exactly the durables its cursor claims
    expect(Number(run.facts.readsDuringWakes), run.tail).toBe(0); // the refusal is LATCHED: a wake rejects without re-reading the log
  },
);

// ── live state: a large projection ──

test(
  "control: a 6 MiB live-state projection edited every batch survives — each one-item edit ships the whole array as the delta",
  { timeout: 60_000 },
  () => {
    const run = runScenario("live-state-large-projection", {
      itemCount: 6,
      itemChars: 1 * MiB,
      batchCount: 5,
    });
    expectSurvived(run, "live-state-large-projection");
    expect(Number(run.facts.deltasCommitted)).toBeGreaterThanOrEqual(5);
    expect(Number(run.facts.deltasRefused)).toBe(0);
  },
);

// CONTROL, once a pin: a 12 MiB projection's every delta is a whole-array replace, and while the
// append ceiling measured ephemerals too every delta was refused (EVENT_TOO_LARGE, swallowed by
// LiveState.set as a "lost notification" — the watcher got nothing, not even a chain gap). The
// ceiling now measures only what is STORED; an ephemeral rides the pending-push budget instead. The
// diff cost per set (stringify + parse of both sides, ~6× the projection transient) stays.
test(
  "live state: a 12 MiB projection still emits its deltas — an ephemeral is never stored, so the append ceiling does not apply to it",
  { timeout: 60_000 },
  () => {
    const run = runScenario("live-state-large-projection", {
      itemCount: 12,
      itemChars: 1 * MiB,
      batchCount: 3,
    });
    expectSurvived(run, "live-state-large-projection");
    expect(Number(run.facts.deltasRefused), run.tail).toBe(0);
  },
);

// ── the delivery loop: many rows ──

/** 200 × 1 MiB ephemeral commits behind facets that never answer, across 20 rows. */
const STUCK_ROWS_20 = { rowCount: 20, batchCount: 200, batchChars: 1 * MiB };

test(
  "control: 20 stuck facet rows consuming the SAME events retain one backlog between them (the StreamEvent objects are shared)",
  { timeout: 60_000 },
  () => {
    const run = runScenario("stuck-facet-rows", { ...STUCK_ROWS_20, disjointTypes: 0 });
    expectSurvived(run, "stuck-facet-rows");
    expect(Number(run.facts.callsStarted)).toBeGreaterThanOrEqual(20); // every row called (a 16 MiB log is two pages a row)
  },
);

// BORN RED (oom): the pending budget was PER ROW — 20 stuck rows on 20 disjoint event types kept
// 8 MiB of undelivered pushes EACH, 160 MiB in one isolate. Flipped by the per-context ledger
// (PENDING_PUSHES_TOTAL_BUDGET_CHARS across rows + DELIVERY_IN_FLIGHT_BUDGET_CHARS across calls).
test(
  "delivery backlog × rows: 20 stuck facet rows on DISJOINT event types share ONE pending budget and ONE in-flight budget — never 20 × 8 MiB",
  { timeout: 60_000 },
  () => {
    const run = runScenario("stuck-facet-rows", { ...STUCK_ROWS_20, disjointTypes: 1 });
    expectSurvived(run, "stuck-facet-rows");
  },
);

/** A 16 MiB log (16 × 1 MiB) every cursor row is behind by — two budgeted pages each. */
const CURSOR_ROWS_BEHIND_16_MIB = { eventCount: 16, eventChars: 1 * MiB, calleeCopy: 0 };

test(
  "control: 4 behind cursor rows (the alarm pass's concurrency) drain one commit within the budget",
  { timeout: 60_000 },
  () => {
    const run = runScenario("cursor-rows-behind-one-commit", {
      ...CURSOR_ROWS_BEHIND_16_MIB,
      rowCount: 4,
    });
    expectSurvived(run, "cursor-rows-behind-one-commit");
    expect(Number(run.facts.callsStarted)).toBe(4);
  },
);

// BORN RED (oom): one commit drained every behind cursor row at once, each holding a budgeted page
// across its awaited call — 20 rows was 160 MiB. Flipped by the in-flight ledger: a cursor delivery
// waits for room, so the rows drain a few at a time (`maxCallsInFlight` says how many; the callees
// here answer after 250 ms). The rows are behind the natural way — a fresh incarnation whose cursors
// were never acked — and the commit is one small append.
test(
  "cursor rows: 20 behind cursor rows and ONE commit — the commit path drains them under the in-flight budget, never a page per row at once",
  { timeout: 60_000 },
  () => {
    const run = runScenario("cursor-rows-behind-one-commit", {
      ...CURSOR_ROWS_BEHIND_16_MIB,
      rowCount: 20,
    });
    expectSurvived(run, "cursor-rows-behind-one-commit");
    expect(Number(run.facts.callsStarted)).toBeGreaterThanOrEqual(20); // every row called (a 16 MiB log is two pages a row)
    expect(Number(run.facts.maxCallsInFlight)).toBeLessThan(20); // the ledger, not the row count, sets the fan-out
  },
);

// ── the history scan ──

test(
  "control: waitForEvent's history scan over a 300 MiB log (38 × 8 MiB, afterOffset 0, a type never seen) stays within the budget — a synchronous stall of scanMs, not a memory one",
  { timeout: 110_000 },
  () => {
    const run = runScenario("wait-for-event-history-scan", {
      eventCount: 38,
      eventChars: 8 * MiB - 256,
    });
    expectSurvived(run, "wait-for-event-history-scan");
    expect(run.facts.waitOutcome).toBe("WAIT_TIMEOUT");
  },
);

// ── the core checkpoint cell: the control plane's ceiling ──

/** ONE ~55 s run (17,000 rows, O(rows²) both to configure and to re-reduce) feeds the two rows
 *  below — a memo, so the second row reads the first's facts instead of paying the run again. */
let coreRowsRun: ScenarioRun | undefined;
const runCoreRowsUntilCellCap = () =>
  (coreRowsRun ??= runScenario("core-rows-until-cell-cap", {
    maxRows: 20_000,
    rowsPerAppend: 1000,
  }));

// ~17,000 subscription rows (~123 chars each) fill the core checkpoint cell; the configure that
// would grow it past the ceiling is refused CODED — REDUCE_CHECKPOINT_TOO_LARGE, inside the commit's
// transaction, nothing written — where it was BORN RED as the platform's raw, uncoded SQLITE_TOOBIG
// (flipped with the one-row checkpoint, BUILD-LOG 2026-09-04). A shrink still lands; one configure
// at this size costs ~50 ms (the O(rows) spread plus the core live-state diff).
test(
  "core rows: ~17,000 subscription rows fill the core checkpoint cell — the next configure is refused coded, REDUCE_CHECKPOINT_TOO_LARGE, nothing written",
  { timeout: 110_000 },
  () => {
    const run = runCoreRowsUntilCellCap();
    expectSurvived(run, "core-rows-until-cell-cap");
    expect(run.facts.refusedCode, run.tail).toBe("REDUCE_CHECKPOINT_TOO_LARGE");
    expect(Number(run.facts.rowsConfigured)).toBeGreaterThan(10_000);
  },
);

// Dies of: the `rereduceMs` fact. A core-version bump re-reduces every configure inside the DO
// constructor, and each one spreads the whole subscriptions table (core-processor.ts): O(rows²) —
// 25 s for 17,000 rows on this laptop, i.e. past the 30 s CPU limit on an edge core (≈ half as
// fast), and the next wake runs the same constructor: a reboot loop. The bound is 15 s here for
// that reason.
test.fails(
  "core re-reduce: a core-version bump over 17,000 rows re-reduces O(rows²) in the constructor — 25 s, a reboot loop against the CPU limit",
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
test.fails(
  "read: two 4 MiB object-dense events (each append fit) share one 8 MiB page that parses to ~150 MiB — the byte budget cannot see parsed cost",
  { timeout: 60_000 },
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
// the size door never gets to measure it. The stand-in for the DO deserializing the RPC args.
test.fails(
  "append door: one legal 8 MiB object-dense event needs ~150 MiB to deserialize — the size door never runs",
  { timeout: 60_000 },
  () => {
    const run = runScenario("read-object-dense-page", {
      eventCount: 1,
      itemCount: 2 * DENSE_4_MIB_ITEMS,
    });
    expectSurvived(run, "read-object-dense-page");
  },
);
