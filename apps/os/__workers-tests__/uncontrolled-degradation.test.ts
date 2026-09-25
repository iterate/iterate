// __workers-tests__/uncontrolled-degradation.test.ts — THE RED PINS of the 2026-09-04 hunt for
// UNCONTROLLED degradation: every way this context can still fail in a manner the PLATFORM decides
// for us — a message we did not write, a wedge with no operator remedy, a retry that never ends —
// beyond out-of-memory (local workerd enforces no memory limit; the memory pins live in
// src/stream/memory-budget.test.ts and e2e/isolate-ceilings-deployed.e2e.test.ts). Each row stages one
// scenario against a REAL `IterateContextDurableObject` inside workerd (runInDurableObject for its
// storage, evictDurableObject for a fresh incarnation, runDurableObjectAlarm for the ladder) and
// pins EXACTLY what it dies of today: the observed message, verbatim.
//
// THE CONVENTION. Every red row is a `createFailing` pin (docs/testing.md, "Pinned bugs"): the body
// asserts the behavior the row WANTS, and that assertion's message quotes what the row dies of
// TODAY, which is the pin's pattern. While both hold, the row fails as pinned (green). The moment the
// observed failure MOVES — fixed, or broken some other way — the body passes or fails differently,
// and the row turns RED with a `[failing-test]` line saying which. To flip a fixed row to `test`,
// drop the `createFailing` wrapper and the quoted observation, and keep its assertions.
//
// Two cell-cap facts these rows lean on: a SQLite-backed DO's
// storage cell — a kv value, a TEXT column — is capped by SQLITE_LIMIT_LENGTH: 4 MiB in local
// workerd, 2 MB in production (docs). The append ceiling (stream.ts EVENT_BODY_MAX_CHARS) is 8 MiB,
// so a body can be small enough to append and too big to checkpoint or memo.
//
// The CONTROL rows (plain `test`) pin the half that is handled well beside each red half, so a
// change to either shows up. The rows, by theme:
//   A. THE CELL CAP — core state, a facet's checkpoint, a facet's source memo
//   B. A SOURCE THAT CANNOT START — class not exported, module throws, constructor throws
//   C. POISON EVENTS — a throwing processEvent, an unparseable row, that row under a re-reduce
//   D. THE CONSTRUCTOR — the core cursor lost bricks every wake
//   E. THE LADDER — a deterministic failure walks all 15 rungs; on a paused stream it never ends
//   F. STORAGE UNDER A LIVE INCARNATION — deleteAll() with the stream still in memory

import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { expect, onTestFinished, test, vi } from "vitest";
import { createFailing } from "@iterate-com/shared/test-support/failing-test";
import type { ItxExpression } from "iterate/expression";
import { errorCode } from "iterate/lib";
import { stub, until } from "./support.ts";

const MiB = 1024 * 1024;
/** The workers project's own test timeout (vitest.config.ts): a pin gets the same budget. */
const PIN_TIMEOUT_MS = 120_000;

// ── the observation plumbing ──

/** The error a call rejects with (own enumerable props kept — `code`, workerd's `remote`,
 *  `durableObjectReset`, `retryable`, `overloaded` ride as own props across every hop), or undefined. */
type ObservedError = Error & Record<string, unknown>;

/** Every `reportIssue` line (lib.ts prints ONE console.error object per issue, `event:
 *  "issue"`) the DO emits while a row runs — the DO shares this isolate, so its console is ours.
 *  Issue lines are captured (not printed: they are the noise these rows are about); anything else
 *  console.error'd passes through. */
type IssueLine = {
  event: string;
  failureSite?: string;
  code?: string;
  error?: { type: string; message: string };
};
const issues: IssueLine[] = [];

/** One `itx.subscriptions.get(name)` row — the reduced table joined with the stream-kept cursor. */
type SubscriptionRow = {
  name: string;
  cursor?: { confirmedOffset: number; attempt: number; nextAttemptAtMs?: number };
  halted?: { afterOffset: number; attempts: number; error?: string };
} | null;

/** A bare, well-behaved hosted class — a processor host with no engine, enough for the load chain. */
const FINE_SRC = /* js */ `
import { FacetDurableObject } from "./processor.js";
export class FineDurableObject extends FacetDurableObject {
  static publicMethods = [...super.publicMethods, "snapshot"];
  processEventBatch() {}
  catchUpFromLog() {}
  snapshot() { return { ok: true }; }
}
`;

// ═══════════════════════════════ A. THE CELL CAP ═══════════════════════════════

