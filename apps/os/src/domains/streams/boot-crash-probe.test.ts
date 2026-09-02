// Scenario replays for the boot-crash probe. The incident that motivates the
// numbers: a poison 7MB settlement event OOMed the stream DO on every fold
// attempt, and Cloudflare's alarm retry re-booted it every ~5s for hours
// (tasks/bound-script-settlements.md). The probe must trip on that signature
// while never tripping healthy streams that merely wake often.
import { describe, expect, it } from "vitest";

import {
  BOOT_CRASH_QUARANTINE_THRESHOLD,
  clearProbe,
  isQuarantined,
  RAPID_REBOOT_MS,
  recordBootAttempt,
  type BootCrashProbeRecord,
} from "./boot-crash-probe.ts";

const V1 = "worker-v1";
const V2 = "worker-v2";
const T0 = Date.parse("2026-09-02T11:37:00Z");

/** Drive N boots at a fixed cadence, persisting each returned record like the
 * DO would, and hand back the final decision. */
function bootLoop(input: {
  boots: number;
  cadenceMs: number;
  record?: BootCrashProbeRecord;
  version?: string;
}) {
  let record = input.record;
  let decision = undefined as ReturnType<typeof recordBootAttempt> | undefined;
  for (let boot = 0; boot < input.boots; boot++) {
    decision = recordBootAttempt({
      record,
      nowMs: T0 + boot * input.cadenceMs,
      version: input.version || V1,
    });
    record = decision.record;
  }
  return decision!;
}

describe("recordBootAttempt", () => {
  it("trips quarantine on the incident signature — boots every ~5s", () => {
    const decision = bootLoop({ boots: BOOT_CRASH_QUARANTINE_THRESHOLD, cadenceMs: 5_500 });
    expect(decision).toMatchObject({
      action: "quarantine",
      record: { rapidBoots: 5, quarantinedAtMs: expect.any(Number) },
    });
    // Under half a minute of looping — hours of prod wake-loop, never again.
    expect(decision.record.quarantinedAtMs! - T0).toBeLessThan(30_000);
  });

  it("never trips on spaced wakes — a stream woken per event resets each boot", () => {
    const decision = bootLoop({ boots: 50, cadenceMs: RAPID_REBOOT_MS });
    expect(decision).toMatchObject({ action: "proceed", record: { rapidBoots: 1 } });
  });

  it("a clean signal mid-run resets the count — busy streams that finish their folds stay up", () => {
    // Three rapid boots, then the incarnation completes a fold pass...
    let record = bootLoop({ boots: 3, cadenceMs: 5_000 }).record;
    expect(record.rapidBoots).toBe(3);
    record = clearProbe({ nowMs: T0 + 16_000, version: V1 });
    // ...so the next rapid burst starts counting from scratch.
    const decision = recordBootAttempt({ record, nowMs: T0 + 20_000, version: V1 });
    expect(decision).toMatchObject({ action: "proceed", record: { rapidBoots: 1 } });
  });

  it("stays quarantined across spaced boots — dropped alarms slow the wakes, and that slowdown is not recovery", () => {
    const tripped = bootLoop({ boots: 5, cadenceMs: 5_000 }).record;
    const laterBoot = recordBootAttempt({
      record: tripped,
      nowMs: T0 + 6 * 60 * 60_000,
      version: V1,
    });
    expect(laterBoot.action).toBe("quarantine");
    expect(laterBoot.record.quarantinedAtMs).toBe(tripped.quarantinedAtMs);
  });

  it("a deploy unparks — new code may have devalued the poison", () => {
    const tripped = bootLoop({ boots: 5, cadenceMs: 5_000 }).record;
    const decision = recordBootAttempt({ record: tripped, nowMs: T0 + 60_000, version: V2 });
    expect(decision).toMatchObject({
      action: "proceed",
      record: { rapidBoots: 1, version: V2 },
    });
    expect(decision.record.quarantinedAtMs).toBeUndefined();
  });

  it("re-trips after an unpark if the loop resumes — bounded retries, not a loop", () => {
    const tripped = bootLoop({ boots: 5, cadenceMs: 5_000 }).record;
    expect(isQuarantined({ record: tripped, version: V1 })).toBe(true);
    // Admin unpark: clearProbe REPLACES the record — clearing is the reset.
    const cleared = clearProbe({ nowMs: T0 + 60_000, version: V1 });
    expect(isQuarantined({ record: cleared, version: V1 })).toBe(false);
    // ...but the poison is still there and the loop resumes: parks again.
    const decision = bootLoop({
      boots: BOOT_CRASH_QUARANTINE_THRESHOLD,
      cadenceMs: 5_000,
      record: cleared,
    });
    expect(decision.action).toBe("quarantine");
  });

  it("first boot ever proceeds", () => {
    expect(recordBootAttempt({ record: undefined, nowMs: T0, version: V1 })).toMatchObject({
      action: "proceed",
      record: { rapidBoots: 1, lastBootAtMs: T0, version: V1 },
    });
  });
});

describe("isQuarantined", () => {
  it("reads parked state without writing, and ignores stale-version records", () => {
    const tripped = bootLoop({ boots: 5, cadenceMs: 5_000 }).record;
    expect(isQuarantined({ record: tripped, version: V1 })).toBe(true);
    // A deploy happened but the stream has not booted yet: not quarantined —
    // the next boot's version reset will unpark it.
    expect(isQuarantined({ record: tripped, version: V2 })).toBe(false);
    expect(isQuarantined({ record: undefined, version: V1 })).toBe(false);
  });
});
