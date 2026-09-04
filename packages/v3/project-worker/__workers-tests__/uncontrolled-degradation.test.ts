// __workers-tests__/uncontrolled-degradation.test.ts — THE RED PINS of the 2026-09-04 hunt for
// UNCONTROLLED degradation: every way this context can still fail in a manner the PLATFORM decides
// for us — a message we did not write, a wedge with no operator door, a retry that never ends —
// beyond out-of-memory (local workerd enforces no memory limit; the memory pins live in
// src/stream/memory-budget.test.ts and e2e/stream-memory-budget.e2e.test.ts). Each row stages one
// scenario against a REAL `IterateContextDurableObject` inside workerd (runInDurableObject for its
// storage, evictDurableObject for a fresh incarnation, runDurableObjectAlarm for the ladder) and
// pins EXACTLY what it dies of today: the observed message, verbatim.
//
// THE CONVENTION. Every red row is `test.fails` (the house convention for a known-red proof — the
// lane stays green; flipping a row back to `test` is how a fix is proved), and every one opens with
// the PIN GUARD `stillDiesOf` / `stillRed`: the failure the row dies of TODAY, as a pattern on the
// observed message. While it still matches, the row goes on to assert the behavior it WANTS and
// fails there (an expected failure, green). The moment the observed failure MOVES — fixed, or broken
// some other way — the guard returns false, the row `return`s early and COMPLETES, and `test.fails`
// turns it RED with the guard's own line in the output: the one signal that says "look at this pin
// again". A bare `test.fails` cannot tell a fix from a different breakage; the guard can. To flip a
// fixed row to `test`, delete its guard line and keep its assertions.
//
// Two cell-cap facts these rows lean on (scratchpad/platform-facts.md §5): a SQLite-backed DO's
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
//   G. THE RESERVED NAME — a raw row named `core`

import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterAll, expect, test, vi } from "vitest";
import { print, type ItxExpression } from "../src/context/expression.ts";
import { rewriteRuleConfiguredEvent } from "../src/context/itx-expression-rewriting.ts";
import { errorCode } from "../src/lib/errors.ts";
import { subscriptionConfiguredEvent } from "../src/stream/subscriptions.ts";
import { stub } from "./support.ts";

const MiB = 1024 * 1024;
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

// ── THE PIN GUARD (see the header) ──

/** `holds` is whether the row's pinned failure is still what happens; `observed` describes what was
 *  seen. True ⇒ still red for the stated reason, carry on to the WANTED assertions. False ⇒ the pin
 *  MOVED: the caller returns early, the row completes, `test.fails` turns it red, and this line says why. */
function stillRed(pinnedReason: string, holds: boolean, observed: string): boolean {
  if (holds) return true;
  console.warn(`PIN MOVED — pinned: ${pinnedReason} — observed: ${observed}`);
  return false;
}
/** The pin guard for a row whose failure is an ERROR: still red while `observed` is an Error whose
 *  message matches `reason`. */
function stillDiesOf(observed: unknown, reason: RegExp): boolean {
  const message = observed instanceof Error ? observed.message : undefined;
  return stillRed(
    `dies of ${reason}`,
    message !== undefined && reason.test(message),
    observed === undefined ? "no failure at all" : `${String(observed)}`,
  );
}

// ── the observation plumbing ──

/** The error a call rejects with (own enumerable props kept — `code`, workerd's `remote`,
 *  `durableObjectReset`, `retryable`, `overloaded` ride as own props across every hop), or undefined. */
type ObservedError = Error & Record<string, unknown>;
async function rejectionOf(fn: () => unknown): Promise<ObservedError | undefined> {
  try {
    await fn();
    return undefined;
  } catch (error) {
    return (error instanceof Error ? error : new Error(String(error))) as ObservedError;
  }
}

/** Every `reportIssue` line (lib/errors.ts prints ONE console.error object per issue, `event:
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
const originalConsoleError = console.error.bind(console);
const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
  const [first] = args;
  if (typeof first === "object" && first !== null && (first as IssueLine).event === "issue")
    issues.push(first as IssueLine);
  else originalConsoleError(...args);
});
afterAll(() => consoleErrorSpy.mockRestore());
const drainIssues = (): IssueLine[] => issues.splice(0);
/** Poll until an issue line at `failureSite` whose message matches `pattern` has been reported. */
const untilIssue = (failureSite: string, pattern: RegExp, timeoutMs = 10_000): Promise<IssueLine> =>
  until(
    `issue ${failureSite} ${pattern}`,
    async () =>
      issues.find((i) => i.failureSite === failureSite && pattern.test(i.error?.message ?? "")),
    timeoutMs,
  );

