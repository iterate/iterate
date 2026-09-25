/// <reference types="node" />
// stream.test.ts — the `Stream` class (stream/stream.ts) over node:sqlite storage
// (iterate/stream/test-support's nodeSqliteDurableObjectStorage — the same SQL the DO's storage runs; nothing here needs
// workerd): waitForEvent's wait/settle/timeout mechanics, what construction writes, the wake record
// (`appendBirthRecord()` + `appendWakeRecord()` — explicit calls here; in production the DO's
// first act), the pause check, the zero-write ephemeral contract and the step-2 refusals. Every
// test constructs a BARE Stream with no-op host deps — no wake record unless the test appends one.

import { expect, test } from "vitest";
import { errorCode } from "iterate/lib";
import type { StreamEvent, SqlStorageHandle } from "iterate/stream/processor";
import { nodeSqliteDurableObjectStorage } from "iterate/stream/test-support";
import { Stream, type DurableObjectStorageSlice } from "./stream.ts";

test("waitForEvent: a registered waiter resolves with the committed event, fed from the fresh batch", async () => {
  const batches: StreamEvent[][] = [];
  const stream = bareStream({ batches });
  stream.append({ type: "seed" });
  const pending = stream.waitForEvent({ type: "ping", timeoutMs: 5_000 });
  const [receipt] = stream.append({ type: "ping", payload: { n: 1 } });
  const got = await pending;
  expect(got).toMatchObject({ type: "ping", offset: receipt.offset, payload: { n: 1 } });
  // the resolving event was exactly the one the commit tail fanned out
  expect(batches.at(-1)?.some((e) => e.offset === got.offset)).toBe(true);
});

test("waitForEvent: the type filter holds a waiter through non-matching commits", async () => {
  const stream = bareStream();
  stream.append({ type: "seed" });
  const pending = stream.waitForEvent({ type: "wanted", timeoutMs: 5_000 });
  stream.append({ type: "other" });
  const raced = await Promise.race([
    pending.then(() => "resolved"),
    new Promise((r) => setTimeout(() => r("waiting"), 100)),
  ]);
  expect(raced).toBe("waiting"); // a non-matching commit left it waiting
  const [receipt] = stream.append({ type: "wanted" });
  expect(await pending).toMatchObject({ offset: receipt.offset });
});

test("waitForEvent: an explicit afterOffset resolves from history immediately — first match, paged scan", async () => {
  const stream = bareStream();
  // >500 durable events so the initial scan must PAGE read() to reach the match.
  for (let batch = 0; batch < 6; batch++)
    stream.append(
      ...Array.from({ length: 100 }, (_, i) => ({
        type: "filler",
        payload: { n: batch * 100 + i },
      })),
    );
  const [first] = stream.append({ type: "needle", payload: { which: "first" } });
  stream.append({ type: "needle", payload: { which: "second" } });
  const got = await stream.waitForEvent({ type: "needle", afterOffset: 0, timeoutMs: 5_000 });
  // the FIRST match in offset order, not the newest
  expect(got).toMatchObject({ offset: first.offset, payload: { which: "first" } });
});

test("waitForEvent: the default afterOffset means the NEXT occurrence — history does not resolve it", async () => {
  const stream = bareStream();
  const [past] = stream.append({ type: "ping" });
  // A matching event already in the log must NOT satisfy a default (head-anchored) wait.
  const timedOut = await stream.waitForEvent({ type: "ping", timeoutMs: 150 }).then(
    () => null,
    (e: unknown) => e,
  );
  expect(errorCode(timedOut)).toBe("WAIT_TIMEOUT");
  // The next occurrence does.
  const pending = stream.waitForEvent({ type: "ping", timeoutMs: 5_000 });
  const [next] = stream.append({ type: "ping" });
  const got = await pending;
  expect(got).toMatchObject({ offset: next.offset });
  expect(got.offset).toBeGreaterThan(past.offset);
});

test("waitForEvent: an afterOffset AHEAD of head is not satisfied by an earlier fresh event", async () => {
  const stream = bareStream();
  stream.append({ type: "ping" }); // head is now a low offset
  // The contract (WaitForEventFilter): only events with offset strictly greater than afterOffset
  // match. A wait for an offset far ahead of head must NOT be resolved by a fresh event below it —
  // it times out until an event past afterOffset actually lands.
  const pending = stream.waitForEvent({ type: "ping", afterOffset: 1_000, timeoutMs: 150 });
  stream.append({ type: "ping" }); // a fresh match, but its offset is well below 1000
  const outcome = await pending.then(
    (event) => ({ event }),
    (error: unknown) => ({ error }),
  );
  expect("error" in outcome && errorCode(outcome.error)).toBe("WAIT_TIMEOUT");
});

