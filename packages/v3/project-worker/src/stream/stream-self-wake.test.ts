// stream-self-wake.test.ts — THE BILLING CIRCUIT-BREAKER's core (wave-0 3b, Jonas: "we need runaway
// billing controls"). A durable self-wake streak gates the single alarm-arm chokepoint
// (Stream.armAlarmNoLaterThan): past the ceiling, arming is a no-op until a public door clears the
// streak. Tested over the REAL Stream + node:sqlite, observing setAlarm — no DO, no eviction needed.

import { expect, test } from "vitest";
import { nodeSqliteDurableObjectStorage } from "./node-sqlite-durable-object-storage.ts";
import { Stream } from "./stream.ts";
import type { DurableObjectStorageSlice } from "./stream-storage.ts";

/** A storage slice over node:sqlite that RECORDS every setAlarm — the arming the breaker gates. */
function recordingStorage(base = nodeSqliteDurableObjectStorage()) {
  const setAlarmAtMs: number[] = [];
  const slice: DurableObjectStorageSlice = {
    sql: base.sql,
    transactionSync: base.transactionSync,
    setAlarm: async (at) => {
      setAlarmAtMs.push(typeof at === "number" ? at : at.getTime());
    },
  };
  return { base, slice, setAlarmAtMs };
}

const newStream = (slice: DurableObjectStorageSlice): Stream =>
  new Stream({ storage: slice, path: "/", projectId: "prj_self_wake", onCommit: () => {} });

test("N alarm-only self-wakes stop alarm arming; a public door resumes it", () => {
  const { slice, setAlarmAtMs } = recordingStorage();
  const stream = newStream(slice);

  // Arming works normally.
  stream.armAlarmNoLaterThan(Date.now() + 60_000);
  expect(setAlarmAtMs.length).toBe(1);
  expect(stream.selfWakeHalted()).toBe(false);

  // Self-wake until halted — a SMALL, billing-safe ceiling (robust to the exact constant).
  let selfWakes = 0;
  while (!stream.selfWakeHalted() && selfWakes < 100) {
    stream.noteAlarmFired(); // each alarm pass clears the arm memo, as the real one does
    stream.noteSelfWake();
    selfWakes++;
  }
  expect(stream.selfWakeHalted()).toBe(true);
  expect(selfWakes).toBeLessThanOrEqual(10); // a few minutes of a loop, not hours

  // Arming is now a no-op — the loop cannot re-arm from anywhere.
  const armsBefore = setAlarmAtMs.length;
  stream.noteAlarmFired();
  stream.armAlarmNoLaterThan(Date.now() + 60_000);
  expect(setAlarmAtMs.length).toBe(armsBefore);

  // A real public door clears the streak and arming resumes.
  stream.notePublicDoor();
  expect(stream.selfWakeHalted()).toBe(false);
  stream.armAlarmNoLaterThan(Date.now() + 60_000);
  expect(setAlarmAtMs.length).toBe(armsBefore + 1);
});

test("the streak is DURABLE across incarnations — a reborn Stream over the same store stays halted", () => {
  const { base, slice } = recordingStorage();
  let stream = newStream(slice);
  while (!stream.selfWakeHalted()) stream.noteSelfWake();
  expect(stream.selfWakeHalted()).toBe(true);

  // A NEW incarnation over the SAME storage (the loop evicts between wakes — the streak must survive).
  stream = newStream({ sql: base.sql, transactionSync: base.transactionSync, setAlarm: async () => {} });
  expect(stream.selfWakeHalted()).toBe(true); // it persisted

  // And a public door clears it durably: a third incarnation sees zero.
  stream.notePublicDoor();
  stream = newStream({ sql: base.sql, transactionSync: base.transactionSync, setAlarm: async () => {} });
  expect(stream.selfWakeHalted()).toBe(false);
});

test("a public door is a NO-OP write when the streak is already zero (the common request path pays nothing)", () => {
  const { slice } = recordingStorage();
  const stream = newStream(slice);
  // Nothing to reset: notePublicDoor must not touch storage. (Observed by staying un-halted and by
  // not throwing — the write path is only taken when the streak moves off zero.)
  expect(stream.selfWakeHalted()).toBe(false);
  stream.notePublicDoor();
  stream.notePublicDoor();
  expect(stream.selfWakeHalted()).toBe(false);
});