async function until<T>(
  label: string,
  fn: () => Promise<T | undefined | false>,
  timeoutMs = 10_000,
): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v !== undefined && v !== false) return v;
    if (Date.now() - t0 > timeoutMs)
      throw new Error(`until(${label}): timed out after ${timeoutMs}ms`);
    await settle(25);
  }
}

// ── the DO doors, spelled the way the edge spells them ──

/** The edge's `enableProcessor(name, { source, className })`: ONE subscription-configured row whose
 *  target hosts the class as the facet `name` (alarm-quiesce.test.ts spells it the same way). */
const hostingTarget = (name: string, source: string, className: string): ItxExpression => [
  "itx",
  "facets",
  ["get", name, { source: { "cap.js": source }, className }],
  "processEventBatch",
];
const enableProcessor = (
  ctx: string,
  name: string,
  source: string,
  className: string,
  consumes?: string[],
) =>
  stub(ctx).append(
    subscriptionConfiguredEvent({
      name,
      target: hostingTarget(name, source, className),
      ...(consumes && { consumes }),
    }),
  );
const disableProcessor = (ctx: string, name: string) =>
  stub(ctx).append(subscriptionConfiguredEvent({ name, target: null }));
const snapshotOf = (ctx: string, name: string) =>
  stub(ctx).invoke(["itx", "facets", ["get", name], ["snapshot"]]);
type SubscriptionRow = {
  name: string;
  cursor?: { confirmedOffset: number; attempt: number; nextAttemptAtMs?: number };
  halted?: { afterOffset: number; attempts: number; error?: string };
} | null;
const subscriptionRow = (ctx: string, name: string) =>
  stub(ctx).invoke(`itx.subscriptions.get('${name}')`) as Promise<SubscriptionRow>;
const facetStartupMemoPresent = (ctx: string, name: string) =>
  runInDurableObject(stub(ctx), (_instance, state) =>
    Promise.resolve(state.storage.kv.get(`facet:${name}`) !== undefined),
  );
/** The offset of the first event `append` returned (workers-types' Rpc.Serializable types a
 *  StreamEvent-returning stub method as `never`, hence the cast). */
const offsetOf = (appended: unknown): number => (appended as { offset: number }[])[0].offset;

/** A bare, well-behaved hosted class — a processor host with no engine, enough for the load chain. */
const FINE_SRC = /* js */ `
import { DurableObject } from "cloudflare:workers";
export class FineDurableObject extends DurableObject {
  processEventBatch() {}
  catchUpFromLog() {}
  snapshot() { return { ok: true }; }
}
`;

// ═══════════════════════════════ A. THE CELL CAP ═══════════════════════════════

/** A rewrite-rule target that carries a `workers.get({ source })` spec inline: post-M1 a HOSTED facet's
 *  source is elided from core state, but a `workers.get` source is not (oom-audit.md item 6) — so
 *  each such rule adds its whole source to the core checkpoint's state cell. */
const bigWorkerRuleTarget = (tag: string, chars: number): ItxExpression => [
  "itx",
  "workers",
  ["get", { source: { "cap.js": `// ${tag}\n` + "x".repeat(chars) } }],
  "hello",
];

