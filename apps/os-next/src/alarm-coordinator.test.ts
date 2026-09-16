// alarm-coordinator.test.ts — the pass hold and the dedupe, as a table over a recorded storage:
// every `setAlarm` / `deleteAlarm` the coordinator issues lands in `writes`, in order. The alarm is
// a pure function of the deadlines: a restored alarm is only the dedupe seed, never a hold — every
// reason to wake is derived again at construction, so a different derived time simply supersedes it.

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

test("a restored alarm is only the dedupe seed: the same derived time is not re-written, a later one supersedes it, nothing wanted deletes it", () => {
  const { alarms, writes, deadlines } = setup([T + 20_000]);
  alarms.restore(T + 20_000);
  alarms.reconcile();
  expect(writes).toEqual([]);
  // Nothing durable is due before T + 30 s: the stored T + 20 s was a reason that no longer exists
  // (an idle deadline of a dead incarnation, say), and superseding it is right.
  deadlines.splice(0, deadlines.length, T + 30_000);
  alarms.reconcile();
  expect(writes).toEqual([T + 30_000]);
  deadlines.length = 0;
  alarms.reconcile();
  expect(writes).toEqual([T + 30_000, "delete"]);
  expect(alarms.snapshot()).toEqual({ armedAt: null, passInProgress: false });
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

test("a pass that throws writes nothing (the runtime retries it) and forgets the armed time; the next reconcile derives afresh", async () => {
  const { alarms, writes } = setup([T + 50_000]);
  alarms.restore(T);
  await expect(alarms.pass(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
  expect(writes).toEqual([]);
  expect(alarms.snapshot()).toEqual({ armedAt: null, passInProgress: false });
  alarms.reconcile();
  expect(writes).toEqual([T + 50_000]);
});
