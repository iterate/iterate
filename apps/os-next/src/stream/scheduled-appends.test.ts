import { expect, test } from "vitest";
import { CoreContract, normalizeControlEvent, reduceCoreEventBatch } from "./core-processor.ts";
import { Stream, type DurableObjectStorageSlice } from "./stream.ts";
import { nodeSqliteDurableObjectStorage } from "./test-support.ts";

const scheduled = (key = "reminder", at = "2030-01-01T00:00:00Z") =>
  normalizeControlEvent({
    type: "events.iterate.com/stream/append-scheduled",
    payload: {
      key,
      when: { at },
      events: [{ type: "reminder", payload: { n: 1 } }, { type: "audit" }],
    },
  });
function setup() {
  const base = nodeSqliteDurableObjectStorage();
  const alarms: number[] = [];
  const storage: DurableObjectStorageSlice = {
    ...base,
    setAlarm: async (at) => {
      alarms.push(Number(at));
    },
  };
  const create = () => new Stream({ storage, path: "/", projectId: "prj_schedule", onCommit() {} });
  return { stream: create(), create, alarms, storage };
}

test("a schedule, replacement, stale cancellation and atomic completion reconstruct from the log", () => {
  const { stream, create } = setup();
  const [first] = stream.append(scheduled());
  const [second] = stream.append(scheduled("reminder", "2031-01-01T00:00:00Z"));
  stream.append({
    type: "events.iterate.com/stream/append-schedule-cancelled",
    payload: { key: "reminder", ifScheduledAtOffset: first.offset },
  });
  expect(create().coreReducedState.schedules.reminder.scheduledAtOffset).toBe(second.offset);
  stream.append(
    { type: "reminder", payload: { n: 1 } },
    { type: "audit" },
    {
      type: "events.iterate.com/stream/append-schedule-completed",
      payload: { key: "reminder", scheduledAtOffset: second.offset },
    },
  );
  expect(create().coreReducedState.schedules).toEqual({});
  const log = stream.read(0, 100).events;
  expect(
    reduceCoreEventBatch(log, CoreContract.initialState(), (error) => {
      throw error;
    }).schedules,
  ).toEqual({});
  expect(log.filter((event) => event.type === "reminder")).toHaveLength(1);
});

test("reconstruction cannot postpone a scheduled deadline when delivery arms later", () => {
  const { stream, create, alarms } = setup();
  stream.append(scheduled());
  const deadline = Date.parse("2030-01-01T00:00:00Z");
  create().armAlarmNoLaterThan(deadline + 60_000);
  expect(alarms).toEqual([deadline, deadline]);
});

test("scheduled work survives the retry breaker; pause holds it and resume rearms", () => {
  const { stream, alarms } = setup();
  for (let i = 0; i < 5; i++) stream.noteSelfWake();
  stream.append(scheduled());
  expect(alarms).toHaveLength(1);
  stream.noteAlarmFired();
  stream.append({ type: "events.iterate.com/stream/paused", payload: { reason: "maintenance" } });
  stream.armScheduledAppends();
  expect(stream.nextScheduledAppendAt()).toBeNull();
  expect(alarms).toHaveLength(1);
  stream.append({ type: "events.iterate.com/stream/resumed" });
  expect(alarms).toHaveLength(2);
});

test("cancellation works while paused; idempotent retries do not resurrect a completed schedule", () => {
  const { stream } = setup();
  const input = { ...scheduled(), idempotencyKey: "request-1" };
  stream.append(input);
  stream.append({ type: "events.iterate.com/stream/paused" });
  stream.append({
    type: "events.iterate.com/stream/append-schedule-cancelled",
    payload: { key: "reminder" },
  });
  stream.append(input);
  expect(stream.coreReducedState.schedules).toEqual({});
});

test.each([
  { key: "__proto__" },
  { when: { at: "tomorrow" } },
  { events: [] },
  { events: [{ type: "x", ephemeral: true }] },
  { events: [{ type: "x", offset: 4 }] },
  { events: [{ type: "x", source: { principal: { actor: "admin" } } }] },
  { events: [{ type: "events.iterate.com/stream/append-scheduled" }] },
  { events: [{ type: "x", payload: { blob: "x".repeat(65_536) } }] },
])("invalid durable definitions are refused before commit: %j", (override) => {
  const input = scheduled();
  expect(() =>
    normalizeControlEvent({ ...input, payload: { ...input.payload, ...override } }),
  ).toThrow();
});

test("schedule capacity rejects the whole batch without committing a partial prefix", () => {
  const { stream } = setup();
  expect(() => stream.append(...Array.from({ length: 101 }, (_, i) => scheduled(`s${i}`)))).toThrow(
    "100 schedules",
  );
  expect(stream.highestDurableOffset()).toBe(0);
  expect(stream.coreReducedState.schedules).toEqual({});
});

test("a failing SQL write rolls back both occurrence events and completion", () => {
  const { stream, storage, create } = setup();
  const [definition] = stream.append(scheduled());
  storage.sql.exec(
    "CREATE TRIGGER reject_audit BEFORE INSERT ON events WHEN json_extract(NEW.body, '$.type') = 'audit' BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
  );
  expect(() =>
    stream.append(
      { type: "reminder" },
      { type: "audit" },
      {
        type: "events.iterate.com/stream/append-schedule-completed",
        payload: { key: "reminder", scheduledAtOffset: definition.offset },
      },
    ),
  ).toThrow("injected failure");
  expect(create().coreReducedState.schedules.reminder.scheduledAtOffset).toBe(definition.offset);
  expect(stream.read().events.filter((event) => event.type === "reminder")).toEqual([]);
});

test("pre-epoch deadlines arm immediately instead of writing a negative platform timestamp", () => {
  const { stream, alarms } = setup();
  const before = Date.now();
  stream.append(scheduled("ancient", "0001-01-01T00:00:00Z"));
  expect(alarms[0]).toBeGreaterThanOrEqual(before);
  expect(alarms[0]).toBeLessThanOrEqual(Date.now());
});

test("a due-work pass arms once for its final obligations, preserving another subsystem's deadline", () => {
  const { stream, alarms } = setup();
  const [a] = stream.append(scheduled("a"));
  const [b] = stream.append(scheduled("b"));
  stream.append(scheduled("later", "2032-01-01T00:00:00Z"));
  stream.noteAlarmFired();
  alarms.length = 0;
  const retryAt = Date.parse("2031-01-01T00:00:00Z");
  stream.deferAlarmWrites(() => {
    for (const row of [a, b]) {
      stream.append({
        type: "events.iterate.com/stream/append-schedule-completed",
        payload: {
          key: row.payload!.key,
          scheduledAtOffset: row.offset,
        },
      });
      stream.armAlarmNoLaterThan(retryAt);
    }
  });
  expect(alarms).toEqual([retryAt]);
  expect(alarms).not.toContain(Date.parse("2030-01-01T00:00:00Z"));
});