test("waitForEvent: a timed-out wait writes nothing — construction made the tables and counted the incarnation; no row, no mark", async () => {
  const storage = nodeSqliteDurableObjectStorage();
  const stream = bareStream({ storage });
  const err = await stream.waitForEvent({ timeoutMs: 100 }).then(
    () => null,
    (e: unknown) => e,
  );
  expect(errorCode(err)).toBe("WAIT_TIMEOUT");
  // The constructor opened storage (its tables, incarnation 1) — the wait itself wrote nothing.
  const tables = storage.sql
    .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
    .toArray()
    .map((r) => String(r.name));
  expect(tables).toContain("events");
  expect(tables).toContain("event_chunks");
  expect(persistedIncarnation(storage)).toBe(1);
  expect(persistedDurableMark(storage)).toBeUndefined();
  expect(persistedEventRows(storage)).toBe(0);
  expect(stream.storage).toMatchObject({ incarnation: 1 });
  expect(stream.highestAssignedOffset()).toBe(0);
});

test("waitForEvent: an EPHEMERAL event resolves a waiting caller (and never hits the log)", async () => {
  const stream = bareStream();
  stream.append({ type: "seed" });
  const pending = stream.waitForEvent({ type: "blip", timeoutMs: 5_000 });
  const [receipt] = stream.append({ type: "blip", ephemeral: true, payload: { live: 1 } });
  const got = await pending;
  expect(got).toMatchObject({ offset: receipt.offset, ephemeral: true });
  // catchable only while waiting: the body never reached a row
  expect(stream.read(0).events.some((e) => e.type === "blip")).toBe(false);
});

// ── THE RECENT-EPHEMERALS RING: `read(…, { includeEphemeral: true })` consults the ring AND the log ──

test("read() is durable-only by default; with includeEphemeral the ring's ephemerals ride the page in offset order, under the log's own proof", () => {
  const stream = bareStream();
  stream.append({ type: "d1" }); // 1
  const [e2] = stream.append({ type: "e2", ephemeral: true }); // 2
  stream.append({ type: "d3" }); // 3
  const [e4] = stream.append({ type: "e4", ephemeral: true }); // 4 — the head's tail, past the durable mark
  const [e5] = stream.append({ type: "e5", ephemeral: true }); // 5
  expect(stream.read(0).events.map((e) => e.type)).toEqual(["d1", "d3"]);
  const page = stream.read(0, 500, { includeEphemeral: true });
  expect(page.events.map((e) => e.type)).toEqual(["d1", "e2", "d3", "e4", "e5"]);
  expect(page.events[1]).toBe(e2); // the event itself, not a copy
  // The proof is the log's: the durable mark, never e5's offset.
  expect({ scannedThroughOffset: page.scannedThroughOffset, atHead: page.atHead }).toEqual({
    scannedThroughOffset: 3,
    atHead: true,
  });
  // A reader that persisted the proof and reads on sees the head's tail again (it is not provable),
  // and an ephemeral below the mark exactly once: it falls inside one page's span.
  expect(stream.read(page.scannedThroughOffset, 500, { includeEphemeral: true })).toMatchObject({
    events: [e4, e5],
  });
  expect(stream.read(2, 500, { includeEphemeral: true }).events.map((e) => e.type)).toEqual([
    "d3",
    "e4",
    "e5",
  ]);
});

test("a CUT page carries only the ephemerals inside its proven span; `limit` counts durable rows alone", () => {
  const stream = bareStream();
  stream.append({ type: "d1" });
  stream.append({ type: "e2", ephemeral: true });
  stream.append({ type: "d3" });
  stream.append({ type: "e4", ephemeral: true });
  stream.append({ type: "d5" });
  stream.append({ type: "e6", ephemeral: true });
  const first = stream.read(0, 2, { includeEphemeral: true });
  expect(first.events.map((e) => e.offset)).toEqual([1, 2, 3]); // two durables, the ephemeral between them
  expect({ scannedThroughOffset: first.scannedThroughOffset, atHead: first.atHead }).toEqual({
    scannedThroughOffset: 3,
    atHead: false,
  });
  const second = stream.read(first.scannedThroughOffset, 2, { includeEphemeral: true });
  expect(second.events.map((e) => e.offset)).toEqual([4, 5, 6]);
  expect(second).toMatchObject({ atHead: true });
});