// The core checkpoint is one storage cell: a configure whose state would not fit is refused CODED
// (REDUCE_CHECKPOINT_TOO_LARGE — ReduceCheckpointTable measures the state BEFORE the write), naming
// the cell, the size, the ceiling and "nothing was written". BORN RED: SQLite's own `string or blob
// too big: SQLITE_TOOBIG` crossed the hop with no code, no cap named, from a write already inside
// the transaction (flipped with the one-row checkpoint). The ceiling is the
// documented production cell (2 MB), so local workerd (4 MiB) and the edge now refuse alike.
test("A1 — core state over the checkpoint ceiling: the configure is refused coded, REDUCE_CHECKPOINT_TOO_LARGE, in our words", async () => {
  captureIssueLines();
  const ctx = "prj_ud_corecap_message";
  const s = stub(ctx);
  await s.append({
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: { match: "itx.bigA", target: bigWorkerRuleTarget("A", 1 * MiB) },
  }); // state ≈ 1 MiB: lands
  const err = await rejectionOf(() =>
    s.append({
      type: "events.iterate.com/itx/rewrite-rule-configured",
      payload: { match: "itx.bigB", target: bigWorkerRuleTarget("B", 1.5 * MiB) },
    }),
  ); // state ≈ 2.5 MiB: over the 2 MB cell
  expect(errorCode(err)).toBe("REDUCE_CHECKPOINT_TOO_LARGE");
  expect(err?.message).toMatch(/checkpoint "core".*over the .*ceiling.*nothing was written/);
});

// CONTROL: the refusal is CLEAN — the transaction rolled back, so memory and the log agree (the perf
// review's do-now #1): the table keeps rule A only, the refused configure burns no offset, a smaller
// configure lands right after. Only GROWTH past the ceiling is refused; nothing is wedged.
test("A2 — CONTROL: the refused configure leaves memory and the log consistent — rule A stays, no offset burnt, a smaller rule lands, only growth is refused", async () => {
  captureIssueLines();
  const ctx = "prj_ud_corecap_consistent";
  const s = stub(ctx);
  const a = offsetOf(
    await s.append({
      type: "events.iterate.com/itx/rewrite-rule-configured",
      payload: { match: "itx.bigA", target: bigWorkerRuleTarget("A", 1 * MiB) },
    }),
  );
  const err = await rejectionOf(() =>
    s.append({
      type: "events.iterate.com/itx/rewrite-rule-configured",
      payload: { match: "itx.bigB", target: bigWorkerRuleTarget("B", 1.5 * MiB) },
    }),
  );
  expect(errorCode(err)).toBe("REDUCE_CHECKPOINT_TOO_LARGE");
  const core = (await s.invoke("itx.facets.get('core').snapshot()")) as {
    offset: number;
    state: { itxExpressionRewriteRules: Record<string, unknown> };
  };
  expect(Object.keys(core.state.itxExpressionRewriteRules)).toEqual(["itx.bigA"]);
  expect(core).toMatchObject({ offset: a }); // reduced through rule A, not a phantom B
  // The refused batch's offset was never burnt: the next durable event lands at a+1 — exactly
  // where B would have.
  const c = offsetOf(
    await s.append({
      type: "events.iterate.com/itx/rewrite-rule-configured",
      payload: { match: "itx.small", target: "itx.whoami" },
    }),
  );
  expect(c).toBe(a + 1);
  const page = (await s.invoke(["itx", ["readEvents", 0, 500]])) as {
    events: { offset: number }[];
  };
  expect(page.events.map((e) => e.offset)).toEqual([1, 2, a, c]);
  expect(drainIssues()).toEqual([]);
});

// WHAT IT DIES OF: the hosting row LANDS (a 4.5 MiB event is under the 8 MiB append ceiling), then
// `FacetHost#callFacet`'s startup memo `kv.put("facet:big", spec)` dies of `string or blob too big:
// SQLITE_TOOBIG` — at the enable-time catch-up AND on every push after it. Worse than a refusal:
// with no memo, every push takes the recovery path (`read(configuredAtOffset - 1, 1)`), re-reads
// and re-parses the 4.5 MiB event out of SQLite, and dies at the same put. `snapshot()` rejects with
// the same raw text. Production's cell is 2 MB, so a 2–8 MiB processor bundle is exactly this row.
createFailing(test, /snapshot\(\) dies of "string or blob too big: SQLITE_TOOBIG"/, {
  timeoutMs: PIN_TIMEOUT_MS,
})(
  "A3 — a hosting spec whose source is over the cell cap but under the append ceiling LANDS, then can never materialize: every push re-reads the event and dies of the raw SQLITE_TOOBIG at the facet memo",
  async () => {
    captureIssueLines();
    const ctx = "prj_ud_facetmemo_cap";
    const s = stub(ctx);
    drainIssues();
    const source = FINE_SRC + "\n// " + "x".repeat(4.5 * MiB) + "\n";
    const enableErr = await rejectionOf(() =>
      enableProcessorByEvent(ctx, "big", source, "FineDurableObject"),
    );
    await untilIssue("subscription-delivery.configured", /SQLITE_TOOBIG/);
    await s.append({ type: "work" });
    await untilIssue("subscription-delivery.deliver", /SQLITE_TOOBIG/);
    const snapshotErr = await rejectionOf(() => snapshotOf(ctx, "big"));
    expect(
      enableErr && errorCode(enableErr),
      `a hosting spec that cannot be memoized should be refused on append; snapshot() dies of "${snapshotErr?.message}"`,
    ).toBeDefined();
  },
);

