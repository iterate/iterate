import { describe, expect, it } from "vitest";
import { CoreCheckpointSchedule } from "./stream-core-checkpoint.ts";

describe("CoreCheckpointSchedule", () => {
  it("debounces one woken event after loading a current checkpoint", () => {
    const schedule = new CoreCheckpointSchedule({ nowMs: 10_000 });

    schedule.restoreLag({ eventCount: 0, nowMs: 20_000 });

    expect(schedule.record({ eventCount: 1, nowMs: 20_000 })).toBe(false);
    expect(schedule.needsFlush).toBe(true);
  });

  it("carries checkpoint lag across incarnations until the event bound", () => {
    const schedule = new CoreCheckpointSchedule({ nowMs: 0 });

    schedule.restoreLag({ eventCount: 63, nowMs: 10_000 });

    expect(schedule.record({ eventCount: 1, nowMs: 10_000 })).toBe(true);
  });

  it("writes immediately when restored offset lag already reached the bound", () => {
    const schedule = new CoreCheckpointSchedule({ nowMs: 0 });

    expect(schedule.restoreLag({ eventCount: 64, nowMs: 10_000 })).toBe(true);
  });

  it("keeps the first write immediate for a newborn or rebuilt checkpoint", () => {
    const schedule = new CoreCheckpointSchedule({ nowMs: 0 });

    expect(schedule.record({ eventCount: 1, nowMs: 10_000 })).toBe(true);
  });

  it("keeps the elapsed-time bound without assuming the clock advances synchronously", () => {
    const schedule = new CoreCheckpointSchedule({ nowMs: 5_000 });

    expect(schedule.record({ eventCount: 1, nowMs: 5_000 })).toBe(false);
    expect(schedule.record({ eventCount: 1, nowMs: 5_999 })).toBe(false);
    expect(schedule.record({ eventCount: 1, nowMs: 6_000 })).toBe(true);

    schedule.didWrite(6_000);
    expect(schedule.needsFlush).toBe(false);
    expect(schedule.record({ eventCount: 1, nowMs: 6_000 })).toBe(false);
  });
});
