import { expect, test } from "vitest";
import { normalizeControlEvent } from "./core-processor.ts";
import { RETIRED_EVENT_TYPES } from "./retired-event-types.ts";

test.for([...RETIRED_EVENT_TYPES].map(([old, renamed]) => ({ old, renamed })))(
  "a retired core type is refused at the append boundary with its new name: $old",
  ({ old, renamed }) => {
    expect(() => normalizeControlEvent({ type: old, payload: {} }, "/")).toThrow(
      `${old} was renamed to ${renamed}`,
    );
  },
);

test("a retired type inside a schedule is refused when the schedule is set", () => {
  expect(() =>
    normalizeControlEvent(
      {
        type: "events.iterate.com/itx/schedule-set",
        payload: {
          key: "nightly",
          when: { afterMs: 1000 },
          events: [{ type: "events.iterate.com/stream/paused" }],
        },
      },
      "/",
    ),
  ).toThrow("events.iterate.com/stream/paused was renamed to events.iterate.com/itx/paused");
});

test.for([
  "events.iterate.com/stream/trace/alarm",
  "events.iterate.com/live-state/changed",
  "events.iterate.com/rpc-stub/attached",
])("a retired ephemeral type still passes the append boundary: %s", (type) => {
  const event = { type, ephemeral: true as const, payload: {} };
  expect(normalizeControlEvent(event, "/")).toBe(event);
});

test("every retired type maps to a type the core still reads, never to another retired one", () => {
  for (const [old, renamed] of RETIRED_EVENT_TYPES) {
    expect({ old, renamed: renamed.startsWith("events.iterate.com/itx/") }).toEqual({
      old,
      renamed: true,
    });
    expect(RETIRED_EVENT_TYPES.has(renamed)).toBe(false);
  }
});