/** A processor whose reduce HOARDS every payload: the checkpoint cell grows with the log. */
const HOARDER_SRC = /* js */ `
import { StreamProcessor, StreamProcessorDurableObject } from "./processor.js";
class HoarderProcessor extends StreamProcessor {
  contract = { slug: "hoarder", version: "1.0.0", consumes: ["blob"], emits: [], initialState: () => ({ blobs: [] }) };
  reduce({ event, state }) { return { blobs: [...state.blobs, event.payload.blob] }; }
  projectLiveState(state) { return { n: state.blobs.length }; }
}
export class HoarderDurableObject extends StreamProcessorDurableObject { processor = new HoarderProcessor(); }
`;

// A facet whose reduce keeps every payload outgrows the checkpoint cell at its 3rd MiB: the write is
// refused CODED (REDUCE_CHECKPOINT_TOO_LARGE, before anything lands), and the refusal is stamped
// non-retryable, so the delivery loop halts the row at its first attempt; `snapshot()` answers with
// the same coded refusal. BORN RED twice: as the platform's raw `string or blob too big:
// SQLITE_TOOBIG` from inside the write, then as a wedge that re-reduced and re-refused on every
// commit and every wake, never a halt.
test("A4 — a facet whose checkpoint outgrows the cell ceiling is refused coded and its row halts at once: no retry per commit", async () => {
  captureIssueLines();
  const ctx = "prj_ud_facetcheckpoint_cap";
  const s = stub(ctx);
  drainIssues();
  await enableProcessorByEvent(ctx, "hoarder", HOARDER_SRC, "HoarderDurableObject", ["blob"]);
  for (let i = 0; i < 4; i++) {
    await s.append({ type: "blob", payload: { blob: `${i}:` + "x".repeat(MiB) } });
    await sleep(200);
  }
  const ceiling = /over the \d+-char ceiling of one storage cell/;
  const halted = await until(
    "the hoarder row halts",
    async () => (await subscriptionRow(ctx, "hoarder"))?.halted,
  );
  expect(halted).toMatchObject({ attempts: 1, error: expect.stringMatching(ceiling) });
  expect(errorCode(await rejectionOf(() => snapshotOf(ctx, "hoarder")))).toBe(
    "REDUCE_CHECKPOINT_TOO_LARGE",
  );
  // …and the NEXT commit, tiny, is not pushed into the same wall: the row stays halted where it was.
  await s.append({ type: "blob", payload: { blob: "small" } });
  await sleep(500);
  expect((await subscriptionRow(ctx, "hoarder"))?.halted).toEqual(halted);
  expect(drainIssues()).toEqual([]);
});

// ═══════════════════════ B. A SOURCE THAT CANNOT START ═══════════════════════

// WHAT IT DIES OF: `Error: internal error; reference = <opaque id>` — workerd's catch-all, one fresh
// reference id per call, no class name, no hint. `FacetHost#callFacet`'s own `if (!klass) throw new Error(
// 'loaded worker does not export class …')` is DEAD CODE: `getDurableObjectClass` never returns
// falsy — it hands back a handle that fails inside the runtime when the facet starts. Every push
// (one `subscription-delivery.deliver` line per commit) and every read dies of it, until disabled.
createFailing(test, /it dies of "internal error; reference = [a-z0-9]+"/, {
  timeoutMs: PIN_TIMEOUT_MS,
})(
  "B1 — className not exported: every push and every read dies of workerd's OPAQUE `internal error; reference = <id>` — the host's own `does not export class` check is dead code",
  async () => {
    captureIssueLines();
    const err = await facetThatCannotStart("prj_ud_start_noclass", FINE_SRC, "Nope");
    expect(
      err?.message,
      `a facet whose class is not exported should fail naming the class; it dies of "${err?.message}"`,
    ).toContain("Nope");
  },
);

const EVAL_THROWS_SRC = /* js */ `
import { DurableObject } from "cloudflare:workers";
export class EvalBoomDurableObject extends DurableObject { processEventBatch() {} catchUpFromLog() {} snapshot() { return { ok: true }; } }
throw new Error("boom at module evaluation");
`;

// WHAT IT DIES OF: `Error: Failed to start Worker:\nUncaught Error: boom at module evaluation\n  at
// cap.js:4:7` — the platform's envelope around the author's throw, no code. workerd keeps the failed
// isolate under its loader id for the process's life (the worker-loader.ts WORKAROUND covers a
// PRODUCER that threw, not code that fails to start), so every push re-hits it — one
// `subscription-delivery.deliver` line per commit — and every read rejects the same way.
createFailing(
  test,
  /it dies of "Failed to start Worker:\nUncaught Error: boom at module evaluation/,
  {
    timeoutMs: PIN_TIMEOUT_MS,
  },
)(
  "B2 — a module that throws at evaluation: every push and read dies of the platform's `Failed to start Worker: Uncaught Error: …` envelope, replayed per commit",
  async () => {
    captureIssueLines();
    const err = await facetThatCannotStart(
      "prj_ud_start_evalthrows",
      EVAL_THROWS_SRC,
      "EvalBoomDurableObject",
    );
    expect(
      errorCode(err),
      `a module that throws at evaluation should fail coded, in our words; it dies of "${err?.message}"`,
    ).toBeDefined();
  },
);