// The core checkpoint is one storage cell: a configure whose state would not fit is refused CODED
// (REDUCE_CHECKPOINT_TOO_LARGE — reduce-checkpoint.ts measures the state BEFORE the write), naming
// the cell, the size, the ceiling and "nothing was written". BORN RED: SQLite's own `string or blob
// too big: SQLITE_TOOBIG` crossed the hop with no code, no cap named, from a write already inside
// the transaction (flipped with the one-row checkpoint, BUILD-LOG 2026-09-04). The ceiling is the
// documented production cell (2 MB), so local workerd (4 MiB) and the edge now refuse alike.
test("A1 — core state over the checkpoint ceiling: the configure is refused coded, REDUCE_CHECKPOINT_TOO_LARGE, in our words", async () => {
  const ctx = "prj_ud_corecap_message";
  const s = stub(ctx);
  await s.append(rewriteRuleConfiguredEvent("itx.bigA", bigWorkerRuleTarget("A", 1 * MiB))); // state ≈ 1 MiB: lands
  const err = await rejectionOf(() =>
    s.append(rewriteRuleConfiguredEvent("itx.bigB", bigWorkerRuleTarget("B", 1.5 * MiB))),
  ); // state ≈ 2.5 MiB: over the 2 MB cell
  expect(errorCode(err)).toBe("REDUCE_CHECKPOINT_TOO_LARGE");
  expect(err?.message).toMatch(/checkpoint "core".*over the .*ceiling.*nothing was written/);
});

// CONTROL: the refusal is CLEAN — the transaction rolled back, so memory and the log agree (the perf
// review's do-now #1): the table keeps rule A only, the refused configure burns no offset, a smaller
// configure lands right after. Only GROWTH past the ceiling is refused; nothing is wedged.
test("A2 — CONTROL: the refused configure leaves memory and the log consistent — rule A stays, no offset burnt, a smaller rule lands, only growth is refused", async () => {
  const ctx = "prj_ud_corecap_consistent";
  const s = stub(ctx);
  const a = offsetOf(
    await s.append(rewriteRuleConfiguredEvent("itx.bigA", bigWorkerRuleTarget("A", 1 * MiB))),
  );
  const err = await rejectionOf(() =>
    s.append(rewriteRuleConfiguredEvent("itx.bigB", bigWorkerRuleTarget("B", 1.5 * MiB))),
  );
  expect(errorCode(err)).toBe("REDUCE_CHECKPOINT_TOO_LARGE");
  const core = (await s.invoke("itx.facets.get('core').snapshot()")) as {
    offset: number;
    state: { itxExpressionRewriteRules: Record<string, unknown> };
  };
  expect(Object.keys(core.state.itxExpressionRewriteRules)).toEqual(["itx.bigA"]);
  expect(core.offset).toBe(a); // reduced through rule A, not a phantom B
  // The refused batch's offset was never burnt: A's live-state delta took a+1, so the next durable
  // event lands at a+2 — exactly where B would have.
  const c = offsetOf(await s.append(rewriteRuleConfiguredEvent("itx.small", "itx.whoami")));
  expect(c).toBe(a + 2);
  const page = (await s.invoke(["itx", ["readEvents", 0, 500]])) as {
    events: { offset: number }[];
  };
  expect(page.events.map((e) => e.offset)).toEqual([1, 2, a, c]);
  expect(drainIssues()).toEqual([]);
});

// WHAT IT DIES OF: the hosting row LANDS (a 4.5 MiB event is under the 8 MiB append ceiling), then
// `#invokeFacet`'s startup memo `kv.put("facet:big", spec)` dies of `string or blob too big:
// SQLITE_TOOBIG` — at the enable-time catch-up AND on every push after it. Worse than a refusal:
// with no memo, every push takes the M1 recovery path (`read(configuredAtOffset - 1, 1)`), re-reads
// and re-parses the 4.5 MiB event out of SQLite, and dies at the same put. `snapshot()` rejects with
// the same raw text. Production's cell is 2 MB, so a 2–8 MiB processor bundle is exactly this row.
test.fails("A3 — a hosting spec whose source is over the cell cap but under the append ceiling LANDS, then can never materialize: every push re-reads the event and dies of the raw SQLITE_TOOBIG at the facet memo", async () => {
  const ctx = "prj_ud_facetmemo_cap";
  const s = stub(ctx);
  drainIssues();
  const source = FINE_SRC + "\n// " + "x".repeat(4.5 * MiB) + "\n";
  const enableErr = await rejectionOf(() =>
    enableProcessor(ctx, "big", source, "FineDurableObject"),
  );
  await untilIssue("subscription-delivery.configured", /SQLITE_TOOBIG/);
  await s.append({ type: "work" });
  await untilIssue("subscription-delivery.deliver", /SQLITE_TOOBIG/);
  const snapshotErr = await rejectionOf(() => snapshotOf(ctx, "big"));
  if (!stillDiesOf(snapshotErr, /^string or blob too big: SQLITE_TOOBIG$/)) return; // the pin MOVED
  // WANTED: refused AT THE DOOR — a hosting spec that cannot be memoized never becomes a row.
  expect(enableErr && errorCode(enableErr)).toBeDefined();
});

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

