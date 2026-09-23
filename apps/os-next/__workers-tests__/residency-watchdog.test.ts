// __workers-tests__/residency-watchdog.test.ts — THE RESIDENCY WATCHDOG on the context's one alarm
// (src/context/residency-watchdog.ts), inside workerd with Date faked: a whole window passes in a
// moment with the incarnation still resident — what a pin does on the edge — and the harness fires
// the alarm on demand and evicts for a fresh incarnation. The deployed half — an armed watchdog delays
// neither eviction nor hibernation, and a real pin is recorded — is e2e/context-watchdog.e2e.test.ts.
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import type { StreamEvent } from "iterate/next/stream/processor";
import { RESIDENCY_WATCHDOG_WINDOW_MS as W } from "../src/context/residency-watchdog.ts";
import { STREAM_ALARM_TRACE_EVENT } from "../src/stream/stream.ts";
import { releasePins, stub } from "./support.ts";

const HELD = "events.iterate.com/context/held-resident-while-idle";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const read = async (ctx: string, includeEphemeral = false): Promise<StreamEvent[]> =>
  (
    (await stub(ctx).invoke(["itx", ["readEvents", 0, 500, { includeEphemeral }]])) as {
      events: StreamEvent[];
    }
  ).events;
const alarmOf = (ctx: string): Promise<number | null> =>
  runInDurableObject(stub(ctx), (_instance, state) => state.storage.getAlarm());
const incarnationOf = (ctx: string): Promise<number> =>
  runInDurableObject(stub(ctx), (_instance, state) =>
    Number(
      state.storage.sql.exec("SELECT value FROM stream_meta WHERE key = 'incarnation'").one().value,
    ),
  );

/** A fresh context, Date frozen at `t0`, touched once — the call that arms the watchdog. */
async function touchedAt(ctx: string, t0: number): Promise<void> {
  vi.useFakeTimers({ now: t0, toFake: ["Date"] });
  await stub(ctx).invoke("itx.schedules.list()");
}

test("ARMED ONCE PER QUIET WINDOW: the first inbound call arms the alarm a window out; later calls write nothing", async () => {
  const ctx = "prj_wd_armed";
  const t0 = Date.now();
  await touchedAt(ctx, t0);
  expect(await alarmOf(ctx)).toBe(t0 + W);
  vi.setSystemTime(t0 + 60_000);
  await stub(ctx).invoke("itx.schedules.list()");
  await stub(ctx).read(0);
  expect(await alarmOf(ctx)).toBe(t0 + W);
});

test("A CALL INSIDE THE WINDOW RE-ARMS: the alarm moves to a window after that call, and the wake appends nothing — no record, no wake record, no trace", async () => {
  const ctx = "prj_wd_rearm";
  const t0 = Date.now();
  await touchedAt(ctx, t0);
  vi.setSystemTime(t0 + 5 * 60_000);
  const before = await read(ctx, true);
  vi.setSystemTime(t0 + W);
  expect(await runDurableObjectAlarm(stub(ctx))).toBe(true);
  expect(await alarmOf(ctx)).toBe(t0 + 5 * 60_000 + W);
  const after = await read(ctx, true);
  expect(after.slice(before.length)).toEqual([]);
  expect(after.some((event) => event.type === STREAM_ALARM_TRACE_EVENT)).toBe(false);
});

test("WORK IN FLIGHT DEFERS: a call still open at the deadline re-arms a window from now, and nothing is recorded", async () => {
  const ctx = "prj_wd_in_flight";
  const t0 = Date.now();
  await touchedAt(ctx, t0);
  const waiting = stub(ctx).invoke([
    "itx",
    ["waitForEvent", { type: "wd/release", timeoutMs: 10_000 }],
  ]) as Promise<StreamEvent>;
  await new Promise((r) => setTimeout(r, 100)); // the waiter is registered
  vi.setSystemTime(t0 + W);
  expect(await runDurableObjectAlarm(stub(ctx))).toBe(true);
  expect(await alarmOf(ctx)).toBe(t0 + 2 * W);
  await stub(ctx).append({ type: "wd/release" });
  expect((await waiting).type).toBe("wd/release");
  expect((await read(ctx)).filter((event) => event.type === HELD)).toEqual([]);
});