const CTOR_THROWS_SRC = /* js */ `
import { DurableObject } from "cloudflare:workers";
export class CtorBoomDurableObject extends DurableObject {
  constructor(ctx, env) { super(ctx, env); throw new Error("boom in the facet constructor"); }
  processEventBatch() {} catchUpFromLog() {} snapshot() { return { ok: true }; }
}
`;

// WHAT IT DIES OF: the author's own `boom in the facet constructor` — but through the platform's
// `broken.constructorFailed` path (workerd io/worker.c++ annotates the actor as broken and aborts
// it), so it arrives stamped `durableObjectReset: true` with no code, and the container is torn down
// and rebuilt on EVERY call: the constructor throws again per push (one `subscription-delivery.deliver`
// line per commit, one "Annotating with brokenness" runtime line each) and per read.
createFailing(test, /it dies of "boom in the facet constructor" \(durableObjectReset: true\)/, {
  timeoutMs: PIN_TIMEOUT_MS,
})(
  "B3 — a class whose constructor throws: `broken.constructorFailed` — the author's message arrives stamped durableObjectReset, no code, the constructor re-run on every push and read",
  async () => {
    captureIssueLines();
    const err = await facetThatCannotStart(
      "prj_ud_start_ctorthrows",
      CTOR_THROWS_SRC,
      "CtorBoomDurableObject",
    );
    expect(
      errorCode(err),
      `a constructor that throws should fail coded, in our words; it dies of "${err?.message}" (durableObjectReset: ${err?.durableObjectReset})`,
    ).toBeDefined();
  },
);

// CONTROL: none of the three is a wedge — `processors.disable` (the null row) still lands, and takes
// the row, the facet and its startup memo with it, so the operator's way out exists.
test("B4 — CONTROL: a facet that cannot start is still disable-able — the null row lands, the memo and the row go", async () => {
  captureIssueLines();
  for (const [ctx, src, className] of [
    ["prj_ud_disable_noclass", FINE_SRC, "Nope"],
    ["prj_ud_disable_evalthrows", EVAL_THROWS_SRC, "EvalBoomDurableObject"],
    ["prj_ud_disable_ctorthrows", CTOR_THROWS_SRC, "CtorBoomDurableObject"],
  ] as const) {
    await facetThatCannotStart(ctx, src, className);
    expect(await facetStartupMemoPresent(ctx, "p")).toBe(true);
    await disableProcessorByEvent(ctx, "p");
    expect(await facetStartupMemoPresent(ctx, "p")).toBe(false);
    expect(await subscriptionRow(ctx, "p")).toBeNull();
    expect(errorCode(await rejectionOf(() => snapshotOf(ctx, "p")))).toBe("NO_FACET");
  }
  drainIssues();
});

// ═══════════════════════════ C. POISON EVENTS ═══════════════════════════

/** A processor whose EFFECT hook throws on one marked event. The reduce is guarded (processor.ts
 *  `#reduceAndProcessEvent` reports and skips a throwing reduce); `processEvent` is not. */
const POISON_SRC = /* js */ `
import { StreamProcessor, StreamProcessorDurableObject } from "./processor.js";
class PoisonProcessor extends StreamProcessor {
  contract = { slug: "poison", version: "1.0.0", consumes: ["work"], emits: [], initialState: () => ({ n: 0 }) };
  reduce({ state }) { return { n: state.n + 1 }; }
  processEvent({ event }) { if (event && event.payload && event.payload.poison) throw new Error("poison: refusing offset " + event.offset); }
}
export class PoisonDurableObject extends StreamProcessorDurableObject { processor = new PoisonProcessor(); }
`;