test("a refused batch leaves no phantom in the ring: an ephemeral is remembered only once its batch has landed", () => {
  const stream = bareStream();
  stream.append({ type: "seed" });
  // The ephemeral is assigned its offset; the durable beside it is refused at the ceiling.
  expect(() =>
    stream.append(
      { type: "would-be-phantom", ephemeral: true },
      { type: "too-big", payload: { blob: "x".repeat(8 * 1024 * 1024 + 1) } },
    ),
  ).toThrow("over the 8 MiB ceiling");
  expect(stream.read(0, 500, { includeEphemeral: true }).events.map((e) => e.type)).toEqual([
    "seed",
  ]);
  // The offsets the refused batch would have taken are handed out again, to nothing's confusion.
  const [next] = stream.append({ type: "next", ephemeral: true });
  expect(next).toMatchObject({ offset: 2 });
  expect(stream.read(0, 500, { includeEphemeral: true }).events.map((e) => e.type)).toEqual([
    "seed",
    "next",
  ]);
});

test("the ring is byte-bounded (1 MiB): oldest out first", () => {
  const stream = bareStream();
  stream.append({ type: "seed" });
  for (let i = 0; i < 6; i++)
    stream.append({ type: "big", ephemeral: true, payload: { i, blob: "x".repeat(300 * 1024) } });
  const kept = stream
    .read(0, 500, { includeEphemeral: true })
    .events.filter((e) => e.ephemeral)
    .map((e) => e.payload?.i);
  expect(kept).toEqual([3, 4, 5]); // ~300 KiB each: three fit under 1 MiB
});

test("an ephemeral over the ring's whole budget is kept as its only event: older ones make room, the newest is never dropped", () => {
  const stream = bareStream();
  stream.append({ type: "seed" });
  for (let i = 0; i < 3; i++)
    stream.append({ type: "big", ephemeral: true, payload: { i, blob: "x".repeat(300 * 1024) } });
  const [huge] = stream.append({
    type: "huge",
    ephemeral: true,
    payload: { blob: "x".repeat(2 * 1024 * 1024) },
  });
  const kept = stream
    .read(0, 500, { includeEphemeral: true })
    .events.filter((event) => event.ephemeral)
    .map((event) => event.offset);
  expect(kept, "the ring should keep the newest ephemeral whatever its size").toEqual([
    huge.offset,
  ]);
});

test("waitForEvent: one event resolves MULTIPLE waiters, in registration order", async () => {
  const stream = bareStream();
  stream.append({ type: "seed" });
  // Two waiters registered for the same type: one matching commit must resolve BOTH (a waiter is
  // never consumed exclusively), and settlement order is registration order (FIFO per event).
  const order: string[] = [];
  const w1 = stream.waitForEvent({ type: "ping", timeoutMs: 5_000 }).then((e) => {
    order.push("first");
    return e;
  });
  const w2 = stream.waitForEvent({ type: "ping", timeoutMs: 5_000 }).then((e) => {
    order.push("second");
    return e;
  });
  const [receipt] = stream.append({ type: "ping", payload: { n: 1 } });
  const [got1, got2] = await Promise.all([w1, w2]);
  expect([got1, got2]).toMatchObject([{ offset: receipt.offset }, { offset: receipt.offset }]);
  expect(order).toEqual(["first", "second"]);
});

test("waitForEvent: a nested onCommit re-append cannot outrun the outer commit — the waiter gets the EARLIER offset", async () => {
  // The pinned ordering property (Stream doc): waiters settle BEFORE onCommit. If a refactor
  // ran #onCommit first, this nested matching append (a live-state-delta stand-in — the real
  // fan-out does exactly this) would resolve the waiting caller with the LATER (nested) event.
  let nestedReceipt: StreamEvent | undefined;
  const stream: Stream = bareStream({
    onCommit: (fresh) => {
      if (!nestedReceipt && fresh.some((e) => e.type === "ping" && !e.ephemeral))
        [nestedReceipt] = stream.append({ type: "ping", ephemeral: true, payload: { n: 2 } });
    },
  });
  stream.append({ type: "seed" });
  const pending = stream.waitForEvent({ type: "ping", timeoutMs: 5_000 });
  const [outer] = stream.append({ type: "ping", payload: { n: 1 } });
  const got = await pending;
  // the OUTER commit's event, in offset order
  expect(got).toMatchObject({ offset: outer.offset, payload: { n: 1 } });
  expect(nestedReceipt).toBeDefined(); // the nested commit really happened…
  expect(nestedReceipt!.offset).toBeGreaterThan(outer.offset); // …at a later offset
});