test("HELD, RECORDED ONCE: resident a whole window with nothing in flight appends one durable record and one warn line, and the incarnation is never armed again", async () => {
  const ctx = "prj_wd_held";
  const warn = vi.spyOn(console, "warn");
  const t0 = Date.now();
  await touchedAt(ctx, t0);
  const incarnation = await incarnationOf(ctx);
  vi.setSystemTime(t0 + W);
  expect(await runDurableObjectAlarm(stub(ctx))).toBe(true);
  const held = (await read(ctx)).filter((event) => event.type === HELD);
  expect(held.map((event) => event.payload)).toEqual([
    {
      incarnation,
      idleSince: new Date(t0).toISOString(),
      idleForMs: W,
      liveFacets: [],
      borrowedRpcStubs: 0,
      rpcStubPagers: 0,
      webSockets: 0,
      libraryHoldsSocket: false,
    },
  ]);
  expect(warn).toHaveBeenCalledWith(
    expect.objectContaining({
      event: "context.held-resident-while-idle",
      namespace: "iterate-context",
      durableObjectId: expect.any(String),
      incarnation,
      idleForMs: W,
    }),
  );
  // Once per incarnation: no alarm is left, a later call arms nothing, a later alarm fires nothing.
  expect(await alarmOf(ctx)).toBeNull();
  vi.setSystemTime(t0 + 2 * W);
  await stub(ctx).invoke("itx.schedules.list()");
  expect(await alarmOf(ctx)).toBeNull();
  vi.setSystemTime(t0 + 4 * W);
  expect(await runDurableObjectAlarm(stub(ctx))).toBe(false);
  expect((await read(ctx)).filter((event) => event.type === HELD)).toHaveLength(1);
});

test("A FRESH INCARNATION'S WATCHDOG WAKE IS A NO-OP: the alarm an evicted incarnation left appends nothing and re-derives only the durable deadlines", async () => {
  const ctx = "prj_wd_fresh";
  const t0 = Date.now();
  await touchedAt(ctx, t0);
  // A durable deadline two windows out: the watchdog's alarm is the earlier one.
  await stub(ctx).invoke([
    "itx",
    "schedules",
    [
      "set",
      {
        key: "later",
        when: { at: new Date(t0 + 2 * W).toISOString() },
        events: [{ type: "later" }],
      },
    ],
  ]);
  expect(await alarmOf(ctx)).toBe(t0 + W);
  const before = await read(ctx);
  const incarnation = await incarnationOf(ctx);
  await releasePins(ctx);
  await evictDurableObject(stub(ctx));
  vi.setSystemTime(t0 + W);
  expect(await runDurableObjectAlarm(stub(ctx))).toBe(true);
  // One incarnation more, and the alarm re-derived from what is durable: the schedule's.
  expect(await incarnationOf(ctx)).toBe(incarnation + 1);
  expect(await alarmOf(ctx)).toBe(t0 + 2 * W);
  // The wake appended nothing: the one new event is the wake record of the read below — this
  // incarnation's first inbound call, so its reason is "request".
  const appended = (await read(ctx)).slice(before.length);
  expect(appended.map((event) => [event.type, event.payload])).toEqual([
    ["events.iterate.com/stream/woken", { incarnation: incarnation + 1, reason: "request" }],
  ]);
});

test("A FRESH INCARNATION WITH NOTHING DURABLE LEAVES NO ALARM", async () => {
  const ctx = "prj_wd_fresh_empty";
  const t0 = Date.now();
  await touchedAt(ctx, t0);
  expect(await alarmOf(ctx)).toBe(t0 + W);
  await releasePins(ctx);
  await evictDurableObject(stub(ctx));
  vi.setSystemTime(t0 + W);
  expect(await runDurableObjectAlarm(stub(ctx))).toBe(true);
  expect(await alarmOf(ctx)).toBeNull();
});