// WHAT IT DIES OF: the author's `poison: refusing offset N` — informative, but the ENGINE has no
// answer to a deterministic throw: the batch persists nothing ("retried whole"), so every later
// commit's push gap-repairs from the checkpoint, re-reads the log from there (a span that grows by
// one event per commit), re-throws at the same event (one `subscription-delivery.deliver` line per
// commit), and `snapshot()` — which catches up first — rejects with it. Disable + re-enable rebuilds
// from the log and hits the same event again. The only way out is to change the code.
createFailing(
  test,
  /at offset (\d+); it dies of "poison: refusing offset \1", and after a rebuild of "poison: refusing offset \1"/,
  { timeoutMs: PIN_TIMEOUT_MS },
)(
  "C1 — a processEvent that throws on ONE event wedges the facet at that offset forever: every commit re-reads the gap and re-throws, snapshot() rejects, disable + re-enable rebuilds into the same wedge",
  async () => {
    captureIssueLines();
    const ctx = "prj_ud_poison_effect";
    const s = stub(ctx);
    await enableProcessorByEvent(ctx, "poison", POISON_SRC, "PoisonDurableObject", ["work"]);
    await s.append({ type: "work" });
    await until(
      "n = 1",
      async () => ((await snapshotOf(ctx, "poison")) as { state: { n: number } }).state.n === 1,
    );
    drainIssues();
    const poison = offsetOf(await s.append({ type: "work", payload: { poison: true } }));
    await untilIssue("subscription-delivery.deliver", /poison: refusing offset/);
    drainIssues();
    await s.append({ type: "work" }); // a clean commit after it: dies again (the gap repair re-reads the poison)
    await untilIssue("subscription-delivery.deliver", /poison: refusing offset/);
    const snapshotErr = await rejectionOf(() => snapshotOf(ctx, "poison"));
    // The rebuild: the same log, the same event, the same wall.
    await disableProcessorByEvent(ctx, "poison");
    await enableProcessorByEvent(ctx, "poison", POISON_SRC, "PoisonDurableObject", ["work"]);
    drainIssues();
    const rebuiltErr = await rejectionOf(() => snapshotOf(ctx, "poison"));
    // WANTED: a throwing effect is reported and skipped like a throwing reduce, so the facet stays
    // readable — `snapshot()` answers as of its checkpoint.
    expect(
      snapshotErr,
      `snapshot() should answer past the poison at offset ${poison}; it dies of "${snapshotErr?.message}", and after a rebuild of "${rebuiltErr?.message}"`,
    ).toBeUndefined();
  },
);

// WHAT IT DIES OF: `SyntaxError: Unexpected token 'o', "not json" is not valid JSON` — V8's parser,
// from `Stream.read`'s `JSON.parse` of the cell, naming NO offset. Every reader pages through
// `read`: the client's own `read`, `waitForEvent`'s history scan, every facet's catch-up and gap
// repair, the cursor delivery's pages, the memo recovery. One bad cell, every reader dead, no way to
// tell WHICH row from the message.
// An unparseable stored body is coded EVENT_UNREADABLE naming its offset, so a reader can read on
// past it — BORN RED as V8's raw `is not valid JSON` from `read()` / waitForEvent's scan, naming
// nothing (flipped 2026-09-04, the typed storage read).
test("C2 — one unparseable row body is a coded EVENT_UNREADABLE naming its offset, from read() and from waitForEvent's history scan", async () => {
  captureIssueLines();
  const ctx = "prj_ud_corrupt_row";
  const s = stub(ctx);
  const seed = offsetOf(await s.append({ type: "seed" }));
  await corruptRow(ctx, seed);
  const readErr = await rejectionOf(() => s.read(0));
  const waitErr = await rejectionOf(() =>
    s.invoke(["itx", ["waitForEvent", { type: "never", afterOffset: 0, timeoutMs: 100 }]]),
  );
  expect(errorCode(readErr)).toBe("EVENT_UNREADABLE");
  expect(errorCode(waitErr)).toBe("EVENT_UNREADABLE");
  expect(readErr?.message).toContain(String(seed)); // it names the offset to read on from
  // …and read(seed) skips it: the seed row is the only durable, so the next page is empty and at head.
  expect(await s.read(seed)).toMatchObject({ events: [] });
});

// WHAT IT DIES OF: the same SyntaxError — from the CONSTRUCTOR. A core contract version bump
// discards the checkpoint (src/stream/stream.ts gates the state on `reducerVersion`) and
// re-reduces the log from offset 0 in `new Stream(…)`; the re-reduce pages `read`, `read` dies at the
// bad cell, the constructor throws, and it throws again on every wake — `runInDurableObject`
// included, so there is no path left to repair the row through. Staged here by writing a foreign
// `reducerVersion` into the cursor cell (what a deploy with a bumped `CoreContract.version` does).
// The constructor's re-reduce (a core version bump discards the checkpoint and re-reduces from 0)
// SKIPS an unreadable row and reports it, so the context wakes — BORN RED as the raw SyntaxError
// from `new Stream(…)` on EVERY wake, bricking the context, runInDurableObject included (flipped
// 2026-09-04, the typed storage read skips it in the re-reduce loop).
test("C3 — that row under a core version bump: the constructor's re-reduce skips the unreadable row and reports it, and the context wakes", async () => {
  captureIssueLines();
  const ctx = "prj_ud_corrupt_row_rereduce";
  const s = stub(ctx);
  const seed = offsetOf(await s.append({ type: "seed" }));
  await corruptRow(ctx, seed);
  await runInDurableObject(s, (_instance, state) => {
    state.storage.sql.exec(
      "UPDATE reduce_checkpoints SET reducer_version = '0.0.0' WHERE slug = 'core'",
    );
    return Promise.resolve();
  });
  await evictDurableObject(s);
  const snapshot = (await s.invoke("itx.facets.get('core').snapshot()")) as { offset: number };
  expect(snapshot.offset).toBeGreaterThanOrEqual(seed); // re-reduced past the skipped row
  expect(offsetOf(await s.append({ type: "after" }))).toBeGreaterThan(seed); // and the log goes on
});

