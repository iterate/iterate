import { describe, expect, it } from "vitest";
import {
  assertValidRecurrence,
  barrenWakeAtMs,
  canonicalRecurrence,
  dueSchedules,
  initialTriggerAtMs,
  nextTriggerAtMs,
  nextWakeAtMs,
  SCHEDULER_HEARTBEAT_MS,
} from "./recurrence.ts";
import type { SchedulerProcessorState } from "./scheduler-processor-contract.ts";

const BASE = Date.parse("2026-01-15T12:00:00Z");

function entry(
  overrides: Partial<SchedulerProcessorState["schedules"][string]> = {},
): SchedulerProcessorState["schedules"][string] {
  return {
    action: { kind: "itx-script", script: "async () => {}" },
    definedAtOffset: 1,
    nextTriggerAt: null,
    path: "/scheduler/primary",
    recurrence: { every: 60 },
    runCount: 0,
    setAt: new Date(BASE).toISOString(),
    ...overrides,
  };
}

describe("initialTriggerAtMs", () => {
  it("uses the instant itself for { at }, even in the past", () => {
    const at = "2026-01-15T09:00:00Z";
    expect(initialTriggerAtMs({ at }, BASE)).toBe(Date.parse(at));
  });

  it("anchors { every } on the defining event", () => {
    expect(initialTriggerAtMs({ every: 90 }, BASE)).toBe(BASE + 90_000);
  });

  it("finds the next cron occurrence in UTC by default", () => {
    expect(initialTriggerAtMs({ cron: "0 9 * * *" }, BASE)).toBe(
      Date.parse("2026-01-16T09:00:00Z"),
    );
  });

  it("respects an IANA timezone (base is 7am New York, so 9am NY that same day = 14:00 UTC)", () => {
    expect(initialTriggerAtMs({ cron: "0 9 * * *", timezone: "America/New_York" }, BASE)).toBe(
      Date.parse("2026-01-15T14:00:00Z"),
    );
  });

  it("returns null instead of throwing for an unparseable cron (raw appends must not poison the fold)", () => {
    expect(initialTriggerAtMs({ cron: "not a cron" }, BASE)).toBeNull();
    expect(initialTriggerAtMs({ at: "not a date" }, BASE)).toBeNull();
  });
});

describe("nextTriggerAtMs", () => {
  it("exhausts one-shots", () => {
    expect(nextTriggerAtMs({ at: "2026-01-15T09:00:00Z" }, BASE)).toBeNull();
  });

  it("re-anchors { every } on the request time (missed occurrences coalesce)", () => {
    const requestedAt = BASE + 3 * 3_600_000; // three hours of downtime
    expect(nextTriggerAtMs({ every: 600 }, requestedAt)).toBe(requestedAt + 600_000);
  });

  it("advances cron from the request time", () => {
    expect(nextTriggerAtMs({ cron: "0 9 * * *" }, Date.parse("2026-01-16T09:00:00Z"))).toBe(
      Date.parse("2026-01-17T09:00:00Z"),
    );
  });

  it("slides a nonexistent local time forward across a DST spring-forward", () => {
    // 2026-03-29 Europe/London: clocks jump 01:00 GMT → 02:00 BST, so 01:30
    // local never exists that day. Croner fires at the shifted instant once,
    // then resumes normal local time the next day.
    const recurrence = { cron: "30 1 * * *", timezone: "Europe/London" };
    expect(nextTriggerAtMs(recurrence, Date.parse("2026-03-28T12:00:00Z"))).toBe(
      Date.parse("2026-03-29T01:30:00Z"), // = 02:30 BST, the slid occurrence
    );
    expect(nextTriggerAtMs(recurrence, Date.parse("2026-03-29T12:00:00Z"))).toBe(
      Date.parse("2026-03-30T00:30:00Z"), // = 01:30 BST, back to normal
    );
  });

  it("fires an ambiguous local time exactly once across a DST fall-back", () => {
    // 2026-10-25 Europe/London: clocks fall 02:00 BST → 01:00 GMT, so 01:30
    // local happens twice. Croner fires the first occurrence only.
    const recurrence = { cron: "30 1 * * *", timezone: "Europe/London" };
    expect(nextTriggerAtMs(recurrence, Date.parse("2026-10-24T12:00:00Z"))).toBe(
      Date.parse("2026-10-25T00:30:00Z"), // = 01:30 BST, first pass
    );
    expect(nextTriggerAtMs(recurrence, Date.parse("2026-10-25T12:00:00Z"))).toBe(
      Date.parse("2026-10-26T01:30:00Z"), // = 01:30 GMT the next day, not the repeat
    );
  });
});