test("append with ZERO events is a pure no-op — no rows, no offsets, no fan-out; and append prepends NO wake record (the first real append IS row 1)", () => {
  const storage = nodeSqliteDurableObjectStorage();
  const batches: StreamEvent[][] = [];
  const stream = bareStream({ storage, batches });
  // Empty append: nothing committed, no offset, no fan-out (the constructor already opened storage).
  expect(stream.append()).toEqual([]);
  expect(persistedEventRows(storage)).toBe(0);
  expect(persistedDurableMark(storage)).toBeUndefined();
  expect(stream.highestAssignedOffset()).toBe(0);
  expect(batches).toHaveLength(0);
  // The wake record is `appendBirthRecord()`'s / `appendWakeRecord()`'s (the DO's) — never append's: with no wake, the
  // first real append is the log's first row, and the fan-out sees exactly that one event.
  const [receipt] = stream.append({ type: "hello" });
  expect(receipt).toMatchObject({ offset: 1 });
  expect(stream.read(0).events.map((e) => [e.type, e.offset])).toEqual([["hello", 1]]);
  expect(batches).toHaveLength(1);
  expect(batches[0].map((e) => e.type)).toEqual(["hello"]);
});

// ── THE BIRTH AND WAKE RECORDS (`appendBirthRecord()` / `appendWakeRecord()`): created + woken on a fresh store, woken only on a store with rows ──

test('the wake record says WHY, from the handler that ran first: a birth is a request\'s; a later incarnation records what its first handler says — "alarm" from the alarm handler, "request" from any other — once', () => {
  const storage = nodeSqliteDurableObjectStorage();
  const first = bareStream({ storage });
  first.appendBirthRecord();
  first.appendWakeRecord("alarm"); // the birth already recorded this incarnation's wake
  const second = bareStream({ storage });
  second.appendBirthRecord(); // born once: nothing
  second.appendWakeRecord("alarm");
  second.appendWakeRecord("request"); // once per incarnation
  const third = bareStream({ storage });
  third.appendWakeRecord("request");
  const wokens = bareStream({ storage })
    .read(0)
    .events.filter((e) => e.type === "events.iterate.com/itx/woken")
    .map((e) => e.payload);
  expect(wokens).toEqual([
    { incarnation: 1, reason: "request" },
    { incarnation: 2, reason: "alarm" },
    { incarnation: 3, reason: "request" },
  ]);
});

test("the wake record settles what the last incarnation left open: every core `scriptRuns` row becomes a run-settled { interrupted } in the SAME batch as woken — never re-run; a paused stream still takes the settlement", () => {
  const storage = nodeSqliteDurableObjectStorage();
  const first = bareStream({ storage });
  first.appendBirthRecord();
  first.append(
    {
      type: "events.iterate.com/itx/run-requested",
      payload: { code: "async (itx) => 1" }, // lands at 3
    },
    {
      type: "events.iterate.com/itx/run-requested",
      payload: { code: "async (itx) => 2" }, // lands at 4
    },
    {
      type: "events.iterate.com/itx/run-settled",
      payload: { requestOffset: 3, settlement: { status: "succeeded", result: 1 } },
    },
    { type: "events.iterate.com/itx/paused", payload: { reason: "a breaker" } },
  );
  expect(Object.keys(first.coreReducedState.scriptRuns)).toEqual(["4"]);
  // the incarnation dies with the request at 4 open (its executor with it); the next one's first request records the wake
  const second = bareStream({ storage });
  expect(Object.keys(second.coreReducedState.scriptRuns)).toEqual(["4"]); // rebuilt from the checkpoint: still open
  const headBeforeWake = second.highestAssignedOffset();
  second.appendWakeRecord("request");
  second.appendWakeRecord("alarm"); // once per incarnation: nothing more
  const tail = second
    .read(headBeforeWake)
    .events.map((e) => [
      e.offset - headBeforeWake,
      e.type.replace("events.iterate.com/", ""),
      e.payload,
    ]);
  expect(tail).toEqual([
    [1, "itx/woken", { incarnation: 2, reason: "request" }],
    [
      2, // the SAME batch: right behind the wake record
      "itx/run-settled",
      {
        requestOffset: 4,
        settlement: {
          status: "failed",
          error: "the context restarted before the script finished; it is not run again",
          failureKind: "interrupted",
        },
      },
    ],
  ]);
  // objectContaining compares each key it names with full equality: `{}` is an EMPTY table (toMatchObject's `{}` matches any)
  expect(second).toMatchObject({ coreReducedState: expect.objectContaining({ scriptRuns: {} }) });
  // the pause held; the settlement was exempt
  expect(second.coreReducedState).toMatchObject({ paused: { reason: "a breaker" } });
  // a third incarnation finds nothing open: the wake record alone
  const third = bareStream({ storage });
  const headBeforeThird = third.highestAssignedOffset();
  third.appendWakeRecord("request");
  expect(third.read(headBeforeThird).events.map((e) => e.type)).toEqual([
    "events.iterate.com/itx/woken",
  ]);
});