// ═══════════════════════════ D. THE CONSTRUCTOR ═══════════════════════════

// The core checkpoint row is a CACHE of the log: with it gone the constructor re-derives the mark
// from the rows (`MAX(offset)`), re-reduces the core state from offset 0, and reports one issue
// line — never fatal. BORN RED: the constructor read mark 0, decided the store was VIRGIN,
// re-appended `itx/created` over offset 1 and died of `UNIQUE constraint failed: events.offset`
// on EVERY wake, every entry point, `runInDurableObject` included — bricked, no operator remedy. Flipped
// with the SQL storage module.
test("D1 — the core checkpoint row lost: the constructor re-derives the mark from the rows, re-reduces the log, and the context wakes", async () => {
  captureIssueLines();
  const ctx = "prj_ud_cursor_lost";
  const s = stub(ctx);
  const seed = offsetOf(await s.append({ type: "seed" }));
  await runInDurableObject(s, (_instance, state) => {
    state.storage.sql.exec("DELETE FROM reduce_checkpoints WHERE slug = 'core'");
    return Promise.resolve();
  });
  await evictDurableObject(s);
  const snapshot = (await s.invoke("itx.facets.get('core').snapshot()")) as {
    offset: number;
    state: unknown;
  };
  expect(snapshot.offset).toBeGreaterThanOrEqual(seed); // the mark came back from the rows
  expect(JSON.stringify(snapshot.state)).toContain(ctx); // the state was re-reduced from `itx/created`
  expect(offsetOf(await s.append({ type: "after" }))).toBeGreaterThan(seed); // and the log goes on
});

// ═══════════════════════════════ E. THE LADDER ═══════════════════════════════

/** A cursor row (a stateless worker's `processEventBatch`, which cannot own its progress) whose
 *  every delivery throws a PLAIN Error — retryable, so it climbs the ladder (E1). */
const RETRYING_WORKER_SRC = /* js */ `import { WorkerEntrypoint } from "cloudflare:workers";
export default class extends WorkerEntrypoint { processEventBatch() { throw new Error("flaky sink: try again"); } }`;

// CONTROL: the ladder is finite and the halt is OURS — 1 failure + 14 alarm wakes (1s·2ⁿ capped at
// 30 min: ~7 hours of ladder clock, each rung a billed wake) then `subscription-delivery-halted` with
// the message the loop threw, clipped, in the row.
test("E1 — CONTROL: a RETRYABLE failure (a sink that throws a plain error) walks the whole ladder — 14 alarm wakes after the first failure — then halts with our message", async () => {
  captureIssueLines();
  const ctx = "prj_ud_ladder_live";
  const first = await retryingCursorRow(ctx);
  expect(first?.cursor).toMatchObject({ attempt: 1 });
  expect(first?.halted).toBeUndefined();
  const { fired, row } = await walkLadder(ctx, 20);
  expect(fired).toBeLessThanOrEqual(14); // a real rung may have fired on its own in between
  expect(row?.halted).toEqual({
    afterOffset: first!.cursor!.confirmedOffset,
    attempts: 15,
    error: "flaky sink: try again",
  });
  // The ladder is not an issue line; the halt is a fact in the log. (Scoped to this row: an earlier
  // row's wedged facet may still be reporting in the background.)
  expect(drainIssues().filter((i) => (i as { name?: string }).name === "u")).toEqual([]);
});

// A deterministic failure — an uncallable target throws coded NOT_A_METHOD (callOn, both the dotted
// and the root-apply case), which a retry cannot change — HALTS the row at its FIRST failure, not
// after 14 more rungs over ~7 h. BORN RED as the full ladder (flipped 2026-09-04: deterministicFailure
// in the delivery loop, and callOn root-apply coded).
test("E2 — a deterministic failure (an uncallable target, NOT_A_METHOD) halts the row at once, no ladder", async () => {
  captureIssueLines();
  const first = await uncallableCursorRow("prj_ud_ladder_deterministic");
  expect(first?.halted).toBeDefined(); // halted at the first failure
  expect(first?.halted?.attempts).toBe(1);
});

// On a PAUSED stream the halt fact STILL LANDS — `subscription-delivery-halted` is pause-exempt
// (like created/woken/paused/resumed) — so a cursor row failing while a breaker holds the stream
// reaches `halted` and stops, instead of the halt being refused (STREAM_PAUSED) and the ladder
// restarting from attempt 0 forever. BORN RED as that restart loop (flipped 2026-09-04: the exempt
// list + halt-at-once; the uncallable target here halts at its first failure, NOT_A_METHOD).
test("E3 — on a PAUSED stream the halt fact still lands (pause-exempt) and the row halts, no restart loop", async () => {
  captureIssueLines();
  const ctx = "prj_ud_ladder_paused";
  await uncallableCursorRow(ctx);
  await stub(ctx).append({
    type: "events.iterate.com/itx/paused",
    payload: { reason: "breaker" },
  });
  drainIssues();
  const { row } = await walkLadder(ctx, 3); // it halts at once; a couple of alarm passes confirm no restart
  const refused = issues.find(
    (i) => i.failureSite === "subscription-delivery.cursor" && i.code === "STREAM_PAUSED",
  );
  expect(refused).toBeUndefined(); // the halt append was NOT refused by the pause (pause-exempt)
  expect(row?.halted).toBeDefined(); // the row halted on a paused stream…
  expect(row?.cursor?.attempt ?? 0).toBe(0); // …and did not restart the ladder from attempt 0
});

