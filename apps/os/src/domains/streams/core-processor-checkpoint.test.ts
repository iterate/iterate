import { describe, expect, it } from "vitest";
import {
  CORE_STATE_VERSION,
  CoreProcessorContract,
  parseCoreProcessorCheckpoint,
} from "./core-processor-contract.ts";

describe("CoreProcessorCheckpoint", () => {
  it("accepts only the current exact checkpoint envelope", () => {
    const current = {
      version: CORE_STATE_VERSION,
      state: CoreProcessorContract.stateSchema.parse({ maxOffset: 12, eventCount: 12 }),
    };

    const parsed = parseCoreProcessorCheckpoint(current);
    expect(parsed).toEqual(current);
    expect(parsed.state).toBe(current.state);
    expect(() =>
      parseCoreProcessorCheckpoint({ ...current, version: CORE_STATE_VERSION - 1 }),
    ).toThrow("Unsupported core processor checkpoint version");
    expect(() => parseCoreProcessorCheckpoint({ state: current.state })).toThrow(
      "Invalid core processor checkpoint envelope",
    );
    expect(() => parseCoreProcessorCheckpoint({ ...current, legacy: true })).toThrow(
      "Invalid core processor checkpoint envelope",
    );
    expect(() => parseCoreProcessorCheckpoint({ ...current, state: null })).toThrow(
      "Invalid core processor checkpoint state",
    );
  });
});
