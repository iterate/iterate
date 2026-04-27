import { describe, expect, test } from "vitest";
import { StreamState } from "./types.ts";

describe("StreamState", () => {
  test("rehydrates older reduced_state rows without a dynamic-worker processor slice", () => {
    const parsed = StreamState.parse({
      projectSlug: "public",
      path: "/legacy",
      eventCount: 2,
      metadata: {},
      processors: {
        "circuit-breaker": {
          paused: false,
          pauseReason: null,
          pausedAt: null,
          availableTokens: 100,
          lastRefillAtMs: null,
        },
        "jsonata-transformer": {
          transformersBySlug: {},
        },
      },
    });

    expect(parsed.processors["circuit-breaker"]).toEqual({
      paused: false,
      pauseReason: null,
      pausedAt: null,
      config: {
        burstCapacity: 500,
        refillRatePerMinute: 500,
      },
      availableTokens: 100,
      lastRefillAtMs: null,
    });
    expect(parsed.processors["dynamic-worker"]).toEqual({
      envVarsByKey: {},
      workersBySlug: {},
    });
  });
});
