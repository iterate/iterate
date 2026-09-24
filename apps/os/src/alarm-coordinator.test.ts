// alarm-coordinator.test.ts — the pass hold, the dedupe and the overdue watch, as a table over a
// recorded storage: every `setAlarm` / `deleteAlarm` the coordinator issues lands in `writes`, in
// order. The alarm is a pure function of the deadlines: a restored alarm is only the dedupe seed,
// never a hold — every reason to wake is derived again at construction, so a different derived time
// simply supersedes it. The overdue watch works around an alarm the runtime held (the header of
// alarm-coordinator.ts): at birth it re-arms it; while held, on a timer, it runs the pass itself.

import { expect, onTestFinished, test, vi } from "vitest";
import {
  ALARM_MAX_WATCH_PASSES,
  ALARM_OVERDUE_AFTER_MS,
  AlarmCoordinator,
  type OverdueAlarm,
} from "./alarm-coordinator.ts";

const T = Date.parse("2030-01-01T00:00:00Z");

test("arms the earliest deadline, moves later or earlier exactly, writes only on change", () => {
  const { alarms, writes, deadlines } = setup([T + 60_000, null, T + 30_000]);
  alarms.reconcile();
  alarms.reconcile();
  expect(writes).toEqual([T + 30_000]);
  deadlines.splice(0, deadlines.length, T + 60_000);
  alarms.reconcile();
  expect(writes).toEqual([T + 30_000, T + 60_000]);
  deadlines.splice(0, deadlines.length, T + 10_000);
  alarms.reconcile();
  expect(writes).toEqual([T + 30_000, T + 60_000, T + 10_000]);
});

test("no deadline deletes the alarm once; nothing armed, nothing deleted", () => {
  const { alarms, writes, deadlines } = setup();
  alarms.reconcile();
  expect(writes).toEqual([]);
  deadlines.push(T);
  alarms.reconcile();
  deadlines.length = 0;
  alarms.reconcile();
  alarms.reconcile();
  expect(writes).toEqual([T, "delete"]);
});

test("a restored alarm is only the dedupe seed: the same derived time is not re-written, a later one supersedes it, nothing wanted deletes it", () => {
  const { alarms, writes, deadlines } = setup([T + 20_000]);
  alarms.restore(T + 20_000);
  alarms.reconcile();
  expect(writes).toEqual([]);
  // Nothing durable is due before T + 30 s: the stored T + 20 s was a reason that no longer exists
  // (one a dead incarnation left, say), and superseding it is right.
  deadlines.splice(0, deadlines.length, T + 30_000);
  alarms.reconcile();
  expect(writes).toEqual([T + 30_000]);
  deadlines.length = 0;
  alarms.reconcile();
  expect(writes).toEqual([T + 30_000, "delete"]);
  expect(alarms.snapshot()).toEqual({
    armedAt: null,
    passInProgress: false,
    lastPassStartedAt: null,
  });
});

test("nothing is written during a pass; the pass's own time can be armed again afterwards", async () => {
  const { alarms, writes, deadlines } = setup([T]);
  alarms.reconcile();
  expect(writes).toEqual([T]);
  await alarms.pass(
    async () => {
      deadlines.push(T - 1);
      alarms.reconcile();
      expect(alarms.snapshot()).toMatchObject({ passInProgress: true });
      expect(writes).toEqual([T]);
      deadlines.splice(0, deadlines.length, T);
    },
    { delivered: true },
  );
  // Thirty-three schedules due at the same instant: the 33rd is armed at the time that just fired.
  expect(writes).toEqual([T, T]);
  expect(alarms.snapshot()).toMatchObject({ lastPassStartedAt: T });
});

test("a pass that throws writes nothing (the runtime retries it) and forgets the armed time; the next reconcile derives afresh", async () => {
  const { alarms, writes } = setup([T + 50_000]);
  alarms.restore(T);
  await expect(
    alarms.pass(async () => Promise.reject(new Error("boom")), { delivered: true }),
  ).rejects.toThrow("boom");
  expect(writes).toEqual([]);
  expect(alarms.snapshot()).toMatchObject({ armedAt: null, passInProgress: false });
  alarms.reconcile();
  expect(writes).toEqual([T + 50_000]);
});

