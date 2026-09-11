// __workers-tests__/stream.test.ts — the `Stream` class (stream/stream.ts) against REAL
// DurableObjectStorage, inside workerd (the workers lane): waitForEvent's wait/settle/timeout
// mechanics, what construction writes, the wake record (`appendCreatedAndWokenEvents()` — an explicit call here;
// in production the DO constructor's first act) and the pause check at the append door. Each test
// borrows a dedicated ctx's DO purely for its storage (runInDurableObject), WIPES it (the DO's
// constructor woke its own stream into it) and constructs a BARE Stream over it with no-op host
// deps — the DO's own #stream is never driven in these ctxs, so the two instances never contend.

import { runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import { errorCode } from "../src/lib/errors.ts";
import { Stream } from "../src/stream/stream.ts";
import type { StreamEvent } from "../src/stream/events.ts";
import { stub } from "./support.ts";

/** A truly VIRGIN storage for the bare Stream: `runInDurableObject` instantiates the ctx's context
 *  DO, whose constructor has already woken its OWN stream into this storage (created@1 + woken@2 —
 *  the shape every context has). Wipe it, so the Stream under test starts from nothing; the DO's own
 *  #stream is never driven again in these ctxs. */
async function virgin(state: DurableObjectState): Promise<DurableObjectStorage> {
  await state.storage.deleteAll();
  return state.storage;
}

/** A bare Stream over real storage. `onCommit` records each `fresh` batch so tests can assert what
 *  the fan-out was fed (core's own live-state delta rides it too: an ephemeral batch after every
 *  commit that changed core state). `appendCreatedAndWokenEvents()` is NOT called — a bare stream starts virgin; the tests
 *  about the wake record call it themselves. */
function bareStream(storage: DurableObjectStorage, opts?: { batches?: StreamEvent[][] }): Stream {
  return new Stream({
    storage,
    path: "/",
    projectId: "prj_bare",
    onCommit: (fresh) => opts?.batches?.push(fresh),
  });
}
/** The fan-out minus core's live-state deltas — the batches a test's OWN appends produced. */
const ownBatches = (batches: StreamEvent[][]): StreamEvent[][] =>
  batches.filter((b) => !b.every((e) => e.type === "events.iterate.com/live-state/changed"));

/** The persisted durable head. The stream writes no separate mark; the core checkpoint's offset
 *  (`reduce_checkpoints`, written every durable commit) IS the mark. `undefined` before the first commit. */
const persistedDurableMark = (state: { storage: DurableObjectStorage }): number | undefined => {
  const row = state.storage.sql
    .exec("SELECT reduced_through_offset AS offset FROM reduce_checkpoints WHERE slug = 'core'")
    .toArray()[0];
  return row === undefined ? undefined : Number(row.offset);
};
/** The incarnation counter, as `stream_meta` holds it. */
const persistedIncarnation = (state: { storage: DurableObjectStorage }): number =>
  Number(
    state.storage.sql.exec("SELECT value FROM stream_meta WHERE key = 'incarnation'").one().value,
  );

test("waitForEvent: a registered waiter resolves with the committed event, fed from the fresh batch", async () => {
  await runInDurableObject(stub("prj_wait_park"), async (_instance, state) => {
    const batches: StreamEvent[][] = [];
    const stream = bareStream(await virgin(state), { batches });
    stream.append({ type: "seed" });
    const pending = stream.waitForEvent({ type: "ping", timeoutMs: 5_000 });
    const [receipt] = stream.append({ type: "ping", payload: { n: 1 } });
    const got = await pending;
    expect(got.type).toBe("ping");
    expect(got.offset).toBe(receipt.offset);
    expect(got.payload).toEqual({ n: 1 });
    // the resolving event was exactly the one the commit tail fanned out
    expect(batches.at(-1)?.some((e) => e.offset === got.offset)).toBe(true);
  });
});

test("waitForEvent: the type filter holds a waiter through non-matching commits", async () => {
  await runInDurableObject(stub("prj_wait_filter"), async (_instance, state) => {
    const stream = bareStream(await virgin(state));
    stream.append({ type: "seed" });
    const pending = stream.waitForEvent({ type: "wanted", timeoutMs: 5_000 });
    stream.append({ type: "other" });
    const raced = await Promise.race([
      pending.then(() => "resolved"),
      new Promise((r) => setTimeout(() => r("waiting"), 100)),
    ]);
    expect(raced).toBe("waiting"); // a non-matching commit left it waiting
    const [receipt] = stream.append({ type: "wanted" });
    expect((await pending).offset).toBe(receipt.offset);
  });
});

test("waitForEvent: an explicit afterOffset resolves from history immediately — first match, paged scan", async () => {
  await runInDurableObject(stub("prj_wait_history"), async (_instance, state) => {
    const stream = bareStream(await virgin(state));
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
    expect(got.offset).toBe(first.offset); // the FIRST match in offset order, not the newest
    expect(got.payload).toEqual({ which: "first" });
  });
});

test("waitForEvent: the default afterOffset means the NEXT occurrence — history does not resolve it", async () => {
  await runInDurableObject(stub("prj_wait_next"), async (_instance, state) => {
    const stream = bareStream(await virgin(state));
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
    expect(got.offset).toBe(next.offset);
    expect(got.offset).toBeGreaterThan(past.offset);
  });
});

test("waitForEvent: a timed-out wait writes nothing — construction made the tables and counted the incarnation; no row, no mark", async () => {
  await runInDurableObject(stub("prj_wait_virgin"), async (_instance, state) => {
    const stream = bareStream(await virgin(state));
    const err = await stream.waitForEvent({ timeoutMs: 100 }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(errorCode(err)).toBe("WAIT_TIMEOUT");
    // The constructor opened storage (both tables, incarnation 1) — the wait itself wrote nothing.
    const tables = state.storage.sql
      .exec("SELECT name FROM sqlite_master WHERE type = 'table'")
      .toArray()
      .map((r) => String(r.name));
    expect(tables).toContain("events");
    expect(tables).toContain("event_chunks");
    expect(persistedIncarnation(state)).toBe(1);
    expect(persistedDurableMark(state)).toBeUndefined();
    expect(state.storage.sql.exec("SELECT count(*) AS n FROM events").one().n).toBe(0);
    expect(stream.currentIncarnation()).toBe(1);
    expect(stream.highestAssignedOffset()).toBe(0);
  });
});

test("waitForEvent: an EPHEMERAL event resolves a waiting caller (and never hits the log)", async () => {
  await runInDurableObject(stub("prj_wait_ephemeral"), async (_instance, state) => {
    const stream = bareStream(await virgin(state));
    stream.append({ type: "seed" });
    const pending = stream.waitForEvent({ type: "blip", timeoutMs: 5_000 });
    const [receipt] = stream.append({ type: "blip", ephemeral: true, payload: { live: 1 } });
    const got = await pending;
    expect(got.offset).toBe(receipt.offset);
    expect(got.ephemeral).toBe(true);
    // catchable only while waiting: the body never reached a row
    expect(stream.read(0).events.some((e) => e.type === "blip")).toBe(false);
  });
});

test("waitForEvent: one event resolves MULTIPLE waiters, in registration order", async () => {
  await runInDurableObject(stub("prj_wait_multi"), async (_instance, state) => {
    const stream = bareStream(await virgin(state));
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
    expect(got1.offset).toBe(receipt.offset);
    expect(got2.offset).toBe(receipt.offset);
    expect(order).toEqual(["first", "second"]);
  });
});

test("waitForEvent: a nested onCommit re-append cannot outrun the outer commit — the waiter gets the EARLIER offset", async () => {
  await runInDurableObject(stub("prj_wait_nested"), async (_instance, state) => {
    // The pinned ordering property (Stream doc): waiters settle BEFORE onCommit. If a refactor
    // ran #onCommit first, this nested matching append (a live-state-delta stand-in — the real
    // fan-out does exactly this) would resolve the waiting caller with the LATER (nested) event.
    let nestedReceipt: StreamEvent | undefined;
    const stream: Stream = new Stream({
      storage: await virgin(state),
      path: "/",
      projectId: "prj_bare",
      onCommit: (fresh) => {
        if (!nestedReceipt && fresh.some((e) => e.type === "ping" && !e.ephemeral))
          [nestedReceipt] = stream.append({ type: "ping", ephemeral: true, payload: { n: 2 } });
      },
    });
    stream.append({ type: "seed" });
    const pending = stream.waitForEvent({ type: "ping", timeoutMs: 5_000 });
    const [outer] = stream.append({ type: "ping", payload: { n: 1 } });
    const got = await pending;
    expect(got.offset).toBe(outer.offset); // the OUTER commit's event, in offset order
    expect(got.payload).toEqual({ n: 1 });
    expect(nestedReceipt).toBeDefined(); // the nested commit really happened…
    expect(nestedReceipt!.offset).toBeGreaterThan(outer.offset); // …at a later offset
  });
});

test("append with ZERO events is a pure no-op — no rows, no offsets, no fan-out; and append prepends NO wake record (the first real append IS row 1)", async () => {
  await runInDurableObject(stub("prj_wait_empty"), async (_instance, state) => {
    const batches: StreamEvent[][] = [];
    const stream = bareStream(await virgin(state), { batches });
    // Empty append: nothing committed, no offset, no fan-out (the constructor already opened storage).
    expect(stream.append()).toEqual([]);
    expect(state.storage.sql.exec("SELECT count(*) AS n FROM events").one().n).toBe(0);
    expect(persistedDurableMark(state)).toBeUndefined();
    expect(stream.highestAssignedOffset()).toBe(0);
    expect(batches).toHaveLength(0);
    // The wake record is `appendCreatedAndWokenEvents()`'s (the DO constructor's) — never append's: with no wake, the
    // first real append is the log's first row, and the fan-out sees exactly that one event.
    const [receipt] = stream.append({ type: "hello" });
    expect(receipt.offset).toBe(1);
    expect(stream.read(0).events.map((e) => [e.type, e.offset])).toEqual([["hello", 1]]);
    expect(batches).toHaveLength(1);
    expect(batches[0].map((e) => e.type)).toEqual(["hello"]);
  });
});

// ── THE WAKE RECORD (`appendCreatedAndWokenEvents()`): created + woken on a fresh store, woken only on a store with rows ──

test("appendCreatedAndWokenEvents(): a fresh store gets created@1 + woken@2 in ONE fanned-out batch (core's delta takes 3); the first append lands at 4; a later incarnation over the same store gets woken only", async () => {
  await runInDurableObject(stub("prj_wait_woken"), async (_instance, state) => {
    const batches: StreamEvent[][] = [];
    const first = bareStream(await virgin(state), { batches });
    first.appendCreatedAndWokenEvents();
    // the birth certificate + the wake record, one durable batch, both fanned out
    const page = first.read(0);
    expect(page.events.map((e) => [e.type, e.offset])).toEqual([
      ["events.iterate.com/stream/created", 1],
      ["events.iterate.com/stream/woken", 2],
    ]);
    expect(page.events[0].payload).toEqual({ projectId: "prj_bare", path: "/" });
    expect(page.events[1].payload).toEqual({ incarnation: 1 });
    expect(first.currentIncarnation()).toBe(1);
    // the wake batch, then core's live-state delta (the reduce changed identity + incarnation) at 3
    expect(batches.map((b) => b.map((e) => [e.type, e.offset]))).toEqual([
      [
        ["events.iterate.com/stream/created", 1],
        ["events.iterate.com/stream/woken", 2],
      ],
      [["events.iterate.com/live-state/changed", 3]],
    ]);
    expect(first.coreReducedState).toMatchObject({
      projectId: "prj_bare",
      path: "/",
      incarnation: 1,
    });
    // the first user append lands at offset 4 — and prepends nothing (its batch is itself alone)
    const [hello] = first.append({ type: "hello" });
    expect(hello.offset).toBe(4);
    expect(batches[2].map((e) => e.type)).toEqual(["hello"]);
    // a LATER incarnation over the same store: born once, so woken ONLY — as its first event
    const second = bareStream(state.storage, { batches }); // the SAME store, NOT wiped
    second.appendCreatedAndWokenEvents();
    expect(second.currentIncarnation()).toBe(2);
    const all = second.read(0).events;
    expect(all.map((e) => e.type)).toEqual([
      "events.iterate.com/stream/created",
      "events.iterate.com/stream/woken",
      "hello",
      "events.iterate.com/stream/woken",
    ]);
    expect(all[3]).toMatchObject({ offset: 5, payload: { incarnation: 2 } });
    expect(ownBatches(batches)[2].map((e) => e.type)).toEqual(["events.iterate.com/stream/woken"]);
    expect(second.coreReducedState.incarnation).toBe(2);
  });
});

test("a stream/paused event pauses the stream through its own core reduce: every non-control append refuses with STREAM_PAUSED, wholesale; the resume lands and reopens", async () => {
  await runInDurableObject(stub("prj_wait_paused"), async (_instance, state) => {
    const stream = bareStream(await virgin(state));
    stream.appendCreatedAndWokenEvents(); // created@1, woken@2, core's delta@3
    stream.append({ type: "events.iterate.com/stream/paused", payload: { reason: "x" } }); // @4
    expect(stream.coreReducedState.paused).toEqual({ reason: "x" });
    expect(stream.read(0).events.map((e) => e.type)).toEqual([
      "events.iterate.com/stream/created",
      "events.iterate.com/stream/woken",
      "events.iterate.com/stream/paused",
    ]);
    // a non-control append is refused at the door, CODED, committing nothing and burning no offset
    let err: unknown;
    try {
      stream.append({ type: "work" });
    } catch (e) {
      err = e;
    }
    expect(errorCode(err)).toBe("STREAM_PAUSED");
    expect((err as Error).message).toContain("stream paused: x");
    expect(stream.read(0).events).toHaveLength(3);
    expect(stream.highestAssignedOffset()).toBe(4); // the pause's own delta was refused (paused) — no offset burnt
    // a batch MIXING the resume with a non-control event is refused WHOLESALE…
    expect(() =>
      stream.append({ type: "events.iterate.com/stream/resumed" }, { type: "work" }),
    ).toThrow(/stream paused/);
    // …while the bare resume lands: a paused stream must always accept its own resume
    const [resumed] = stream.append({ type: "events.iterate.com/stream/resumed" });
    expect(resumed.offset).toBe(5);
    expect(stream.coreReducedState.paused).toBeNull(); // the reduce reopened it — and its delta took 6
    expect(stream.append({ type: "work" })[0].offset).toBe(7);
  });
});

// ── A MALFORMED CONTROL EVENT IS CONTAINED AT THE REDUCE: the core reduce throws on a payload it
// cannot parse (core-processor.test.ts pins the throw); the host — Stream.#reduceEventIntoCoreReducedState —
// reports the issue and keeps the state, so one bad hand-appended event lands as a row and wedges
// nothing. ──

test("a malformed itx/rewrite-rule-configured (a match with an argless call step) lands as a row but configures NOTHING — core state unchanged, the stream alive, the next well-formed rule reduces", async () => {
  await runInDurableObject(stub("prj_core_malformed_rule"), async (_instance, state) => {
    const stream = bareStream(await virgin(state));
    const [bad] = stream.append({
      type: "events.iterate.com/itx/rewrite-rule-configured",
      payload: { match: "itx.call()", target: "itx.kv" },
    });
    expect(stream.read(0).events.map((e) => e.offset)).toEqual([bad.offset]); // the log is the log
    expect(stream.coreReducedState.itxExpressionRewriteRules).toEqual({}); // …but no rule was configured
    const [good] = stream.append({
      type: "events.iterate.com/itx/rewrite-rule-configured",
      payload: { match: "itx.fine", target: "itx.kv" },
    });
    // the table is a RECORD by canonical match; both halves parsed once, at the reduce
    expect(stream.coreReducedState.itxExpressionRewriteRules).toEqual({
      "itx.fine": { match: ["itx", "fine"], target: ["itx", "kv"] },
    });
    expect(stream.append({ type: "work" })[0].offset).toBe(good.offset + 2); // good's core delta took +1
  });
});

test("a malformed subscription-configured (a target that does not parse) lands as a row but adds NO subscription — the next well-formed one reduces", async () => {
  await runInDurableObject(stub("prj_core_malformed_sub"), async (_instance, state) => {
    const stream = bareStream(await virgin(state));
    stream.append({
      type: "events.iterate.com/stream/subscription-configured",
      payload: { name: "broken", target: "itx.broken(" },
    });
    expect(stream.coreReducedState.subscriptions).toEqual({});
    const [good] = stream.append({
      type: "events.iterate.com/stream/subscription-configured",
      payload: { name: "fine", target: "itx.whoami" },
    });
    expect(Object.keys(stream.coreReducedState.subscriptions)).toEqual(["fine"]);
    expect(stream.coreReducedState.subscriptions.fine.configuredAtOffset).toBe(good.offset);
  });
});

// ── EPHEMERALS COST ZERO WRITES (the header contract, pinned against real storage) ──

test("an ephemeral-only append writes NOTHING — no row, no high-water mark — yet hands out offsets and reaches the fan-out", async () => {
  await runInDurableObject(stub("prj_eph_zero_writes"), async (_instance, state) => {
    const batches: StreamEvent[][] = [];
    const stream = bareStream(await virgin(state), { batches });
    // One durable first: this row mints storage and the mark (offset 1 — a bare stream has no wake
    // record; see the appendCreatedAndWokenEvents() pins above for the DO's shape).
    await stream.append({ type: "durable" });
    const markAfterDurable = persistedDurableMark(state);
    expect(markAfterDurable).toBe(1);
    const rowsBefore = state.storage.sql.exec("SELECT count(*) AS n FROM events").one().n;
    // A flood of ephemeral-only batches: offsets advance in memory, storage stays byte-identical.
    for (let i = 0; i < 25; i++)
      stream.append({ type: "chunk", ephemeral: true }, { type: "chunk", ephemeral: true });
    expect(stream.highestAssignedOffset()).toBe(1 + 50);
    expect(persistedDurableMark(state)).toBe(markAfterDurable); // NOT written
    expect(state.storage.sql.exec("SELECT count(*) AS n FROM events").one().n).toBe(rowsBefore);
    // …and every batch reached onCommit with contiguous ranges (the fan-out saw all 50).
    expect(batches.slice(1).flat()).toHaveLength(50);
    expect(batches.at(-1)![1].offset).toBe(51);
    // The next DURABLE batch commits the mark PAST the ephemerals it never wrote — every offset
    // handed out this incarnation is covered by the durable row's transaction.
    const [d] = await stream.append({ type: "durable" });
    expect(d.offset).toBe(52);
    expect(persistedDurableMark(state)).toBe(52);
  });
});

test("across incarnations an ephemeral-only tail's offsets are REUSED by the next durable — the documented contract, and why every checkpoint advances only on a durable", async () => {
  await runInDurableObject(stub("prj_eph_reuse"), async (_instance, state) => {
    const first = bareStream(await virgin(state));
    first.appendCreatedAndWokenEvents(); // created@1, woken@2, core's delta@3 (ephemeral) — the DO's shape
    await first.append({ type: "durable" }); // 4
    first.append({ type: "chunk", ephemeral: true }, { type: "chunk", ephemeral: true }); // 5, 6 — memory only
    expect(first.highestAssignedOffset()).toBe(6);
    // A NEW incarnation over the same storage resumes from the last DURABLE mark…
    const second = bareStream(state.storage); // the SAME store, NOT wiped
    expect(second.highestAssignedOffset()).toBe(4);
    // …so its wake record (durable) is handed 5 again, its delta 6, and its first durable 7.
    second.appendCreatedAndWokenEvents();
    const [d] = await second.append({ type: "durable" });
    expect(d.offset).toBe(7); // woken took 5, the delta 6 — both numbers the dead ephemerals held
    expect(persistedDurableMark(state)).toBe(7);
    // The log itself is exact: created, woken, durable (1, 2, 4) from the first life; woken, durable
    // (5, 7) from the second — 3 and 6 were ephemeral deltas, valid gaps.
    expect((await second.read(0)).events.map((e) => e.offset)).toEqual([1, 2, 4, 5, 7]);
    expect((await second.read(0)).events[3].type).toBe("events.iterate.com/stream/woken");
  });
});

test("read()'s short-page proof is the DURABLE mark, never the in-memory head (an ephemeral tail is not proven)", async () => {
  await runInDurableObject(stub("prj_eph_proof"), async (_instance, state) => {
    const stream = bareStream(await virgin(state));
    stream.append({ type: "tick" }); // tick@1 — durable, mark 1
    stream.append({ type: "blip", ephemeral: true }, { type: "blip", ephemeral: true }); // @2 @3 in memory
    expect(stream.highestAssignedOffset()).toBe(3);
    expect(stream.highestDurableOffset()).toBe(1);
    // A reader must never learn an offset a later incarnation could hand to a durable: the proof
    // stops at the mark. (A persisted checkpoint or cursor built from this read is therefore safe.)
    expect(stream.read(0).scannedThroughOffset).toBe(1);
    expect(stream.read(1).scannedThroughOffset).toBe(1);
    // The next durable batch moves both.
    stream.append({ type: "tick" }); // @4
    expect(stream.highestDurableOffset()).toBe(4);
    expect(stream.read(0).scannedThroughOffset).toBe(4);
  });
});

test("a warm ephemeral-only append runs NO SQL at all (no read, no write, no transaction)", async () => {
  await runInDurableObject(stub("prj_eph_nosql"), async (_instance, state) => {
    await virgin(state);
    const counts = { exec: 0, txn: 0, put: 0 };
    const wrap = <T extends object>(target: T, hooks: Record<string, () => void>): T =>
      new Proxy(target, {
        get(t, k) {
          const v = Reflect.get(t, k) as unknown;
          if (typeof k === "string" && k in hooks) {
            return (...args: unknown[]) => {
              hooks[k]!();
              return (v as (...a: unknown[]) => unknown).apply(t, args);
            };
          }
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
        },
      });
    const sql = wrap(state.storage.sql, { exec: () => counts.exec++ });
    const kv = wrap(state.storage.kv, { put: () => counts.put++ });
    const storage = new Proxy(state.storage, {
      get(t, k) {
        if (k === "sql") return sql;
        if (k === "kv") return kv;
        if (k === "transactionSync")
          return (fn: () => unknown) => {
            counts.txn++;
            return t.transactionSync(fn);
          };
        const v = Reflect.get(t, k) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
    const stream = bareStream(storage as DurableObjectStorage);
    stream.append({ type: "tick" }); // the incarnation's first commit is durable — warms every cache
    stream.append({ type: "blip", ephemeral: true }); // one ephemeral through the fast path, caches warm
    Object.assign(counts, { exec: 0, txn: 0, put: 0 });
    stream.append({ type: "blip", ephemeral: true }, { type: "blip", ephemeral: true });
    expect(counts).toEqual({ exec: 0, txn: 0, put: 0 });
  });
});

// ── STEP 1 REFUSALS: idempotency and the expected-offset precondition, decided before any write ──

test("idempotency: same key + same body echoes the EXISTING event (no row, no offset); a different body under the key refuses the WHOLE batch before any write; a duplicate inside one batch is one row, two receipts", async () => {
  await runInDurableObject(stub("prj_idem"), async (_instance, state) => {
    const stream = bareStream(await virgin(state));
    const [a] = stream.append({ type: "order", payload: { n: 1 }, idempotencyKey: "k1" }); // @1
    // the retry: the same event comes back, nothing new lands
    const [again] = stream.append({ type: "order", payload: { n: 1 }, idempotencyKey: "k1" });
    expect(again.offset).toBe(a.offset);
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
});

test("expected offset: an input carrying `offset` lands exactly there or the whole batch refuses with OFFSET_CONFLICT, before any write; a dedupe hit answers with the event it already has", async () => {
  await runInDurableObject(stub("prj_expected_offset"), async (_instance, state) => {
    const stream = bareStream(await virgin(state));
    stream.append({ type: "seed" }); // @1
    // "nothing has happened since I looked": the head is 1, so 2 is what the next event gets
    const [ok] = stream.append({ type: "next", offset: 2 });
    expect(ok.offset).toBe(2);
    expect("offset" in (stream.read(1).events[0] as object)).toBe(true); // the receipt's offset — not a stored precondition
    // a stale expectation refuses the whole batch, coded, nothing written
    let err: unknown;
    try {
      stream.append({ type: "fine" }, { type: "stale", offset: 2 });
    } catch (e) {
      err = e;
    }
    expect(errorCode(err)).toBe("OFFSET_CONFLICT");
    expect((err as { data?: unknown }).data).toEqual({ expected: 2, actual: 4 });
    expect(stream.highestAssignedOffset()).toBe(2);
    expect(stream.read(0).events).toHaveLength(2);
    // sequential expectations inside one batch hold together
    const two = stream.append({ type: "a", offset: 3 }, { type: "b", offset: 4 });
    expect(two.map((e) => e.offset)).toEqual([3, 4]);
    // a dedupe hit answers with the event it already has, whatever `offset` the retry hoped for
    stream.append({ type: "keyed", idempotencyKey: "k", payload: {} }); // @5
    expect(
      stream.append({ type: "keyed", idempotencyKey: "k", payload: {}, offset: 6 })[0].offset,
    ).toBe(5);
  });
});