// ═══════════════════ F. STORAGE UNDER A LIVE INCARNATION ═══════════════════

// WHAT IT DIES OF: `Error: no such table: events: SQLITE_ERROR` — `deleteAll()` drops the tables
// (a SQLite-backed DO's deleteAll clears the whole database), but the incarnation in memory still
// holds its offsets, its core state and its "tables exist" assumption (the constructor creates them
// only on a store with no `incarnation` cell). Every append and every read dies raw until the
// actor is evicted — and this DO has no abort method, so nothing but the platform's idle eviction
// ends it. The core snapshot keeps answering from memory, describing a log that is gone.
createFailing(
  test,
  /append dies of "no such table: events: SQLITE_ERROR", read of "no such table: events: SQLITE_ERROR", the stub's append of "no such table: events: SQLITE_ERROR", and the core snapshot still answers from memory/,
  { timeoutMs: PIN_TIMEOUT_MS },
)(
  "F1 — deleteAll() under a live incarnation: the tables are gone, the memory is not — every append and read dies of `no such table: events` until an eviction nobody can force",
  async () => {
    captureIssueLines();
    const ctx = "prj_ud_deleteall_live";
    const s = stub(ctx);
    const errs = await runInDurableObject(s, async (instance, state) => {
      await instance.append({ type: "before" });
      await state.storage.deleteAll();
      return {
        append: await rejectionOf(() => instance.append({ type: "after" })),
        read: await rejectionOf(() => Promise.resolve(instance.read(0))),
        snapshot: await rejectionOf(() => instance.invoke("itx.facets.get('core').snapshot()")),
      };
    });
    const viaStub = await rejectionOf(() => s.append({ type: "after, via the stub" }));
    const snapshot = errs.snapshot
      ? `dies of "${errs.snapshot.message}"`
      : "still answers from memory";
    // WANTED: the stream notices its store was reset and starts over, or refuses in its own words.
    expect(
      errs.append,
      `after deleteAll() the stream should start over; append dies of "${errs.append?.message}", read of "${errs.read?.message}", the stub's append of "${viaStub?.message}", and the core snapshot ${snapshot}`,
    ).toBeUndefined();
  },
);

// ── the observation plumbing ──

/** Capture the DO's `reportIssue` lines into `issues` until the test finishes: issue lines are
 *  captured (not printed: they are the noise these rows are about); anything else console.error'd
 *  passes through. */
function captureIssueLines(): void {
  const originalConsoleError = console.error.bind(console);
  const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    const [first] = args;
    if (typeof first === "object" && first && (first as IssueLine).event === "issue")
      issues.push(first as IssueLine);
    else originalConsoleError(...args);
  });
  onTestFinished(() => {
    consoleErrorSpy.mockRestore();
  });
}

function drainIssues(): IssueLine[] {
  return issues.splice(0);
}

/** Poll until an issue line at `failureSite` whose message matches `pattern` has been reported. */
function untilIssue(failureSite: string, pattern: RegExp, timeoutMs = 10_000): Promise<IssueLine> {
  return until(
    `issue ${failureSite} ${pattern}`,
    async () =>
      issues.find((i) => i.failureSite === failureSite && pattern.test(i.error?.message ?? "")),
    timeoutMs,
  );
}

/** The error a call rejects with, or undefined. */
async function rejectionOf(fn: () => unknown): Promise<ObservedError | undefined> {
  try {
    await fn();
    return undefined;
  } catch (error) {
    return (error instanceof Error ? error : new Error(String(error))) as ObservedError;
  }
}

function sleep(ms = 150) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── the DO's entry points, spelled the way the edge spells them ──

/** What `itx.enableProcessorByEvent(name, { source, className })` appends, spelled RAW on the DO's `append`:
 *  ONE subscription-configured row whose target hosts the class as the facet `name`
 *  (alarm-and-pins.test.ts spells it the same way). */
function hostingTarget(name: string, source: string, className: string): ItxExpression {
  return [
    "itx",
    "facets",
    ["get", name, { source: { "cap.js": source }, className }],
    "processEventBatch",
  ];
}

function enableProcessorByEvent(
  ctx: string,
  name: string,
  source: string,
  className: string,
  consumes?: string[],
) {
  return stub(ctx).append({
    type: "events.iterate.com/itx/subscription-configured",
    payload: {
      name,
      target: hostingTarget(name, source, className),
      consumes,
    },
  });
}

