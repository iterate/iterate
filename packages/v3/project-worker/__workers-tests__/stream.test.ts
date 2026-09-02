// __workers-tests__/stream.test.ts — the `Stream` class (stream/stream.ts) against REAL
// DurableObjectStorage, inside workerd (the workers lane): waitForEvent's park/settle/timeout
// mechanics, the storage-lazy virgin guarantee, the wake record (`wake()` — an explicit call here;
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

/** A bare Stream over real storage. `paused` defaults to open (null); `onCommit` records each
 *  `fresh` batch so tests can assert what the fan-out was fed. `wake()` is NOT called — a bare
 *  stream starts virgin; the tests about the wake record call it themselves. */
function bareStream(
  storage: DurableObjectStorage,
  opts?: { paused?: () => { reason: string } | null; batches?: StreamEvent[][] },
): Stream {
  return new Stream({
    storage,
    path: "/",
    projectId: "prj_bare",
    paused: opts?.paused ?? (() => null),
    reduceAtCommit: () => {},
    onCommit: (fresh) => opts?.batches?.push(fresh),
  });
}

test("waitForEvent: a parked waiter resolves with the committed event, fed from the fresh batch", async () => {
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
      new Promise((r) => setTimeout(() => r("parked"), 100)),
    ]);
    expect(raced).toBe("parked"); // a non-matching commit left it parked
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

