import { expect, test, vi } from "vitest";
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
  const deletes: number[] = [];
  const storage: DurableObjectStorageSlice = {
    ...base,
    setAlarm: async (at) => {
      alarms.push(Number(at));
    },
    deleteAlarm: async () => {
      deletes.push(1);
    },
  };
  const create = () => new Stream({ storage, path: "/", projectId: "prj_schedule", onCommit() {} });
  return { stream: create(), create, alarms, deletes, storage };
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

test("delivery deadlines can be replaced and withdrawn without retaining a stale native alarm", () => {
  const { stream, alarms, deletes } = setup();
  const first = Date.now() + 1_000;
  const later = first + 60_000;
  stream.alarms.request("delivery:one", first);
  expect(alarms).toHaveLength(1);
  stream.alarms.fired();
  stream.alarms.replace("delivery:one", later);
  expect(alarms.at(-1)).toBe(later);
  stream.alarms.clear("delivery:one");
  expect(deletes).toHaveLength(1);
});

test("reconstruction cannot postpone a scheduled deadline when delivery arms later", () => {
  const { stream, create, alarms } = setup();
  stream.append(scheduled());
  const deadline = Date.parse("2030-01-01T00:00:00Z");
  create().alarms.request("delivery", deadline + 60_000);
  expect(alarms).toEqual([deadline, deadline]);
});

test("scheduled work survives an alarm pass; pause holds it and resume rearms", () => {
  const { stream, alarms } = setup();
  stream.append(scheduled());
  expect(alarms).toHaveLength(1);
  stream.alarms.fired();
  stream.append({ type: "events.iterate.com/stream/paused", payload: { reason: "maintenance" } });
  stream.alarms.reconcile();
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
  stream.alarms.fired();
  alarms.length = 0;
  const retryAt = Date.parse("2031-01-01T00:00:00Z");
  stream.alarms.batch(() => {
    for (const row of [a, b]) {
      stream.append({
        type: "events.iterate.com/stream/append-schedule-completed",
        payload: {
          key: row.payload!.key,
          scheduledAtOffset: row.offset,
        },
      });
      stream.alarms.request("delivery", retryAt);
    }
  });
  expect(alarms).toEqual([retryAt]);
  expect(alarms).not.toContain(Date.parse("2030-01-01T00:00:00Z"));
});

test.each([
  "paused",
  "resumed",
  "created",
  "woken",
  "self-wake-halted",
  "subscription-delivery-halted",
  "subscription-delivery-resumed",
])("runtime control %s cannot be scheduled", (type) => {
  const input = scheduled();
  expect(() =>
    normalizeControlEvent({
      ...input,
      payload: { ...input.payload, events: [{ type: `events.iterate.com/stream/${type}` }] },
    }),
  ).toThrow();
});

test("aggregate definition size is bounded before the batch commits", () => {
  const { stream } = setup();
  const definitions = Array.from({ length: 17 }, (_, i) =>
    normalizeControlEvent({
      type: "events.iterate.com/stream/append-scheduled",
      payload: {
        key: `large${i}`,
        when: { at: "2035-01-01T00:00:00Z" },
        events: [{ type: "large", payload: { body: "x".repeat(63_000) } }],
      },
    }),
  );
  expect(() => stream.append(...definitions)).toThrow("1,048,576 serialized characters");
  expect(stream.coreReducedState.schedules).toEqual({});
  expect(stream.highestDurableOffset()).toBe(0);
});

test("a nearly full definition budget still permits bounded terminal failure diagnostics", () => {
  const { stream } = setup();
  const definitions = stream.append(
    ...Array.from({ length: 16 }, (_, i) =>
      normalizeControlEvent({
        type: "events.iterate.com/stream/append-scheduled",
        payload: {
          key: `large${i}`,
          when: { at: "2035-01-01T00:00:00Z" },
          events: [{ type: "large", payload: { body: "x".repeat(64_900) } }],
        },
      }),
    ),
  );
  stream.append(
    ...definitions.map((definition) => ({
      type: "events.iterate.com/stream/append-schedule-failed",
      payload: {
        key: definition.payload!.key,
        scheduledAtOffset: definition.offset,
        error: "e".repeat(2000),
      },
    })),
  );
  expect(Object.values(stream.coreReducedState.schedules).every((row) => row.failure)).toBe(true);
});

