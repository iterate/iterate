// client/event-log.test.ts — the log half of useIterateContext over a fake context whose
// `readEvents` answers as apps/os stream.ts `read` does: at most `limit` rows (capped at 1000) and a
// byte budget (here: at most 300 rows a page), `atHead` once the scan ran out, `scannedThroughOffset`
// the last row read or, at the head, the durable mark. Offsets have gaps, as a log whose ephemerals
// took offsets has.

import { expect, test } from "vitest";
import type { StreamEvent } from "../stream/processor.ts";
import { connectEventLog, type EventLogItx } from "./event-log.ts";

test("tail: probes the head, reads the page of offsets below it, and is caught up holding only that", async () => {
  const context = fakeContext(offsetsWithGaps(5000));
  const log = connectEventLog(context.itx, { consumes: ["*"], history: "tail" });
  await settle();
  const held = log.get();
  expect(held).toMatchObject({
    caughtUp: true,
    head: context.head,
    older: { loading: false, exhausted: false },
  });
  expect(offsetsOf(held.events)).toEqual(context.offsets.filter((o) => o > context.head - 1000));
  // the probe, then the page (cut by the budget: read on to the head)
  expect(context.reads[0]).toEqual([Number.MAX_SAFE_INTEGER, 1]);
  log.dispose();
});

test("loadOlder reads window after window down to offset 0, and the log is the whole log, sorted, once", async () => {
  const context = fakeContext(offsetsWithGaps(5000));
  const log = connectEventLog(context.itx, { consumes: ["*"], history: "tail" });
  await settle();
  for (let i = 0; i < 20 && !log.get().older.exhausted; i += 1) {
    log.loadOlder();
    log.loadOlder(); // one read in flight: a second call is a no-op
    expect(log.get().older.loading || context.pendingOlder()).toBe(true);
    await settle();
  }
  const held = log.get();
  expect(held).toMatchObject({ older: { loading: false, exhausted: true } });
  expect(offsetsOf(held.events)).toEqual(context.offsets);
  log.dispose();
});

test("a sparse log: loadOlder reads on (doubling the window) until it found a quarter page of events", async () => {
  // 20,000 offsets, one durable event in every hundred
  const offsets = Array.from({ length: 200 }, (_, i) => (i + 1) * 100);
  const context = fakeContext(offsets);
  const log = connectEventLog(context.itx, { consumes: ["*"], history: "tail" });
  await settle();
  expect(log.get().events).toHaveLength(10);
  log.loadOlder();
  await settle();
  // 10 + 10 + 20 + 40 + 80 < 250: the fifth window (capped at 16,000 offsets) reaches offset 0
  expect(log.get().events).toHaveLength(200);
  expect(log.get()).toMatchObject({ older: { loading: false, exhausted: true } });
  expect(context.reads.slice(2).map(([after]) => after)).toEqual([18000, 16000, 12000, 4000, 0]);
  log.dispose();
});

test("pushes and pages dedupe by offset, and a push past the head appends", async () => {
  const context = fakeContext(offsetsWithGaps(1500));
  const log = connectEventLog(context.itx, { consumes: ["*"], history: "tail" });
  await settle();
  const before = log.get().events.length;
  // the subscription re-delivers the newest event and delivers two new ones
  context.push([context.head, context.head + 3, context.head + 5]);
  await settle();
  const held = log.get();
  expect(held.events).toHaveLength(before + 2);
  expect(held).toMatchObject({ head: context.head + 5 });
  expect(offsetsOf(held.events.slice(-3))).toEqual([
    context.head,
    context.head + 3,
    context.head + 5,
  ]);
  log.dispose();
});