test("appendBirthRecord(): a fresh store gets created@1 + woken@2 in ONE fanned-out batch; the first append lands at 3; a later incarnation over the same store gets woken only, from its first handler (appendWakeRecord)", () => {
  const storage = nodeSqliteDurableObjectStorage();
  const batches: StreamEvent[][] = [];
  const first = bareStream({ storage, batches });
  first.appendBirthRecord();
  first.appendWakeRecord("request");
  // the birth certificate + the wake record, one durable batch, both fanned out
  const page = first.read(0);
  expect(page.events.map((e) => [e.type, e.offset])).toEqual([
    ["events.iterate.com/itx/created", 1],
    ["events.iterate.com/itx/woken", 2],
  ]);
  expect(page.events).toMatchObject([
    { payload: { projectId: "prj_bare", path: "/" } },
    { payload: { incarnation: 1, reason: "request" } }, // no alarm was stored: a request woke it
  ]);
  expect(first.storage).toMatchObject({ incarnation: 1 });
  expect(batches.map((b) => b.map((e) => [e.type, e.offset]))).toEqual([
    [
      ["events.iterate.com/itx/created", 1],
      ["events.iterate.com/itx/woken", 2],
    ],
  ]);
  expect(first.coreReducedState).toMatchObject({
    projectId: "prj_bare",
    path: "/",
    incarnation: 1,
  });
  // the first user append lands at offset 3 — and prepends nothing (its batch is itself alone)
  const [hello] = first.append({ type: "hello" });
  expect(hello).toMatchObject({ offset: 3 });
  expect(batches[1].map((e) => e.type)).toEqual(["hello"]);
  // a LATER incarnation over the same store: born once, so woken ONLY — as its first event
  const second = bareStream({ storage, batches }); // the SAME store
  second.appendBirthRecord();
  second.appendWakeRecord("request");
  expect(second.storage).toMatchObject({ incarnation: 2 });
  const all = second.read(0).events;
  expect(all.map((e) => e.type)).toEqual([
    "events.iterate.com/itx/created",
    "events.iterate.com/itx/woken",
    "hello",
    "events.iterate.com/itx/woken",
  ]);
  expect(all[3]).toMatchObject({ offset: 4, payload: { incarnation: 2 } });
  expect(batches[2].map((e) => e.type)).toEqual(["events.iterate.com/itx/woken"]);
  expect(second.coreReducedState).toMatchObject({ incarnation: 2 });
});

test("an itx/paused event pauses the stream through its own core reduce: every non-control append refuses with STREAM_PAUSED, wholesale; the resume lands and reopens", () => {
  const stream = bareStream();
  stream.appendBirthRecord();
  stream.appendWakeRecord("request"); // created@1, woken@2
  stream.append({ type: "events.iterate.com/itx/paused", payload: { reason: "x" } }); // @3
  expect(stream.coreReducedState).toMatchObject({ paused: { reason: "x" } });
  expect(stream.read(0).events.map((e) => e.type)).toEqual([
    "events.iterate.com/itx/created",
    "events.iterate.com/itx/woken",
    "events.iterate.com/itx/paused",
  ]);
  // a non-control append is refused on append, CODED, committing nothing and burning no offset
  let err: unknown;
  try {
    stream.append({ type: "work" });
  } catch (e) {
    err = e;
  }
  expect(errorCode(err)).toBe("STREAM_PAUSED");
  expect((err as Error).message).toContain("stream paused: x");
  expect(stream.read(0).events).toHaveLength(3);
  expect(stream.highestAssignedOffset()).toBe(3); // the refusal burnt no offset
  // a batch MIXING the resume with a non-control event is refused WHOLESALE…
  expect(() => stream.append({ type: "events.iterate.com/itx/resumed" }, { type: "work" })).toThrow(
    /stream paused/,
  );
  // …while the bare resume lands: a paused stream must always accept its own resume
  const [resumed] = stream.append({ type: "events.iterate.com/itx/resumed" });
  expect(resumed).toMatchObject({ offset: 4 });
  expect(stream.coreReducedState.paused).toBeNull(); // the reduce reopened it
  expect(stream.append({ type: "work" })[0]).toMatchObject({ offset: 5 });
});

test("a raw subscription-configured lands at the stream: a name is normalizeControlEvent's to refuse (core-processor.test.ts pins `core` and the prototype keys)", () => {
  const stream = bareStream();
  const [event] = stream.append({
    type: "events.iterate.com/itx/subscription-configured",
    payload: {
      name: "presence",
      target: ["itx", "facets", ["get", "presence"], "processEventBatch"],
    },
  });
  expect(event.offset).toBeGreaterThan(0);
});