test("while held: an armed alarm the runtime has not delivered ALARM_OVERDUE_AFTER_MS past its time is passed HERE — no re-arm, no write until the pass's own end", async () => {
  const { alarms, writes, deadlines, overdue, passes } = setup([T + 1_500], { held: true });
  alarms.reconcile();
  vi.advanceTimersByTime(1_500 + ALARM_OVERDUE_AFTER_MS - 1);
  expect(passes).toMatchObject({ count: 0 });
  vi.advanceTimersByTime(1);
  expect({ passes: passes.count, writes, overdue }).toEqual({
    passes: 1,
    writes: [T + 1_500],
    overdue: [{ armedAt: T + 1_500, overdueMs: ALARM_OVERDUE_AFTER_MS, action: "pass" }],
  });
  // The pass the DO runs: it spends the schedule, and a later deadline is what is left.
  await alarms.pass(async () => void deadlines.splice(0, deadlines.length, T + 60_000), {
    delivered: false,
  });
  expect(writes).toEqual([T + 1_500, T + 60_000]);
});

test("a watch pass that leaves nothing wanted deletes the stored alarm — the runtime spent nothing of it", async () => {
  const { alarms, writes, deadlines } = setup([T + 1_500], { held: true });
  alarms.reconcile();
  vi.advanceTimersByTime(1_500 + ALARM_OVERDUE_AFTER_MS);
  await alarms.pass(async () => void deadlines.splice(0), { delivered: false });
  expect(writes).toEqual([T + 1_500, "delete"]);
});

test("a watch pass that leaves the SAME time due runs again, at most ALARM_MAX_WATCH_PASSES in a row, then gives up once and stops", async () => {
  const { alarms, writes, overdue, passes } = setup([T + 1_000], { held: true });
  alarms.reconcile();
  for (let i = 0; i < ALARM_MAX_WATCH_PASSES + 2; i++) {
    vi.advanceTimersByTime(ALARM_OVERDUE_AFTER_MS * 2);
    if (passes.count > i) await alarms.pass(async () => {}, { delivered: false });
  }
  expect({
    passes: passes.count,
    writes,
    actions: overdue.map((event) => event.action),
  }).toEqual({
    passes: ALARM_MAX_WATCH_PASSES,
    writes: [T + 1_000],
    actions: [...Array.from({ length: ALARM_MAX_WATCH_PASSES }, () => "pass"), "give-up"],
  });
});

test("a backlog at one instant (33+ schedules; a pass drains 32) is drained by watch passes ALARM_OVERDUE_AFTER_MS apart — never back-to-back into the cap", async () => {
  const { alarms, passes } = setup([T + 1_000], { held: true });
  alarms.reconcile();
  vi.advanceTimersByTime(1_000 + ALARM_OVERDUE_AFTER_MS);
  await alarms.pass(async () => {}, { delivered: false }); // 32 appended; the 33rd is due at T + 1 s
  vi.advanceTimersByTime(ALARM_OVERDUE_AFTER_MS - 1);
  const beforeTheSpacing = passes.count;
  vi.advanceTimersByTime(1);
  expect({ beforeTheSpacing, after: passes.count }).toEqual({ beforeTheSpacing: 1, after: 2 });
});

test("a watch pass after a birth re-arm keeps the armed time: a deadline still due is not written back, and the next pass waits its ALARM_OVERDUE_AFTER_MS", async () => {
  const { alarms, writes, passes } = setup([T - ALARM_OVERDUE_AFTER_MS], { held: true });
  alarms.restore(T - ALARM_OVERDUE_AFTER_MS);
  alarms.rearmIfOverdue(T); // writes T aside
  vi.advanceTimersByTime(ALARM_OVERDUE_AFTER_MS);
  await alarms.pass(async () => {}, { delivered: false }); // the backlog at the held time remains
  vi.advanceTimersByTime(ALARM_OVERDUE_AFTER_MS - 1);
  const beforeTheSpacing = passes.count;
  vi.advanceTimersByTime(1);
  expect({ writes, beforeTheSpacing, after: passes.count }).toEqual({
    writes: [T],
    beforeTheSpacing: 1,
    after: 2,
  });
});