test("a push that lands before the first read: the older events read as loading, never as the start of the log", async () => {
  const context = fakeContext(offsetsWithGaps(3000));
  const read = context.itx.readEvents.bind(context.itx);
  let release = () => {};
  const firstRead = new Promise<void>((resolve) => (release = resolve));
  context.itx.readEvents = async (...args) => {
    await firstRead;
    return read(...args);
  };
  const log = connectEventLog(context.itx, { consumes: ["*"], history: "tail" });
  await settle();
  // the live subscription delivers the newest event while the head probe is still unanswered
  context.push([context.head + 1]);
  await settle();
  expect(log.get()).toMatchObject({ caughtUp: false, older: { loading: true, exhausted: false } });
  release();
  await settle();
  expect(log.get()).toMatchObject({ caughtUp: true, older: { loading: false, exhausted: false } });
  log.dispose();
});

test("all: reads every page from the first and is exhausted at once", async () => {
  const context = fakeContext(offsetsWithGaps(3000));
  const log = connectEventLog(context.itx, { consumes: ["*"], history: "all" });
  await settle();
  const held = log.get();
  expect(held).toMatchObject({ caughtUp: true, older: { exhausted: true } });
  expect(offsetsOf(held.events)).toEqual(context.offsets);
  log.dispose();
});

test("who acted and the processors table's version follow the events held", async () => {
  const context = fakeContext([1, 2, 3, 4], (offset) => ({
    ...(offset === 2 && { type: "events.iterate.com/itx/subscription-configured" }),
    ...(offset !== 3 && {
      source: { origin: "/", principal: { actor: offset === 4 ? "user_b" : "user_a" } },
    }),
  }));
  const log = connectEventLog(context.itx, { consumes: ["*"], history: "all" });
  await settle();
  const held = log.get();
  expect(held).toMatchObject({ tableVersion: 2 });
  expect(held.actors.map((actor) => actor.actor)).toEqual(["user_b", "user_a"]);
  expect(held.actors[1]).toMatchObject({ lastSeenAt: createdAt(2) });
  log.dispose();
});

// ── the fake context ──
function fakeContext(
  offsets: number[],
  extra: (offset: number) => Partial<StreamEvent> = () => ({}),
) {
  const head = offsets.at(-1) ?? 0;
  const eventAt = (offset: number) =>
    ({
      offset,
      type: "test.example.com/thing",
      createdAt: createdAt(offset),
      payload: { offset },
      ...extra(offset),
    }) as StreamEvent;
  let target: ((batch: unknown[]) => void) | undefined;
  const reads: [number, number][] = [];
  let inFlight = 0;
  const itx: EventLogItx = {
    async subscribe(input) {
      target = (batch) => input.target(batch, undefined);
      return { [Symbol.dispose]() {} };
    },
    async readEvents(after = 0, limit = 500) {
      reads.push([after, limit]);
      inFlight += 1;
      await Promise.resolve();
      inFlight -= 1;
      const cap = Math.min(Math.max(1, limit), 1000, 300); // 300: the byte budget's cut
      const rows = offsets.filter((offset) => offset > after).slice(0, cap);
      const last = rows.at(-1) ?? after;
      const atHead = rows.length < cap || last >= head;
      return {
        events: rows.map(eventAt),
        atHead,
        scannedThroughOffset: atHead ? head : last,
      };
    },
  };
  return {
    itx,
    head,
    offsets,
    reads,
    pendingOlder: () => inFlight > 0,
    push: (pushed: number[]) => target!(pushed.map(eventAt)),
  };
}

/** `count` durable offsets from 1, skipping every seventh (the gaps ephemerals leave). */
function offsetsWithGaps(count: number) {
  const offsets: number[] = [];
  for (let offset = 1; offsets.length < count; offset += 1)
    if (offset % 7 !== 0) offsets.push(offset);
  return offsets;
}

const createdAt = (offset: number) => new Date(Date.UTC(2026, 8, 25) + offset * 1000).toISOString();
const offsetsOf = (events: StreamEvent[]) => events.map((event) => event.offset);

/** Let every read resolve and the next publish (a 16 ms timer outside a browser) run. */
async function settle() {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
}