// ── A MALFORMED CONTROL EVENT IS CONTAINED AT THE REDUCE: the core reduce throws on a payload it
// cannot parse (core-processor.test.ts pins the throw); the host — Stream.#reduceEventsIntoCoreReducedState —
// reports the issue and keeps the state, so one bad hand-appended event lands as a row and wedges
// nothing. ──

test("a malformed itx/rewrite-rule-configured (a match with an argless call step) lands as a row but configures NOTHING — core state unchanged, the stream alive, the next well-formed rule reduces", () => {
  const stream = bareStream();
  const [bad] = stream.append({
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: { match: "itx.call()", target: "itx.kv" },
  });
  expect(stream.read(0).events.map((e) => e.offset)).toEqual([bad.offset]); // the log is the log
  // …but no rule was configured
  expect(stream).toMatchObject({
    coreReducedState: expect.objectContaining({ itxExpressionRewriteRules: {} }),
  });
  const [good] = stream.append({
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: { match: "itx.fine", target: "itx.kv" },
  });
  // the table is a RECORD by canonical match; both halves parsed once, at the reduce
  expect(stream.coreReducedState).toMatchObject({
    itxExpressionRewriteRules: { "itx.fine": { match: ["itx", "fine"], target: ["itx", "kv"] } },
  });
  expect(stream.append({ type: "work" })[0]).toMatchObject({ offset: good.offset + 1 });
});

test("a malformed subscription-configured (a target that does not parse) lands as a row but adds NO subscription — the next well-formed one reduces", () => {
  const stream = bareStream();
  stream.append({
    type: "events.iterate.com/itx/subscription-configured",
    payload: { name: "broken", target: "itx.broken(" },
  });
  expect(stream).toMatchObject({
    coreReducedState: expect.objectContaining({ subscriptions: {} }),
  });
  const [good] = stream.append({
    type: "events.iterate.com/itx/subscription-configured",
    payload: { name: "fine", target: "itx.whoami" },
  });
  expect(Object.keys(stream.coreReducedState.subscriptions)).toEqual(["fine"]);
  expect(stream.coreReducedState.subscriptions).toMatchObject({
    fine: { configuredAtOffset: good.offset },
  });
});

// ── EPHEMERALS COST ZERO WRITES (the header contract, pinned against real SQL) ──

test("an ephemeral-only append writes NOTHING — no row, no high-water mark — yet hands out offsets and reaches the fan-out", () => {
  const storage = nodeSqliteDurableObjectStorage();
  const batches: StreamEvent[][] = [];
  const stream = bareStream({ storage, batches });
  // One durable first: this row mints storage and the mark (offset 1 — a bare stream has no wake
  // record; see the appendBirthRecord() pins above for the DO's shape).
  stream.append({ type: "durable" });
  const markAfterDurable = persistedDurableMark(storage);
  expect(markAfterDurable).toBe(1);
  const rowsBefore = persistedEventRows(storage);
  // A flood of ephemeral-only batches: offsets advance in memory, storage stays byte-identical.
  for (let i = 0; i < 25; i++)
    stream.append({ type: "chunk", ephemeral: true }, { type: "chunk", ephemeral: true });
  expect(stream.highestAssignedOffset()).toBe(1 + 50);
  expect(persistedDurableMark(storage)).toBe(markAfterDurable); // NOT written
  expect(persistedEventRows(storage)).toBe(rowsBefore);
  // …and every batch reached onCommit with contiguous ranges (the fan-out saw all 50).
  expect(batches.slice(1).flat()).toHaveLength(50);
  expect(batches.at(-1)![1]).toMatchObject({ offset: 51 });
  // The next DURABLE batch commits the mark PAST the ephemerals it never wrote — every offset
  // handed out this incarnation is covered by the durable row's transaction.
  const [d] = stream.append({ type: "durable" });
  expect(d).toMatchObject({ offset: 52 });
  expect(persistedDurableMark(storage)).toBe(52);
});