function disableProcessorByEvent(ctx: string, name: string) {
  return stub(ctx).append({
    type: "events.iterate.com/itx/subscription-configured",
    payload: { name, target: null },
  });
}

function snapshotOf(ctx: string, name: string) {
  return stub(ctx).invoke(["itx", "facets", ["get", name], ["snapshot"]]);
}

function subscriptionRow(ctx: string, name: string) {
  return stub(ctx).invoke(`itx.subscriptions.get('${name}')`) as Promise<SubscriptionRow>;
}

function facetStartupMemoPresent(ctx: string, name: string) {
  return runInDurableObject(stub(ctx), (_instance, state) =>
    Promise.resolve(state.storage.kv.get(`facet:${name}`) !== undefined),
  );
}

/** The offset of the first event `append` returned (workers-types' Rpc.Serializable types a
 *  StreamEvent-returning stub method as `never`, hence the cast). */
function offsetOf(appended: unknown): number {
  return (appended as { offset: number }[])[0].offset;
}

// ── A. the cell cap ──

/** A rewrite-rule target that carries a `workers.get({ source })` spec inline: a HOSTED facet's
 *  source is elided from core state, but a `workers.get` source is not — so
 *  each such rule adds its whole source to the core checkpoint's state cell. */
function bigWorkerRuleTarget(tag: string, chars: number): ItxExpression {
  return [
    "itx",
    "workers",
    ["get", { source: { "cap.js": `// ${tag}\n` + "x".repeat(chars) } }],
    "hello",
  ];
}

// ── B. a source that cannot start ──

/** Host `src` as the facet `p`, wait for its first failed push, and return what `snapshot()` dies of. */
async function facetThatCannotStart(
  ctx: string,
  src: string,
  className: string,
): Promise<ObservedError | undefined> {
  drainIssues();
  await enableProcessorByEvent(ctx, "p", src, className);
  await stub(ctx).append({ type: "work" });
  await untilIssue("subscription-delivery.deliver", /./);
  return rejectionOf(() => snapshotOf(ctx, "p"));
}

// ── C. poison events ──

/** Overwrite one row's body with something JSON.parse refuses — the shape of a corrupted cell. */
function corruptRow(ctx: string, offset: number) {
  return runInDurableObject(stub(ctx), (_instance, state) => {
    state.storage.sql.exec("UPDATE events SET body = 'not json' WHERE offset = ?", offset);
    return Promise.resolve();
  });
}

// ── E. the ladder ──

/** A cursor row on RETRYING_WORKER_SRC: every delivery throws a plain, retryable Error (E1). */
async function retryingCursorRow(ctx: string): Promise<SubscriptionRow> {
  const s = stub(ctx);
  await s.append({
    type: "events.iterate.com/itx/subscription-configured",
    payload: {
      name: "u",
      target: [
        "itx",
        "workers",
        ["get", { source: { "cap.js": RETRYING_WORKER_SRC } }],
        "processEventBatch",
      ],
      consumes: ["mark"],
    },
  });
  await s.append({ type: "mark" });
  return until("the first ladder attempt", async () => {
    const row = await subscriptionRow(ctx, "u");
    return (row?.cursor?.attempt ?? 0) >= 1 ? row : undefined;
  });
}

/** A CURSOR row whose target can never be called: `itx.kv` is a two-step target, root-called whole
 *  (subscription-delivery.ts `#evaluateItxExpressionTargetHead`), and the kv root is a plain object
 *  — `callOn` refuses it, deterministically, every time. */
async function uncallableCursorRow(ctx: string): Promise<SubscriptionRow> {
  const s = stub(ctx);
  await s.append({
    type: "events.iterate.com/itx/subscription-configured",
    payload: { name: "u", target: "itx.kv", consumes: ["mark"] },
  });
  await s.append({ type: "mark" });
  return until("the first failure (a halt or a ladder attempt)", async () => {
    const row = await subscriptionRow(ctx, "u");
    return row?.halted !== undefined || (row?.cursor?.attempt ?? 0) >= 1 ? row : undefined;
  });
}

/** Fire the DO's alarm up to `fires` times with Date faked 40 minutes further each time (past the
 *  ladder's 30-minute ceiling plus its 20% jitter; sockets and real timers stay real — support.ts's releasePins shape), and
 *  return how many alarms actually ran and the row after the last. Stops early when `halted`. */
async function walkLadder(
  ctx: string,
  fires: number,
): Promise<{ fired: number; row: SubscriptionRow }> {
  let fired = 0;
  let row: SubscriptionRow = null;
  vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
  try {
    for (let i = 0; i < fires; i++) {
      vi.setSystemTime(Date.now() + 40 * 60_000);
      if (await runDurableObjectAlarm(stub(ctx))) fired++;
      await sleep(30);
      row = await subscriptionRow(ctx, "u");
      if (row?.halted) break;
    }
  } finally {
    vi.useRealTimers();
  }
  return { fired, row };
}