// WHAT IT DIES OF: a facet whose reduce keeps every payload outgrows the checkpoint cell at its
// 3rd MiB; the write is refused CODED (REDUCE_CHECKPOINT_TOO_LARGE, before anything lands — born red
// as the platform's raw `string or blob too big: SQLITE_TOOBIG` from inside the write) — and then
// RETRIED: every later commit gap-repairs from the checkpoint, re-reduces the same blobs, dies of the
// same refusal (one `subscription-delivery.deliver` line per commit); `snapshot()` and
// `waitUntilProcessed()` reject with it. No halt, and disable + re-enable would rebuild from the log
// into the same wall. A processor whose state grows with its history hits this eventually.
test.fails("A4 — a facet whose checkpoint outgrows the cell ceiling is refused coded, then WEDGED at that batch forever: the same refusal on every commit and every wake, never a halt", async () => {
  const ctx = "prj_ud_facetcheckpoint_cap";
  const s = stub(ctx);
  await enableProcessor(ctx, "hoarder", HOARDER_SRC, "HoarderDurableObject", ["blob"]);
  let last = 0;
  for (let i = 0; i < 4; i++) {
    last = offsetOf(await s.append({ type: "blob", payload: { blob: `${i}:` + "x".repeat(MiB) } }));
    await settle(200);
  }
  const ceiling = /over the \d+-char ceiling of one storage cell/;
  await untilIssue("subscription-delivery.deliver", ceiling);
  drainIssues();
  const snapshotErr = await rejectionOf(() => snapshotOf(ctx, "hoarder"));
  const waitErr = await rejectionOf(() =>
    s.invoke([
      "itx",
      "facets",
      ["get", "hoarder"],
      ["waitUntilProcessed", { offset: last, timeoutMs: 5_000 }],
    ]),
  );
  expect(errorCode(snapshotErr)).toBe("REDUCE_CHECKPOINT_TOO_LARGE"); // coded, in our words
  expect(errorCode(waitErr)).toBe("REDUCE_CHECKPOINT_TOO_LARGE");
  // …and the NEXT commit, tiny, dies the same way: the wedge is permanent.
  await s.append({ type: "blob", payload: { blob: "small" } });
  const again = await untilIssue("subscription-delivery.deliver", ceiling);
  if (!stillRed("the next commit dies again", again !== undefined, "no repeat")) return; // the pin MOVED
  // WANTED: a halt — the processor stops being pushed and re-reduced after a deterministic refusal.
  expect(again).toBeUndefined();
});

// ═══════════════════════ B. A SOURCE THAT CANNOT START ═══════════════════════

/** Host `src` as the facet `p`, wait for its first failed push, and return what `snapshot()` dies of. */
async function facetThatCannotStart(
  ctx: string,
  src: string,
  className: string,
): Promise<ObservedError | undefined> {
  drainIssues();
  await enableProcessor(ctx, "p", src, className);
  await stub(ctx).append({ type: "work" });
  await untilIssue("subscription-delivery.deliver", /./);
  return rejectionOf(() => snapshotOf(ctx, "p"));
}

