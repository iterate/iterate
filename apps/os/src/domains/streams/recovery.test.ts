import { describe, expect, it } from "vitest";
import {
  assertValidStreamRecoveryLog,
  STREAM_RECOVERY_FORMAT,
  STREAM_RECOVERY_VERSION,
  type StreamRecoveryRestoreInput,
} from "./recovery.ts";

const coordinate = { projectId: "prj_iterate", path: "/secrets/github" };

function recovery(): StreamRecoveryRestoreInput {
  return {
    format: STREAM_RECOVERY_FORMAT,
    version: STREAM_RECOVERY_VERSION,
    stream: coordinate,
    highestAssignedOffset: 9,
    events: [
      {
        type: "events.iterate.com/stream/created",
        payload: coordinate,
        createdAt: "2026-07-14T00:00:00.000Z",
        offset: 1,
        path: coordinate.path,
      },
      {
        type: "events.iterate.com/secret/updated",
        payload: { encryptedMaterial: "opaque" },
        createdAt: "2026-07-14T00:00:01.000Z",
        offset: 7,
        path: coordinate.path,
      },
    ],
  };
}

describe("assertValidStreamRecoveryLog", () => {
  it("accepts an exact coordinate and offset gaps", () => {
    expect(() => assertValidStreamRecoveryLog(recovery(), coordinate)).not.toThrow();
  });

  it("rejects a coordinate change", () => {
    expect(() =>
      assertValidStreamRecoveryLog(recovery(), { ...coordinate, projectId: "prj_other" }),
    ).toThrow(/coordinate mismatch/);
  });

  it("rejects reordered offsets", () => {
    const input = recovery();
    input.events[1] = { ...input.events[1]!, offset: 1 };
    expect(() => assertValidStreamRecoveryLog(input, coordinate)).toThrow(/strictly increasing/);
  });

  it("rejects an allocator floor below a surviving event", () => {
    const input = recovery();
    input.highestAssignedOffset = 6;
    expect(() => assertValidStreamRecoveryLog(input, coordinate)).toThrow(/highestAssignedOffset/);
  });

  it("rejects duplicate idempotency keys before storage replacement", () => {
    const input = recovery();
    input.events[0] = { ...input.events[0]!, idempotencyKey: "same" };
    input.events[1] = { ...input.events[1]!, idempotencyKey: "same" };
    expect(() => assertValidStreamRecoveryLog(input, coordinate)).toThrow(/duplicate/);
  });
});
