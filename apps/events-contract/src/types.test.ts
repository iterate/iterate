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
          recentEventTimestamps: [],
        },
        "jsonata-transformer": {
          transformersBySlug: {},
        },
      },
    });

    expect(parsed.processors["dynamic-worker"]).toEqual({
      workersBySlug: {},
    });
  });
});