// WHAT IT DIES OF: `Error: internal error; reference = <opaque id>` — workerd's catch-all, one fresh
// reference id per call, no class name, no hint. `#invokeFacet`'s own `if (!klass) throw new Error(
// 'loaded worker does not export class …')` is DEAD CODE: `getDurableObjectClass` never returns
// falsy — it hands back a handle that fails inside the runtime when the facet starts. Every push
// (one `subscription-delivery.deliver` line per commit) and every read dies of it, until disabled.
test.fails("B1 — className not exported: every push and every read dies of workerd's OPAQUE `internal error; reference = <id>` — the door's own `does not export class` check is dead code", async () => {
  const err = await facetThatCannotStart("prj_ud_start_noclass", FINE_SRC, "Nope");
  if (!stillDiesOf(err, /^internal error; reference = [a-z0-9]+$/)) return; // the pin MOVED
  // WANTED: the message names the missing class.
  expect(err?.message).toContain("Nope");
});

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
test.fails("B2 — a module that throws at evaluation: every push and read dies of the platform's `Failed to start Worker: Uncaught Error: …` envelope, replayed per commit", async () => {
  const err = await facetThatCannotStart(
    "prj_ud_start_evalthrows",
    EVAL_THROWS_SRC,
    "EvalBoomDurableObject",
  );
  if (!stillDiesOf(err, /^Failed to start Worker:\nUncaught Error: boom at module evaluation/))
    return; // the pin MOVED
  // WANTED: a coded error in our words, wrapping the author's.
  expect(errorCode(err)).toBeDefined();
});

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
test.fails("B3 — a class whose constructor throws: `broken.constructorFailed` — the author's message arrives stamped durableObjectReset, no code, the constructor re-run on every push and read", async () => {
  const err = await facetThatCannotStart(
    "prj_ud_start_ctorthrows",
    CTOR_THROWS_SRC,
    "CtorBoomDurableObject",
  );
  if (
    !stillDiesOf(err, /^boom in the facet constructor$/) ||
    !stillRed("stamped durableObjectReset", err?.durableObjectReset === true, JSON.stringify(err))
  )
    return; // the pin MOVED
  // WANTED: a coded error in our words, wrapping the author's.
  expect(errorCode(err)).toBeDefined();
});

