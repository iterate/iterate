// alarm-coordinator.test.ts — the two holds and the dedupe, as a table over a recorded storage:
// every `setAlarm` / `deleteAlarm` the coordinator issues lands in `writes`, in order.

import { expect, test } from "vitest";
import { AlarmCoordinator } from "./alarm-coordinator.ts";

const T = Date.parse("2030-01-01T00:00:00Z");

function setup(deadlines: (number | null)[] = []) {
  const writes: (number | "delete")[] = [];
  const alarms = new AlarmCoordinator({
    setAlarm: async (at) => void writes.push(at),
    deleteAlarm: async () => void writes.push("delete"),
    deadlines: () => deadlines,
  });
  return { alarms, writes, deadlines };
}

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

test("an inherited alarm already due is neither re-set nor deleted until a pass completes", async () => {
  const { alarms, writes, deadlines } = setup([T + 20_000]);
  alarms.restore(T - 5_000);
  alarms.reconcile();
  deadlines.length = 0;
  alarms.reconcile();
  expect(writes).toEqual([]);
  await alarms.pass(async () => {});
  // The completed pass spent it (the runtime deletes it): nothing wanted, nothing written.
  expect(writes).toEqual([]);
  expect(alarms.snapshot()).toEqual({ armedAt: null, inheritedAt: null, passInProgress: false });
  deadlines.push(T);
  alarms.reconcile();
  expect(writes).toEqual([T]);
});

test("a future inherited alarm is kept over a later deadline and yields to an earlier one", () => {
  const { alarms, writes, deadlines } = setup([T + 10_000]);
  alarms.restore(T);
  alarms.reconcile();
  expect(writes).toEqual([]);
  deadlines.splice(0, deadlines.length, T - 10_000);
  alarms.reconcile();
  expect(writes).toEqual([T - 10_000]);
});

test("nothing is written during a pass; the pass's own time can be armed again afterwards", async () => {
  const { alarms, writes, deadlines } = setup([T]);
  alarms.reconcile();
  expect(writes).toEqual([T]);
  await alarms.pass(async () => {
    deadlines.push(T - 1);
    alarms.reconcile();
    expect(alarms.snapshot().passInProgress).toBe(true);
    expect(writes).toEqual([T]);
    deadlines.splice(0, deadlines.length, T);
  });
  // Thirty-three schedules due at the same instant: the 33rd is armed at the time that just fired.
  expect(writes).toEqual([T, T]);
});

test("a pass that throws keeps the inherited hold and forgets the armed time", async () => {
  const { alarms, writes } = setup([T + 50_000]);
  alarms.restore(T);
  alarms.reconcile();
  await expect(alarms.pass(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
  expect(writes).toEqual([]);
  expect(alarms.snapshot()).toEqual({ armedAt: null, inheritedAt: T, passInProgress: false });
  alarms.reconcile(); // the hold still wins, and the forgotten time is armed again (a no-op write in storage)
  expect(writes).toEqual([T]);
  await alarms.pass(async () => {});
  expect(writes).toEqual([T, T + 50_000]);
});