test("waitForEvent: a timed-out wait on a VIRGIN stream leaves it virgin (no storage minted)", async () => {
  await runInDurableObject(stub("prj_wait_virgin"), async (_instance, state) => {
    const stream = bareStream(await virgin(state));
    const err = await stream.waitForEvent({ timeoutMs: 100 }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(errorCode(err)).toBe("WAIT_TIMEOUT");
    // Nothing minted: no event tables, no incarnation bump, no offset watermark.
    const tables = state.storage.sql
      .exec("SELECT name FROM sqlite_master WHERE type = 'table'")
      .toArray()
      .map((r) => String(r.name));
    expect(tables).not.toContain("events");
    expect(tables).not.toContain("event_chunks");
    expect(state.storage.kv.get("incarnation")).toBeUndefined();
    expect(state.storage.kv.get("maxAssignedOffset")).toBeUndefined();
    expect(stream.currentIncarnation()).toBe(0);
    expect(stream.highestAssignedOffset()).toBe(0);
  });
});

test("waitForEvent: an EPHEMERAL event resolves a parked waiter (and never hits the log)", async () => {
  await runInDurableObject(stub("prj_wait_ephemeral"), async (_instance, state) => {
    const stream = bareStream(await virgin(state));
    stream.append({ type: "seed" });
    const pending = stream.waitForEvent({ type: "blip", timeoutMs: 5_000 });
    const [receipt] = stream.append({ type: "blip", ephemeral: true, payload: { live: 1 } });
    const got = await pending;
    expect(got.offset).toBe(receipt.offset);
    expect(got.ephemeral).toBe(true);
    // catchable only while parked: the body never reached a row
    expect(stream.read(0).events.some((e) => e.type === "blip")).toBe(false);
  });
});

test("waitForEvent: one event resolves MULTIPLE parked waiters, in park order", async () => {
  await runInDurableObject(stub("prj_wait_multi"), async (_instance, state) => {
    const stream = bareStream(await virgin(state));
    stream.append({ type: "seed" });
    // Two waiters parked for the same type: one matching commit must resolve BOTH (a waiter is
    // never consumed exclusively), and settlement order is park order (FIFO per event).
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
    // fan-out does exactly this) would resolve the parked waiter with the LATER (nested) event.
    let nestedReceipt: StreamEvent | undefined;
    const stream: Stream = new Stream({
      storage: await virgin(state),
      path: "/",
      projectId: "prj_bare",
      paused: () => null,
      reduceAtCommit: () => {},
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

test("append with ZERO inputs is a pure no-op — no rows, no offsets, no fan-out; and append prepends NO wake record (the first real append IS row 1)", async () => {
  await runInDurableObject(stub("prj_wait_empty"), async (_instance, state) => {
    const batches: StreamEvent[][] = [];
    const stream = bareStream(await virgin(state), { batches });
    // Empty append on a VIRGIN stream: nothing minted, nothing committed, no fan-out.
    expect(stream.append()).toEqual([]);
    const tables = state.storage.sql
      .exec("SELECT name FROM sqlite_master WHERE type = 'table'")
      .toArray()
      .map((r) => String(r.name));
    expect(tables).not.toContain("events");
    expect(state.storage.kv.get("incarnation")).toBeUndefined();
    expect(state.storage.kv.get("maxAssignedOffset")).toBeUndefined();
    expect(batches).toHaveLength(0);
    // The wake record is `wake()`'s (the DO constructor's) — never append's: with no wake, the
    // first real append is the log's first row, and the fan-out sees exactly that one event.
    const [receipt] = stream.append({ type: "hello" });
    expect(receipt.offset).toBe(1);
    expect(stream.read(0).events.map((e) => [e.type, e.offset])).toEqual([["hello", 1]]);
    expect(batches).toHaveLength(1);
    expect(batches[0].map((e) => e.type)).toEqual(["hello"]);
  });
});

// ── THE WAKE RECORD (`wake()`): created + woken on a fresh store, woken only on a store with rows ──

test("wake(): a fresh store gets created@1 + woken@2 in ONE fanned-out batch; the first append lands at 3; a later incarnation over the same store gets woken only", async () => {
  await runInDurableObject(stub("prj_wait_woken"), async (_instance, state) => {
    const batches: StreamEvent[][] = [];
    const first = bareStream(await virgin(state), { batches });
    first.wake();
    // the birth certificate + the wake record, one durable batch, both fanned out
    const page = first.read(0);
    expect(page.events.map((e) => [e.type, e.offset])).toEqual([
      ["events.iterate.com/stream/created", 1],
      ["events.iterate.com/stream/woken", 2],
    ]);
    expect(page.events[0].payload).toEqual({ projectId: "prj_bare", path: "/" });
    expect(page.events[1].payload).toEqual({ incarnation: 1 });
    expect(first.currentIncarnation()).toBe(1);
    expect(batches).toHaveLength(1);
    expect(batches[0].map((e) => e.type)).toEqual([
      "events.iterate.com/stream/created",
      "events.iterate.com/stream/woken",
    ]);
    // the first user append lands at offset 3 — and prepends nothing (its batch is itself alone)
    const [hello] = first.append({ type: "hello" });
    expect(hello.offset).toBe(3);
    expect(batches[1].map((e) => e.type)).toEqual(["hello"]);
    // a LATER incarnation over the same store: born once, so woken ONLY — as its first event
    const second = bareStream(state.storage, { batches }); // the SAME store, NOT wiped
    second.wake();
    expect(second.currentIncarnation()).toBe(2);
    const all = second.read(0).events;
    expect(all.map((e) => e.type)).toEqual([
      "events.iterate.com/stream/created",
      "events.iterate.com/stream/woken",
      "hello",
      "events.iterate.com/stream/woken",
    ]);
    expect(all[3]).toMatchObject({ offset: 4, payload: { incarnation: 2 } });
    expect(batches[2].map((e) => e.type)).toEqual(["events.iterate.com/stream/woken"]);
  });
});

test("wake() works while PAUSED (created/woken are control events); the pause check refuses every non-control append with STREAM_PAUSED, wholesale, and still lands the resume", async () => {
  await runInDurableObject(stub("prj_wait_paused"), async (_instance, state) => {
    let paused: { reason: string } | null = { reason: "x" };
    const stream = bareStream(await virgin(state), { paused: () => paused });
    stream.wake(); // no throw — a paused stream still records its wake
    expect(stream.read(0).events.map((e) => e.type)).toEqual([
      "events.iterate.com/stream/created",
      "events.iterate.com/stream/woken",
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
    expect(stream.read(0).events).toHaveLength(2);
    expect(stream.highestAssignedOffset()).toBe(2);
    // a batch MIXING the resume with a non-control event is refused WHOLESALE…
    expect(() =>
      stream.append({ type: "events.iterate.com/stream/resumed" }, { type: "work" }),
    ).toThrow(/stream paused/);
    // …while the bare resume lands: a paused stream must always accept its own resume
    const [resumed] = stream.append({ type: "events.iterate.com/stream/resumed" });
    expect(resumed.offset).toBe(3);
    paused = null; // what the host's core reduce does with that resume
    expect(stream.append({ type: "work" })[0].offset).toBe(4);
  });
});

// ── EPHEMERALS COST ZERO WRITES (the header contract, pinned against real storage) ──

test("an ephemeral-only append writes NOTHING — no row, no high-water mark — yet hands out offsets and reaches the fan-out", async () => {
  await runInDurableObject(stub("prj_eph_zero_writes"), async (_instance, state) => {
    const batches: StreamEvent[][] = [];
    const stream = bareStream(await virgin(state), { batches });
    // One durable first: this row mints storage and the mark (offset 1 — a bare stream has no wake
    // record; see the wake() pins above for the DO's shape).
    await stream.append({ type: "durable" });
    const markAfterDurable = state.storage.kv.get("maxAssignedOffset");
    expect(markAfterDurable).toBe(1);
    const rowsBefore = state.storage.sql.exec("SELECT count(*) AS n FROM events").one().n;
    // A flood of ephemeral-only batches: offsets advance in memory, storage stays byte-identical.
    for (let i = 0; i < 25; i++)
      stream.append({ type: "chunk", ephemeral: true }, { type: "chunk", ephemeral: true });
    expect(stream.highestAssignedOffset()).toBe(1 + 50);
    expect(state.storage.kv.get("maxAssignedOffset")).toBe(markAfterDurable); // NOT written
    expect(state.storage.sql.exec("SELECT count(*) AS n FROM events").one().n).toBe(rowsBefore);
    // …and every batch reached onCommit with contiguous ranges (the fan-out saw all 50).
    expect(batches.slice(1).flat()).toHaveLength(50);
    expect(batches.at(-1)![1].offset).toBe(51);
    // The next DURABLE batch commits the mark PAST the ephemerals it never wrote — every offset
    // handed out this incarnation is covered by the durable row's transaction.
    const [d] = await stream.append({ type: "durable" });
    expect(d.offset).toBe(52);
    expect(state.storage.kv.get("maxAssignedOffset")).toBe(52);
  });
});

test("across incarnations an ephemeral-only tail's offsets are REUSED by the next durable — the documented contract, and why every checkpoint advances only on a durable", async () => {
  await runInDurableObject(stub("prj_eph_reuse"), async (_instance, state) => {
    const first = bareStream(await virgin(state));
    first.wake(); // created@1, woken@2 — the DO's shape
    await first.append({ type: "durable" }); // 3
    first.append({ type: "chunk", ephemeral: true }, { type: "chunk", ephemeral: true }); // 4, 5 — memory only
    expect(first.highestAssignedOffset()).toBe(5);
    // A NEW incarnation over the same storage resumes from the last DURABLE mark…
    const second = bareStream(state.storage); // the SAME store, NOT wiped
    expect(second.highestAssignedOffset()).toBe(3);
    // …so its wake record (durable) is handed 4 again, and its first durable 5.
    second.wake();
    const [d] = await second.append({ type: "durable" });
    expect(d.offset).toBe(5); // woken took 4, this durable took 5 — both numbers the dead ephemerals held
    expect(state.storage.kv.get("maxAssignedOffset")).toBe(5);
    // The log itself is exact: created, woken, durable (1..3) from the first life; woken, durable
    // (4, 5) from the second.
    expect((await second.read(0)).events.map((e) => e.offset)).toEqual([1, 2, 3, 4, 5]);
    expect((await second.read(0)).events[3].type).toBe("events.iterate.com/stream/woken");
  });
});

test("read()'s short-page proof is the DURABLE mark, never the in-memory head (an ephemeral tail is not proven)", async () => {
  await runInDurableObject(stub("prj_eph_proof"), async (_instance, state) => {
    const stream = bareStream(await virgin(state));
    stream.append({ type: "tick" }); // tick@1 — durable, mark 1
    stream.append({ type: "blip", ephemeral: true }, { type: "blip", ephemeral: true }); // @2 @3 in memory
    expect(stream.highestAssignedOffset()).toBe(3);
    expect(stream.durableMark()).toBe(1);
    // A reader must never learn an offset a later incarnation could hand to a durable: the proof
    // stops at the mark. (A persisted checkpoint or cursor built from this read is therefore safe.)
    expect(stream.read(0).scannedThroughOffset).toBe(1);
    expect(stream.read(1).scannedThroughOffset).toBe(1);
    // The next durable batch moves both.
    stream.append({ type: "tick" }); // @4
    expect(stream.durableMark()).toBe(4);
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