// CONTROL: none of the three is a wedge — `disableProcessor` (the null row) still lands, and takes
// the row, the facet and its startup memo with it, so the operator door out exists.
test("B4 — CONTROL: a facet that cannot start is still disable-able — the null row lands, the memo and the row go", async () => {
  for (const [ctx, src, className] of [
    ["prj_ud_disable_noclass", FINE_SRC, "Nope"],
    ["prj_ud_disable_evalthrows", EVAL_THROWS_SRC, "EvalBoomDurableObject"],
    ["prj_ud_disable_ctorthrows", CTOR_THROWS_SRC, "CtorBoomDurableObject"],
  ] as const) {
    await facetThatCannotStart(ctx, src, className);
    expect(await facetStartupMemoPresent(ctx, "p")).toBe(true);
    await disableProcessor(ctx, "p");
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
test.fails("C1 — a processEvent that throws on ONE event wedges the facet at that offset forever: every commit re-reads the gap and re-throws, snapshot() rejects, disable + re-enable rebuilds into the same wedge", async () => {
  const ctx = "prj_ud_poison_effect";
  const s = stub(ctx);
  await enableProcessor(ctx, "poison", POISON_SRC, "PoisonDurableObject", ["work"]);
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
  await disableProcessor(ctx, "poison");
  await enableProcessor(ctx, "poison", POISON_SRC, "PoisonDurableObject", ["work"]);
  drainIssues();
  const rebuiltErr = await rejectionOf(() => snapshotOf(ctx, "poison"));
  if (
    !stillDiesOf(snapshotErr, new RegExp(`^poison: refusing offset ${poison}$`)) ||
    !stillDiesOf(rebuiltErr, new RegExp(`^poison: refusing offset ${poison}$`))
  )
    return; // the pin MOVED
  // WANTED: a throwing effect is reported and skipped like a throwing reduce, so the facet stays
  // readable — `snapshot()` answers as of its checkpoint.
  expect(snapshotErr).toBeUndefined();
});

/** Overwrite one row's body with something JSON.parse refuses — the shape of a corrupted cell. */
const corruptRow = (ctx: string, offset: number) =>
  runInDurableObject(stub(ctx), (_instance, state) => {
    state.storage.sql.exec("UPDATE events SET body = 'not json' WHERE offset = ?", offset);
    return Promise.resolve();
  });

// WHAT IT DIES OF: `SyntaxError: Unexpected token 'o', "not json" is not valid JSON` — V8's parser,
// from `Stream.read`'s `JSON.parse` of the cell, naming NO offset. Every reader pages through
// `read`: the client's own `read`, `waitForEvent`'s history scan, every facet's catch-up and gap
// repair, the cursor lane's pages, the M1 memo recovery. One bad cell, every reader dead, no way to
// tell WHICH row from the message.
test.fails("C2 — one unparseable row body poisons every reader: read() and waitForEvent's history scan die of V8's `is not valid JSON`, naming no offset", async () => {
  const ctx = "prj_ud_corrupt_row";
  const s = stub(ctx);
  const seed = offsetOf(await s.append({ type: "seed" }));
  await corruptRow(ctx, seed);
  const readErr = await rejectionOf(() => s.read(0));
  const waitErr = await rejectionOf(() =>
    s.waitForEvent({ type: "never", afterOffset: 0, timeoutMs: 100 }),
  );
  if (
    !stillDiesOf(readErr, /^Unexpected token 'o', "not json" is not valid JSON$/) ||
    !stillDiesOf(waitErr, /^Unexpected token 'o', "not json" is not valid JSON$/)
  )
    return; // the pin MOVED
  // WANTED: a coded error that names the offset of the row that cannot be read.
  expect(readErr?.message).toContain(String(seed));
});

// WHAT IT DIES OF: the same SyntaxError — from the CONSTRUCTOR. A core contract version bump
// discards the checkpoint (`readReduceCheckpoint` gates the state on `reducerVersion`) and
// re-reduces the log from offset 0 in `new Stream(…)`; the re-reduce pages `read`, `read` dies at the
// bad cell, the constructor throws, and it throws again on every wake — `runInDurableObject`
// included, so there is no door left to repair the row through. Staged here by writing a foreign
// `reducerVersion` into the cursor cell (what a deploy with a bumped `CoreContract.version` does).
test.fails("C3 — that row under a core version bump: the constructor's re-reduce dies at the cell on EVERY wake — the context is bricked, runInDurableObject included", async () => {
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
  const wakeErr = await rejectionOf(() => s.invoke("itx.facets.get('core').snapshot()"));
  const doorErr = await rejectionOf(() => runInDurableObject(s, () => Promise.resolve()));
  if (
    !stillDiesOf(wakeErr, /^Unexpected token 'o', "not json" is not valid JSON$/) ||
    !stillDiesOf(doorErr, /^Unexpected token 'o', "not json" is not valid JSON$/)
  )
    return; // the pin MOVED
  // WANTED: the constructor survives an unreadable row (report, skip) and the context answers.
  expect(wakeErr).toBeUndefined();
});

// ═══════════════════════════ D. THE CONSTRUCTOR ═══════════════════════════

// The core checkpoint row is a CACHE of the log: with it gone the constructor re-derives the mark
// from the rows (`MAX(offset)`), re-reduces the core state from offset 0, and reports one issue
// line — never fatal. BORN RED: the constructor read mark 0, decided the store was VIRGIN,
// re-appended `stream/created` over offset 1 and died of `UNIQUE constraint failed: events.offset`
// on EVERY wake, every door, `runInDurableObject` included — bricked, no operator door. Flipped
// with the SQL storage module (BUILD-LOG 2026-09-04).
test("D1 — the core checkpoint row lost: the constructor re-derives the mark from the rows, re-reduces the log, and the context wakes", async () => {
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
  expect(JSON.stringify(snapshot.state)).toContain(ctx); // the state was re-reduced from `stream/created`
  expect(offsetOf(await s.append({ type: "after" }))).toBeGreaterThan(seed); // and the log goes on
});

// ═══════════════════════════════ E. THE LADDER ═══════════════════════════════

/** A CURSOR row whose target can never be called: `itx.kv` is a two-step target, root-called whole
 *  (subscription-delivery.ts `#evaluateItxExpressionTargetHead`), and the kv root is a plain object
 *  — `callOn` refuses it, deterministically, every time. */
async function uncallableCursorRow(ctx: string): Promise<SubscriptionRow> {
  const s = stub(ctx);
  await s.append(subscriptionConfiguredEvent({ name: "u", target: "itx.kv", consumes: ["mark"] }));
  await s.append({ type: "mark" });
  return until("the first failure", async () => {
    const row = await subscriptionRow(ctx, "u");
    return (row?.cursor?.attempt ?? 0) >= 1 ? row : undefined;
  });
}
/** Fire the DO's alarm up to `fires` times with Date faked 40 minutes further each time (past the
 *  ladder's 30-minute ceiling plus its 20% jitter; sockets and real timers stay real — support.ts's quiesce shape), and
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
      await settle(30);
      row = await subscriptionRow(ctx, "u");
      if (row?.halted) break;
    }
  } finally {
    vi.useRealTimers();
  }
  return { fired, row };
}

// CONTROL: the ladder is finite and the halt is OURS — 1 failure + 14 alarm wakes (1s·2ⁿ capped at
// 30 min: ~7 hours of ladder clock, each rung a billed wake) then `subscription-delivery-halted` with
// the message the loop threw, clipped, in the row.
test("E1 — CONTROL: a target that is never callable walks the whole ladder — 14 alarm wakes after the first failure — then halts with our message", async () => {
  const ctx = "prj_ud_ladder_live";
  const first = await uncallableCursorRow(ctx);
  expect(first?.cursor).toMatchObject({ attempt: 1 });
  expect(first?.halted).toBeUndefined();
  const { fired, row } = await walkLadder(ctx, 20);
  expect(fired).toBeLessThanOrEqual(14); // a real rung may have fired on its own in between
  expect(row?.halted).toEqual({
    afterOffset: first!.cursor!.confirmedOffset,
    attempts: 15,
    error: "target is not callable but 2 arg(s) were passed",
  });
  // The ladder is not an issue line; the halt is a fact in the log. (Scoped to this row: an earlier
  // row's wedged facet may still be reporting in the background.)
  expect(drainIssues().filter((i) => (i as { name?: string }).name === "u")).toEqual([]);
});

// WHAT IT DIES OF: nothing a caller sees — the row sits on the ladder (`attempt: 1`, a
// `nextAttemptAtMs`), not halted, after a failure that can never succeed: "not callable" is a
// property of the target, not of the moment. The loop honors ONLY stamped `retryable: false`
// ("honor stamped flags over an invented taxonomy"), so its own deterministic refusals — this one,
// NOT_A_METHOD, NO_ITX_EXPRESSION_MATCH — buy 14 more wakes and ~7 hours before the halt lands.
test.fails("E2 — a deterministic failure (`target is not callable`) is retried 14 more times over ~7 h of ladder instead of halting at once", async () => {
  const first = await uncallableCursorRow("prj_ud_ladder_deterministic");
  if (
    !stillRed(
      "on the ladder after a deterministic failure",
      first?.halted === undefined && first?.cursor?.attempt === 1,
      JSON.stringify(first),
    )
  )
    return; // the pin MOVED
  // WANTED: halted at once.
  expect(first?.halted).toBeDefined();
});

// WHAT IT DIES OF: `subscription-delivery.cursor [STREAM_PAUSED]: stream paused: breaker` — the
// ladder's terminal `subscription-delivery-halted` append is refused by the pause check (only
// created/woken/paused/resumed are exempt), thrown out of the ladder's own catch AFTER the cursor was
// already reset to `attempt: 0`. The pre-call alarm arm (`CURSOR_DELIVERY_CALL_WATCHDOG_MS`) is still
// standing, so the alarm fires again, finds attempt 0, and starts the ladder over: 15 failures,
// refused halt, 15 more — forever, ~7 hours a cycle, with the row reading `attempt: n` and never
// `halted`. A breaker that trips the stream while any cursor row is failing buys exactly this.
test.fails("E3 — on a PAUSED stream the ladder's halt is REFUSED (STREAM_PAUSED) and the ladder restarts from attempt 0: the 15 failures are forgotten, the alarm keeps re-arming, the row never halts", async () => {
  const ctx = "prj_ud_ladder_paused";
  await uncallableCursorRow(ctx);
  await stub(ctx).append({
    type: "events.iterate.com/stream/paused",
    payload: { reason: "breaker" },
  });
  drainIssues();
  const { row } = await walkLadder(ctx, 17); // 14 rungs to the refused halt, 3 more to watch it restart
  const refused = issues.find(
    (i) => i.failureSite === "subscription-delivery.cursor" && i.code === "STREAM_PAUSED",
  );
  const alarmAt = await runInDurableObject(stub(ctx), (_instance, state) =>
    state.storage.getAlarm(),
  );
  if (
    !stillRed(
      "the halt refused with STREAM_PAUSED, the ladder restarted, the alarm re-armed",
      refused !== undefined &&
        row?.halted === undefined &&
        (row?.cursor?.attempt ?? 0) >= 1 &&
        alarmAt !== null,
      JSON.stringify({ refused, row, alarmAt }),
    )
  )
    return; // the pin MOVED
  // WANTED: the halt is the platform's own record and lands on a paused stream too (pause-exempt,
  // like created/woken), so the row reads `halted` after its 15th failure.
  expect(row?.halted).toBeDefined();
});

// ═══════════════════ F. STORAGE UNDER A LIVE INCARNATION ═══════════════════

// WHAT IT DIES OF: `Error: no such table: events: SQLITE_ERROR` — `deleteAll()` drops the tables
// (a SQLite-backed DO's deleteAll clears the whole database), but the incarnation in memory still
// holds its offsets, its core state and its "tables exist" assumption (the constructor creates them
// only on a store with no `incarnation` cell). Every append and every read dies raw until the
// actor is evicted — and this DO has no abort door, so nothing but the platform's idle eviction
// ends it. The core snapshot keeps answering from memory, describing a log that is gone.
test.fails("F1 — deleteAll() under a live incarnation: the tables are gone, the memory is not — every append and read dies of `no such table: events` until an eviction nobody can force", async () => {
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
  const noSuchTable = /^no such table: events: SQLITE_ERROR$/;
  if (
    !stillDiesOf(errs.append, noSuchTable) ||
    !stillDiesOf(errs.read, noSuchTable) ||
    !stillDiesOf(viaStub, noSuchTable) ||
    !stillRed(
      "the core snapshot still answers from memory",
      errs.snapshot === undefined,
      String(errs.snapshot),
    )
  )
    return; // the pin MOVED
  // WANTED: the stream notices its store was reset and starts over, or refuses in its own words.
  expect(errs.append).toBeUndefined();
});

// ═══════════════════════════ G. THE RESERVED NAME ═══════════════════════════

// WHAT IT DIES OF: two of OUR errors in the wrong places. The reserved-name check lives in the event
// BUILDER (subscriptions.ts), not the reduce, so a raw `subscription-configured { name: "core" }`
// becomes a row; and M1 elides the hosting spec from the row's target, so `#invokeFacet` never sees
// the `spec` that its `"core" is the core reduce — never a facet name` guard keys on — the target
// resolves to the core reduce's synthesized view instead, which has no `catchUpFromLog` or
// `processEventBatch`: `NOT_A_METHOD` per commit, with the whole pushed batch printed into the
// message. Removing the row lands — and then the append REJECTS, because the post-commit effect
// `#deleteFacet("core")` throws `"core" is the core reduce — always on, never a facet`: the caller
// sees a failure for an append that succeeded.
test.fails("G1 — a raw `subscription-configured` row named `core` slips past the reduce: NOT_A_METHOD per commit against the core view; its removal lands, yet the append rejects", async () => {
  const ctx = "prj_ud_reserved_core";
  const s = stub(ctx);
  drainIssues();
  const target = print(hostingTarget("core", FINE_SRC, "FineDurableObject"));
  await s.append({
    type: "events.iterate.com/stream/subscription-configured",
    payload: { name: "core", target },
  });
  await s.append({ type: "work" });
  const perCommit = await untilIssue(
    "subscription-delivery.deliver",
    /"processEventBatch" is not a method/,
  );
  const rowsBefore = (await s.invoke("itx.subscriptions.list()")) as { name: string }[];
  const removal = await rejectionOf(() =>
    s.append({
      type: "events.iterate.com/stream/subscription-configured",
      payload: { name: "core", target: null },
    }),
  );
  const rowsAfter = (await s.invoke("itx.subscriptions.list()")) as { name: string }[];
  if (
    !stillRed(
      "a row named core, NOT_A_METHOD per commit, the removal landed yet rejected",
      rowsBefore.some((r) => r.name === "core") &&
        perCommit.code === "NOT_A_METHOD" &&
        rowsAfter.length === 0 &&
        /is the core reduce — always on, never a facet/.test(removal?.message ?? ""),
      JSON.stringify({ rowsBefore, perCommit, removal: removal?.message, rowsAfter }),
    )
  )
    return; // the pin MOVED
  // WANTED: the reduce refuses the reserved name; no row named `core` ever exists.
  expect(rowsBefore.map((r) => r.name)).not.toContain("core");
});