test("across incarnations an ephemeral-only tail's offsets are REUSED by the next durable — the documented contract, and why every checkpoint advances only on a durable", () => {
  const storage = nodeSqliteDurableObjectStorage();
  const first = bareStream({ storage });
  first.appendBirthRecord();
  first.appendWakeRecord("request"); // created@1, woken@2 — the DO's shape
  first.append({ type: "durable" }); // 3
  first.append({ type: "chunk", ephemeral: true }, { type: "chunk", ephemeral: true }); // 4, 5 — memory only
  expect(first.highestAssignedOffset()).toBe(5);
  // A NEW incarnation over the same storage resumes from the last DURABLE mark…
  const second = bareStream({ storage }); // the SAME store
  expect(second.highestAssignedOffset()).toBe(3);
  // …so its wake record (durable) is handed 4 again, and its first durable 5.
  second.appendBirthRecord();
  second.appendWakeRecord("request");
  const [d] = second.append({ type: "durable" });
  expect(d).toMatchObject({ offset: 5 }); // woken took 4, the durable 5 — both numbers the dead ephemerals held
  expect(persistedDurableMark(storage)).toBe(5);
  // The log itself is exact: created, woken, durable (1, 2, 3) from the first life; woken, durable
  // (4, 5) from the second — the dead ephemerals left no gap a row could fill.
  expect(second.read(0).events.map((e) => e.offset)).toEqual([1, 2, 3, 4, 5]);
  expect(second.read(0).events[3]).toMatchObject({ type: "events.iterate.com/itx/woken" });
});

test("read()'s short-page proof is the DURABLE mark, never the in-memory head (an ephemeral tail is not proven)", () => {
  const stream = bareStream();
  stream.append({ type: "tick" }); // tick@1 — durable, mark 1
  stream.append({ type: "blip", ephemeral: true }, { type: "blip", ephemeral: true }); // @2 @3 in memory
  expect(stream.highestAssignedOffset()).toBe(3);
  expect(stream.highestDurableOffset()).toBe(1);
  // A reader must never learn an offset a later incarnation could hand to a durable: the proof
  // stops at the mark. (A persisted checkpoint or cursor built from this read is therefore safe.)
  expect(stream.read(0)).toMatchObject({ scannedThroughOffset: 1 });
  expect(stream.read(1)).toMatchObject({ scannedThroughOffset: 1 });
  // The next durable batch moves both.
  stream.append({ type: "tick" }); // @4
  expect(stream.highestDurableOffset()).toBe(4);
  expect(stream.read(0)).toMatchObject({ scannedThroughOffset: 4 });
});

test("a warm ephemeral-only append runs NO SQL at all (no read, no write, no transaction)", () => {
  const base = nodeSqliteDurableObjectStorage();
  const counts = { exec: 0, txn: 0 };
  const sql: SqlStorageHandle = {
    exec: (query, ...bindings) => {
      counts.exec++;
      return base.sql.exec(query, ...bindings);
    },
  };
  const stream = bareStream({
    storage: {
      sql,
      transactionSync: (closure) => {
        counts.txn++;
        return base.transactionSync(closure);
      },
    },
  });
  stream.append({ type: "tick" }); // the incarnation's first commit is durable — warms every cache
  stream.append({ type: "blip", ephemeral: true }); // one ephemeral through the fast path, caches warm
  Object.assign(counts, { exec: 0, txn: 0 });
  stream.append({ type: "blip", ephemeral: true }, { type: "blip", ephemeral: true });
  expect(counts).toEqual({ exec: 0, txn: 0 });
});

// ── STEP 2 REFUSALS: idempotency and the expected-offset precondition, decided before any write ──

test("idempotency: same key + same body echoes the EXISTING event (no row, no offset); a different body under the key refuses the WHOLE batch before any write; a duplicate inside one batch is one row, two receipts", () => {
  const stream = bareStream();
  const [a] = stream.append({ type: "order", payload: { n: 1 }, idempotencyKey: "k1" }); // @1
  // the retry: the same event comes back, nothing new lands
  const [again] = stream.append({ type: "order", payload: { n: 1 }, idempotencyKey: "k1" });
  expect(again).toMatchObject({ offset: a.offset });
  expect(stream.highestAssignedOffset()).toBe(1);
  // a conflicting body under the key: refused, CODED — and the valid event beside it does NOT land
  let err: unknown;
  try {
    stream.append({ type: "fine" }, { type: "order", payload: { n: 2 }, idempotencyKey: "k1" });
  } catch (e) {
    err = e;
  }
  expect(errorCode(err)).toBe("IDEMPOTENCY_CONFLICT");
  expect(stream.read(0).events).toHaveLength(1);
  expect(stream.highestAssignedOffset()).toBe(1);
  // a retry riding beside its original in ONE batch: one row, and both receipts name it
  const receipts = stream.append(
    { type: "order", payload: { n: 3 }, idempotencyKey: "k3" },
    { type: "order", payload: { n: 3 }, idempotencyKey: "k3" },
  );
  expect(receipts.map((e) => e.offset)).toEqual([2, 2]);
  expect(stream.read(0).events.map((e) => e.offset)).toEqual([1, 2]);
});