test("relative deadlines resolve once from the committed definition, including retries and replay", () => {
  const { stream, create } = setup();
  const input = normalizeControlEvent({
    type: "events.iterate.com/stream/append-scheduled",
    idempotencyKey: "relative-request",
    payload: { key: ["facet-a", "deadline"], when: { afterMs: 30_000 }, events: [{ type: "due" }] },
  });
  const [definition] = stream.append(input);
  const key = JSON.stringify(["facet-a", "deadline"]);
  const expected = new Date(Date.parse(definition.createdAt) + 30_000).toISOString();
  expect(stream.coreReducedState.schedules[key].nextAt).toBe(expected);
  expect(stream.append(input)[0].offset).toBe(definition.offset);
  expect(create().coreReducedState.schedules[key].nextAt).toBe(expected);
  expect(
    reduceCoreEventBatch(stream.read().events, CoreContract.initialState(), (error) => {
      throw error;
    }).schedules[key].nextAt,
  ).toBe(expected);
});

test("interval completion coalesces missed ticks, retains cadence and ignores duplicate occurrences", () => {
  const input = {
    type: "events.iterate.com/stream/append-scheduled",
    payload: { key: "tick", when: { everyMs: 1000 }, events: [{ type: "tick" }] },
    offset: 1,
    path: "/",
    createdAt: "2030-01-01T00:00:00.000Z",
  };
  let state = reduceCoreEventBatch([input], CoreContract.initialState(), (error) => {
    throw error;
  });
  expect(state.schedules.tick.nextAt).toBe("2030-01-01T00:00:01.000Z");
  const completed = {
    type: "events.iterate.com/stream/append-schedule-completed",
    payload: { key: "tick", scheduledAtOffset: 1, at: state.schedules.tick.nextAt },
    offset: 3,
    path: "/",
    createdAt: "2030-01-01T01:00:00.500Z",
  };
  state = reduceCoreEventBatch([completed], state, (error) => {
    throw error;
  });
  expect(state.schedules.tick.nextAt).toBe("2030-01-01T01:00:01.000Z");
  const repeated = reduceCoreEventBatch([{ ...completed, offset: 4 }], state, (error) => {
    throw error;
  });
  expect(repeated.schedules).toEqual(state.schedules);
});

test.each([
  { afterMs: -1 },
  { afterMs: 0.5 },
  { afterMs: Number.MAX_SAFE_INTEGER },
  { everyMs: 0 },
  { everyMs: 999 },
  { at: "2030-01-01T00:00:00Z", afterMs: 1 },
])("invalid relative/interval deadlines are refused: %j", (when) => {
  expect(() =>
    normalizeControlEvent({
      type: "events.iterate.com/stream/append-scheduled",
      payload: { key: "invalid", when, events: [{ type: "due" }] },
    }),
  ).toThrow();
});

test("replacing an interval anchors its new cadence and ignores the old completion and cancellation", () => {
  vi.useFakeTimers({ now: Date.parse("2030-01-01T00:00:00Z"), toFake: ["Date"] });
  try {
    const { stream, create } = setup();
    const [old] = stream.append(
      normalizeControlEvent({
        type: "events.iterate.com/stream/append-scheduled",
        payload: { key: "tick", when: { everyMs: 1000 }, events: [{ type: "old/tick" }] },
      }),
    );
    const oldAt = stream.coreReducedState.schedules.tick.nextAt;
    vi.setSystemTime(Date.now() + 750);
    const [replacement] = stream.append(
      normalizeControlEvent({
        type: "events.iterate.com/stream/append-scheduled",
        payload: { key: "tick", when: { everyMs: 5000 }, events: [{ type: "new/tick" }] },
      }),
    );
    stream.append(
      {
        type: "events.iterate.com/stream/append-schedule-completed",
        payload: { key: "tick", scheduledAtOffset: old.offset, at: oldAt },
      },
      {
        type: "events.iterate.com/stream/append-schedule-cancelled",
        payload: { key: "tick", ifScheduledAtOffset: old.offset },
      },
    );
    const expected = {
      scheduledAtOffset: replacement.offset,
      nextAt: new Date(Date.parse(replacement.createdAt) + 5000).toISOString(),
      when: { everyMs: 5000 },
      events: [{ type: "new/tick" }],
    };
    expect(create().coreReducedState.schedules.tick).toMatchObject(expected);
    expect(
      reduceCoreEventBatch(stream.read().events, CoreContract.initialState(), (error) => {
        throw error;
      }).schedules.tick,
    ).toMatchObject(expected);
  } finally {
    vi.useRealTimers();
  }
});

test("a batch can replace a full schedule set without transient capacity failures", () => {
  const { stream } = setup();
  stream.append(...Array.from({ length: 100 }, (_, i) => scheduled(`old${i}`)));
  stream.append(scheduled("new"), {
    type: "events.iterate.com/stream/append-schedule-cancelled",
    payload: { key: "old0" },
  });
  expect(Object.keys(stream.coreReducedState.schedules)).toHaveLength(100);
  expect(stream.coreReducedState.schedules.old0).toBeUndefined();
  expect(stream.coreReducedState.schedules.new).toBeDefined();
});
