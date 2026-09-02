// __workers-tests__/stream.test.ts — the `Stream` class (stream/stream.ts) against REAL
// DurableObjectStorage, inside workerd (the workers lane): waitForEvent's park/settle/timeout
// mechanics, the storage-lazy virgin guarantee, and the per-incarnation wake record. Each test
// borrows a dedicated ctx's DO purely for its storage (runInDurableObject) and constructs a BARE
// Stream over it with no-op host deps — the DO's own #stream is never exercised in these ctxs, so
// the two instances never contend.

import { runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import { errorCode } from "../src/lib/errors.ts";
import { Stream } from "../src/stream/stream.ts";
import type { StreamEvent, StreamEventInput } from "../src/stream/events.ts";
import { stub } from "./support.ts";

/** A bare Stream over real storage. `admit` defaults to open; `onCommit` records each `fresh`
 *  batch so tests can assert what the fan-out was fed. */
function bareStream(
  storage: DurableObjectStorage,
  opts?: { admit?: (inputs: StreamEventInput[]) => void; batches?: StreamEvent[][] },
): Stream {
  return new Stream({
    storage,
    path: "/",
    admit: opts?.admit ?? (() => {}),
    reduceAtCommit: () => {},
    onCommit: (fresh) => opts?.batches?.push(fresh),
  });
}

test("waitForEvent: a parked waiter resolves with the committed event, fed from the fresh batch", async () => {
  await runInDurableObject(stub("prj_wait_park"), async (_instance, state) => {
    const batches: StreamEvent[][] = [];
    const stream = bareStream(state.storage, { batches });
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
    const stream = bareStream(state.storage);
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
    const stream = bareStream(state.storage);
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
    const stream = bareStream(state.storage);
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
    const stream = bareStream(state.storage);
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
    const stream = bareStream(state.storage);
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
    const stream = bareStream(state.storage);
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
      storage: state.storage,
      path: "/",
      admit: () => {},
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

test("append with ZERO inputs is a pure no-op — no rows, no offsets, no woken (it rides the first real append)", async () => {
  await runInDurableObject(stub("prj_wait_empty"), async (_instance, state) => {
    const batches: StreamEvent[][] = [];
    const stream = bareStream(state.storage, { batches });
    // Empty append on a VIRGIN stream: nothing minted, nothing committed, no fan-out — and the
    // wake record is NOT burned (pre-arc parity: an empty append must never manufacture a
    // woken-only durable batch).
    expect(stream.append()).toEqual([]);
    const tables = state.storage.sql
      .exec("SELECT name FROM sqlite_master WHERE type = 'table'")
      .toArray()
      .map((r) => String(r.name));
    expect(tables).not.toContain("events");
    expect(state.storage.kv.get("incarnation")).toBeUndefined();
    expect(state.storage.kv.get("maxAssignedOffset")).toBeUndefined();
    expect(batches).toHaveLength(0);
    // The woken rides the first REAL append: offset 1 = woken, offset 2 = the event.
    const [receipt] = stream.append({ type: "hello" });
    expect(receipt.offset).toBe(2);
    const page = stream.read(0);
    expect(page.events[0].type).toBe("events.iterate.com/stream/woken");
    expect(page.events[0].offset).toBe(1);
  });
});

test("woken: the first commit of an incarnation carries the wake record first, exactly once", async () => {
  await runInDurableObject(stub("prj_wait_woken"), async (_instance, state) => {
    const batches: StreamEvent[][] = [];
    const stream = bareStream(state.storage, { batches });
    const receipts = stream.append({ type: "hello" });
    // per-input receipts: the platform's wake record is NOT echoed back to the caller
    expect(receipts).toHaveLength(1);
    expect(receipts[0].type).toBe("hello");
    expect(receipts[0].offset).toBe(2);
    // …but it IS the first durable fact of the incarnation, and the fan-out saw it
    const page = stream.read(0);
    expect(page.events[0].type).toBe("events.iterate.com/stream/woken");
    expect(page.events[0].offset).toBe(1);
    expect(page.events[0].payload).toEqual({ incarnation: stream.currentIncarnation() });
    expect(batches[0][0].type).toBe("events.iterate.com/stream/woken");
    // exactly once per incarnation
    stream.append({ type: "again" });
    const woken = stream.read(0).events.filter((e) => e.type === "events.iterate.com/stream/woken");
    expect(woken).toHaveLength(1);
  });
});

test("woken: a refused or rolled-back first batch does NOT burn the wake record", async () => {
  await runInDurableObject(stub("prj_wait_wokenroll"), async (_instance, state) => {
    // (a) admission refusal: no commit, no woken — the stream stays virgin.
    const refusing = bareStream(state.storage, {
      admit: (inputs) => {
        if (inputs.some((i) => i.type === "nope")) throw new Error("refused at the door");
      },
    });
    expect(() => refusing.append({ type: "nope" })).toThrow("refused at the door");
    expect(refusing.read(0).events).toHaveLength(0);
    // (b) a mid-batch rollback AFTER injection: the txn throw leaves the flag unset, so the
    // NEXT landed commit carries the wake record.
    expect(() =>
      refusing.append(
        { type: "a", payload: { v: 1 }, idempotencyKey: "k" },
        { type: "a", payload: { v: 2 }, idempotencyKey: "k" }, // same key, different body → conflict
      ),
    ).toThrow(/idempotency key/);
    const [ok] = refusing.append({ type: "ok" });
    const page = refusing.read(0);
    expect(page.events[0].type).toBe("events.iterate.com/stream/woken");
    expect(page.events[1].offset).toBe(ok.offset);
    expect(page.events.filter((e) => e.type === "events.iterate.com/stream/woken")).toHaveLength(1);
  });
});

// ── EPHEMERALS COST ZERO WRITES (the header contract, pinned against real storage) ──

test("an ephemeral-only append writes NOTHING — no row, no high-water mark — yet hands out offsets and reaches the fan-out", async () => {
  await runInDurableObject(stub("prj_eph_zero_writes"), async (_instance, state) => {
    const batches: StreamEvent[][] = [];
    const stream = bareStream(state.storage, { batches });
    // One durable first: the wake record + this row mint storage and the mark (offsets 1, 2).
    await stream.append({ type: "durable" });
    const markAfterDurable = state.storage.kv.get("maxAssignedOffset");
    expect(markAfterDurable).toBe(2);
    const rowsBefore = state.storage.sql.exec("SELECT count(*) AS n FROM events").one().n;
    // A flood of ephemeral-only batches: offsets advance in memory, storage stays byte-identical.
    for (let i = 0; i < 25; i++)
      stream.append({ type: "chunk", ephemeral: true }, { type: "chunk", ephemeral: true });
    expect(stream.highestAssignedOffset()).toBe(2 + 50);
    expect(state.storage.kv.get("maxAssignedOffset")).toBe(markAfterDurable); // NOT written
    expect(state.storage.sql.exec("SELECT count(*) AS n FROM events").one().n).toBe(rowsBefore);
    // …and every batch reached onCommit with contiguous ranges (the fan-out saw all 50).
    expect(batches.slice(1).flat()).toHaveLength(50);
    expect(batches.at(-1)![1].offset).toBe(52);
    // The next DURABLE batch commits the mark PAST the ephemerals it never wrote — every offset
    // handed out this incarnation is covered by the durable row's transaction.
    const [d] = await stream.append({ type: "durable" });
    expect(d.offset).toBe(53);
    expect(state.storage.kv.get("maxAssignedOffset")).toBe(53);
  });
});

test("across incarnations an ephemeral-only tail's offsets are REUSED by the next durable — the documented contract, and why every checkpoint advances only on a durable", async () => {
  await runInDurableObject(stub("prj_eph_reuse"), async (_instance, state) => {
    const first = bareStream(state.storage);
    await first.append({ type: "durable" }); // offsets 1 (woken), 2
    first.append({ type: "chunk", ephemeral: true }, { type: "chunk", ephemeral: true }); // 3, 4 — memory only
    expect(first.highestAssignedOffset()).toBe(4);
    // A NEW incarnation over the same storage resumes from the last DURABLE mark…
    const second = bareStream(state.storage);
    expect(second.highestAssignedOffset()).toBe(2);
    // …so its first commit (which carries a fresh wake record, durable) hands out 3 again.
    const [d] = await second.append({ type: "durable" });
    expect(d.offset).toBe(4); // woken took 3, this durable took 4 — both numbers the dead ephemerals held
    expect(state.storage.kv.get("maxAssignedOffset")).toBe(4);
    // The log itself is exact: durables 1, 2 from the first life, 3 (woken), 4 from the second.
    expect((await second.read(0)).events.map((e) => e.offset)).toEqual([1, 2, 3, 4]);
  });
});

test("read()'s short-page proof is the DURABLE mark, never the in-memory head (an ephemeral tail is not proven)", async () => {
  await runInDurableObject(stub("prj_eph_proof"), async (_instance, state) => {
    const stream = bareStream(state.storage);
    stream.append({ type: "tick" }); // woken@1, tick@2 — durable, mark 2
    stream.append({ type: "blip", ephemeral: true }, { type: "blip", ephemeral: true }); // @3 @4 in memory
    expect(stream.highestAssignedOffset()).toBe(4);
    expect(stream.durableMark()).toBe(2);
    // A reader must never learn an offset a later incarnation could hand to a durable: the proof
    // stops at the mark. (A persisted checkpoint or cursor built from this read is therefore safe.)
    expect(stream.read(0).scannedThroughOffset).toBe(2);
    expect(stream.read(2).scannedThroughOffset).toBe(2);
    // The next durable batch moves both.
    stream.append({ type: "tick" }); // @5
    expect(stream.durableMark()).toBe(5);
    expect(stream.read(0).scannedThroughOffset).toBe(5);
  });
});

test("a warm ephemeral-only append runs NO SQL at all (no read, no write, no transaction)", async () => {
  await runInDurableObject(stub("prj_eph_nosql"), async (_instance, state) => {
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
    stream.append({ type: "tick" }); // the incarnation's first commit is durable (woken) — warms every cache
    stream.append({ type: "blip", ephemeral: true }); // one ephemeral through the fast path, caches warm
    Object.assign(counts, { exec: 0, txn: 0, put: 0 });
    stream.append({ type: "blip", ephemeral: true }, { type: "blip", ephemeral: true });
    expect(counts).toEqual({ exec: 0, txn: 0, put: 0 });
  });
});
