import { describe, expect, it } from "vitest";
import { CORE_STATE_VERSION, parseCoreProcessorCheckpoint } from "./core-processor-contract.ts";

describe("CoreProcessorCheckpoint", () => {
  it("accepts only the current exact checkpoint envelope", () => {
    const current = {
      version: CORE_STATE_VERSION,
      state: { maxOffset: 12, eventCount: 12 },
    };

    expect(parseCoreProcessorCheckpoint(current)).toMatchObject(current);
    expect(() =>
      parseCoreProcessorCheckpoint({ ...current, version: CORE_STATE_VERSION - 1 }),
    ).toThrow("Unsupported core processor checkpoint version");
    expect(() => parseCoreProcessorCheckpoint({ state: current.state })).toThrow(
      "Invalid core processor checkpoint envelope",
    );
    expect(() => parseCoreProcessorCheckpoint({ ...current, legacy: true })).toThrow(
      "Invalid core processor checkpoint envelope",
    );
    expect(() =>
      parseCoreProcessorCheckpoint({
        ...current,
        state: { ...current.state, legacy: true },
      }),
    ).toThrow("Unrecognized key");
  });
});