test("expected offset: an input carrying `offset` lands exactly there or the whole batch refuses with OFFSET_CONFLICT, before any write; a dedupe hit answers with the event it already has", () => {
  const stream = bareStream();
  stream.append({ type: "seed" }); // @1
  // "nothing has happened since I looked": the head is 1, so 2 is what the next event gets
  const [ok] = stream.append({ type: "next", offset: 2 });
  expect(ok).toMatchObject({ offset: 2 });
  expect("offset" in (stream.read(1).events[0] as object)).toBe(true); // the receipt's offset — not a stored precondition
  // a stale expectation refuses the whole batch, coded, nothing written
  let err: unknown;
  try {
    stream.append({ type: "fine" }, { type: "stale", offset: 2 });
  } catch (e) {
    err = e;
  }
  expect(errorCode(err)).toBe("OFFSET_CONFLICT");
  expect(err).toMatchObject({ data: { expected: 2, actual: 4 } });
  expect(stream.highestAssignedOffset()).toBe(2);
  expect(stream.read(0).events).toHaveLength(2);
  // sequential expectations inside one batch hold together
  const two = stream.append({ type: "a", offset: 3 }, { type: "b", offset: 4 });
  expect(two.map((e) => e.offset)).toEqual([3, 4]);
  // a dedupe hit answers with the event it already has, whatever `offset` the retry hoped for
  stream.append({ type: "keyed", idempotencyKey: "k", payload: {} }); // @5
  expect(
    stream.append({ type: "keyed", idempotencyKey: "k", payload: {}, offset: 6 })[0],
  ).toMatchObject({ offset: 5 });
});

test("a paused stream admits an idempotent replay of an explicitly configured subscription", () => {
  const storage = nodeSqliteDurableObjectStorage();
  const first = bareStream({ storage });
  first.appendBirthRecord();
  first.appendWakeRecord("request");
  const configureEvent = {
    type: "events.iterate.com/itx/subscription-configured",
    payload: {
      name: "config",
      target: "itx.workers.get({ source: { 'worker.js': 'test-source' } }).processEventBatch",
      consumes: ["*"],
    },
    idempotencyKey: "config-subscription",
  };
  const [configured] = first.append(configureEvent);
  first.append({ type: "events.iterate.com/itx/paused", payload: { reason: "operator" } });
  expect(first.coreReducedState).toMatchObject({ paused: { reason: "operator" } });

  // A fresh event is still refused…
  expect(() => first.append({ type: "mark" })).toThrow(/stream paused/);
  // …the replay lands as the event it already is, and consumes no offset.
  expect(first.append(configureEvent)[0]).toMatchObject({ offset: configured.offset });

  // The next incarnation (what an eviction makes): the same replay, then the resume.
  const second = bareStream({ storage });
  second.appendBirthRecord();
  second.appendWakeRecord("request");
  expect(second.append(configureEvent)[0]).toMatchObject({ offset: configured.offset });
  second.append({ type: "events.iterate.com/itx/resumed" });
  expect(second.coreReducedState.paused).toBeNull();
  expect(second.append({ type: "mark" })[0]).toMatchObject({ type: "mark" });
});

/** THE ONE way a test constructs a Stream: over a fresh node:sqlite store unless given one (a
 *  second incarnation reuses the first's). `batches` records each `fresh` batch the fan-out was fed;
 *  `onCommit` runs beside it. */
function bareStream(
  opts: {
    storage?: DurableObjectStorageSlice;
    batches?: StreamEvent[][];
    onCommit?: (fresh: StreamEvent[]) => void;
  } = {},
): Stream {
  return new Stream({
    storage: opts.storage || nodeSqliteDurableObjectStorage(),
    path: "/",
    projectId: "prj_bare",
    onCommit: (fresh) => {
      opts.batches?.push(fresh);
      opts.onCommit?.(fresh);
    },
  });
}

/** The persisted durable head. The stream writes no separate mark; the core checkpoint's offset
 *  (`reduce_checkpoints`, written every durable commit) IS the mark. `undefined` before the first commit. */
const persistedDurableMark = (storage: DurableObjectStorageSlice): number | undefined => {
  const row = storage.sql
    .exec<{ offset: number }>(
      "SELECT reduced_through_offset AS offset FROM reduce_checkpoints WHERE slug = 'core'",
    )
    .toArray()[0];
  return row ? Number(row.offset) : undefined;
};
/** The incarnation counter, as `stream_meta` holds it. */
const persistedIncarnation = (storage: DurableObjectStorageSlice): number =>
  Number(
    storage.sql
      .exec<{ value: string }>("SELECT value FROM stream_meta WHERE key = 'incarnation'")
      .toArray()[0].value,
  );
const persistedEventRows = (storage: DurableObjectStorageSlice): number =>
  Number(storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM events").toArray()[0].n);