describe("dueSchedules", () => {
  it("returns due entries ordered by due time then key, skipping parked and future ones", () => {
    const schedules: SchedulerProcessorState["schedules"] = {
      future: entry({ nextTriggerAt: BASE + 60_000 }),
      "late-b": entry({ nextTriggerAt: BASE - 1_000 }),
      "late-a": entry({ nextTriggerAt: BASE - 1_000 }),
      earliest: entry({ nextTriggerAt: BASE - 60_000 }),
      parked: entry({ nextTriggerAt: null }),
    };
    expect(dueSchedules(schedules, BASE).map(([key]) => key)).toEqual([
      "earliest",
      "late-a",
      "late-b",
    ]);
  });
});

describe("nextWakeAtMs", () => {
  it("deletes the alarm (null) only when the scheduler holds no state at all", () => {
    expect(nextWakeAtMs({ pendingTriggers: {}, schedules: {} }, BASE)).toBeNull();
  });

  it("keeps the heartbeat while anything remains: pending executions or parked schedules", () => {
    const pending = {
      key: "report",
      requestedAt: new Date(BASE).toISOString(),
      runCount: 1,
      scheduledFor: new Date(BASE).toISOString(),
    };
    expect(nextWakeAtMs({ pendingTriggers: { x: pending }, schedules: {} }, BASE)).toBe(
      BASE + SCHEDULER_HEARTBEAT_MS,
    );
    expect(
      nextWakeAtMs(
        { pendingTriggers: {}, schedules: { parked: entry({ nextTriggerAt: null }) } },
        BASE,
      ),
    ).toBe(BASE + SCHEDULER_HEARTBEAT_MS);
  });

  it("wakes for the earliest upcoming trigger", () => {
    const state = {
      pendingTriggers: {},
      schedules: { soon: entry({ nextTriggerAt: BASE + 5_000 }) },
    };
    expect(nextWakeAtMs(state, BASE)).toBe(BASE + 5_000);
  });

  it("clamps due-now entries a second out so a racing wake cannot hot-loop", () => {
    const state = {
      pendingTriggers: {},
      schedules: { overdue: entry({ nextTriggerAt: BASE - 60_000 }) },
    };
    expect(nextWakeAtMs(state, BASE)).toBe(BASE + 1_000);
  });

  it("caps far-future triggers at the heartbeat", () => {
    const state = {
      pendingTriggers: {},
      schedules: { distant: entry({ nextTriggerAt: BASE + 10 * SCHEDULER_HEARTBEAT_MS }) },
    };
    expect(nextWakeAtMs(state, BASE)).toBe(BASE + SCHEDULER_HEARTBEAT_MS);
  });
});

describe("assertValidRecurrence", () => {
  it("accepts valid shapes", () => {
    expect(() => assertValidRecurrence({ at: "2026-01-15T09:00:00Z" })).not.toThrow();
    expect(() => assertValidRecurrence({ every: 1 })).not.toThrow();
    expect(() =>
      assertValidRecurrence({ cron: "*/5 * * * *", timezone: "Europe/London" }),
    ).not.toThrow();
  });

  it("rejects a bad cron expression at set time, not at 3am", () => {
    expect(() => assertValidRecurrence({ cron: "not a cron" })).toThrow();
  });

  it("rejects a bad timezone at set time", () => {
    expect(() => assertValidRecurrence({ cron: "0 9 * * *", timezone: "Mars/Olympus" })).toThrow();
  });

  it("rejects a cron with no future occurrence (it would park silently)", () => {
    expect(() => assertValidRecurrence({ cron: "0 0 30 2 *" })).toThrow(/no future occurrence/);
  });

  it("rejects ambiguous shapes carrying more than one recurrence key", () => {
    expect(() => assertValidRecurrence({ at: "2026-01-15T09:00:00Z", every: 60 } as never)).toThrow(
      /exactly one/,
    );
  });
});

describe("canonicalRecurrence", () => {
  it("lowers { in } sugar to a canonical { at } so the log has one spelling", () => {
    expect(canonicalRecurrence({ in: 120 }, BASE)).toEqual({
      at: new Date(BASE + 120_000).toISOString(),
    });
  });

  it("passes canonical shapes through untouched", () => {
    expect(canonicalRecurrence({ every: 60 }, BASE)).toEqual({ every: 60 });
    expect(canonicalRecurrence({ cron: "0 9 * * *" }, BASE)).toEqual({ cron: "0 9 * * *" });
  });

  it("rejects non-positive and fractional { in } values", () => {
    for (const bad of [0, -5, 1.5, Number.NaN]) {
      expect(() => canonicalRecurrence({ in: bad }, BASE)).toThrow(/positive integer/);
    }
  });
});

describe("barrenWakeAtMs", () => {
  it("doubles from the minimum delay and caps at the heartbeat", () => {
    expect(barrenWakeAtMs(BASE, 1)).toBe(BASE + 2_000);
    expect(barrenWakeAtMs(BASE, 3)).toBe(BASE + 8_000);
    expect(barrenWakeAtMs(BASE, 30)).toBe(BASE + SCHEDULER_HEARTBEAT_MS);
  });
});