test("no timer while nothing holds the actor (a pending timer holds off eviction); the first inbound call starts it, the last one's end stops it", () => {
  const holder = { held: false };
  const { alarms, passes } = setup([T + 1_500], holder);
  alarms.reconcile();
  vi.advanceTimersByTime(60_000);
  expect({ passes: passes.count, timers: vi.getTimerCount() }).toEqual({ passes: 0, timers: 0 });
  holder.held = true;
  alarms.watch();
  expect(vi.getTimerCount()).toBe(1);
  holder.held = false;
  alarms.watch();
  expect(vi.getTimerCount()).toBe(0);
  holder.held = true;
  alarms.watch();
  vi.advanceTimersByTime(0);
  expect(passes).toMatchObject({ count: 1 });
});

test("at birth: a restored alarm the sources still want, already overdue, is written again for NOW (never its own stored time); one within its grace is left to the runtime", () => {
  const late = setup([T - ALARM_OVERDUE_AFTER_MS]);
  late.alarms.restore(T - ALARM_OVERDUE_AFTER_MS);
  late.alarms.rearmIfOverdue(T);
  late.alarms.reconcile(); // the first commit: the wanted time is what it re-armed, nothing written back
  const onTime = setup([T - ALARM_OVERDUE_AFTER_MS + 1]);
  onTime.alarms.restore(T - ALARM_OVERDUE_AFTER_MS + 1);
  onTime.alarms.rearmIfOverdue(T);
  expect({ late, onTime }).toMatchObject({
    late: {
      writes: [T],
      overdue: [
        { armedAt: T - ALARM_OVERDUE_AFTER_MS, overdueMs: ALARM_OVERDUE_AFTER_MS, action: "rearm" },
      ],
    },
    onTime: { writes: [], overdue: [] },
  });
});

test("at birth: a stored time no source wants any more (a dead incarnation's watchdog or sweep, past) is superseded by a reconcile — never re-armed, never reported", () => {
  const gone = setup([null]);
  gone.alarms.restore(T - 60_000);
  gone.alarms.rearmIfOverdue(T);
  const later = setup([T + 30_000]);
  later.alarms.restore(T - 60_000);
  later.alarms.rearmIfOverdue(T);
  expect({ gone, later }).toMatchObject({
    gone: { writes: ["delete"], overdue: [] },
    later: { writes: [T + 30_000], overdue: [] },
  });
});

test("an alarm a THROWN pass left stored is the runtime's retry on its own backoff: the watch leaves it until the next pass starts", async () => {
  const { alarms, overdue, passes } = setup([T + 1_000], { held: true });
  alarms.reconcile();
  vi.advanceTimersByTime(1_000);
  await expect(
    alarms.pass(async () => Promise.reject(new Error("boom")), { delivered: true }),
  ).rejects.toThrow("boom");
  alarms.reconcile(); // a commit after the failure: the due deadline is armed again
  vi.advanceTimersByTime(ALARM_OVERDUE_AFTER_MS * 10);
  expect({ passes: passes.count, overdue }).toEqual({ passes: 0, overdue: [] });
  // The runtime's retry succeeds and the deadline is still wanted (and long due): the watch is back.
  await alarms.pass(async () => {}, { delivered: true });
  vi.advanceTimersByTime(0);
  expect(passes).toMatchObject({ count: 1 });
});

test("a delivered pass stops the watch, and the next armed time starts afresh", async () => {
  const { alarms, deadlines, passes } = setup([T + 1_000], { held: true });
  alarms.reconcile();
  let timersDuringPass = -1;
  vi.advanceTimersByTime(1_000);
  await alarms.pass(
    async () => {
      timersDuringPass = vi.getTimerCount();
      deadlines.splice(0, deadlines.length, Date.now() + 30_000);
    },
    { delivered: true },
  );
  vi.advanceTimersByTime(30_000 + ALARM_OVERDUE_AFTER_MS - 1);
  expect({ timersDuringPass, passes: passes.count }).toEqual({ timersDuringPass: 0, passes: 0 });
});

function setup(deadlines: (number | null)[] = [], holder = { held: false }) {
  vi.useFakeTimers({ now: T });
  onTestFinished(() => void vi.useRealTimers());
  const writes: (number | "delete")[] = [];
  const overdue: OverdueAlarm[] = [];
  const passes = { count: 0 };
  const alarms = new AlarmCoordinator({
    setAlarm: async (at) => void writes.push(at),
    deleteAlarm: async () => void writes.push("delete"),
    deadlines: () => deadlines,
    held: () => holder.held,
    runOverduePass: () => void (passes.count += 1),
    onOverdue: (event) => void overdue.push(event),
  });
  return { alarms, writes, deadlines, overdue, passes };
}
