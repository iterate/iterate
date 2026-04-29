import { describe, expect, test } from "vitest";
import { StreamState } from "./types.ts";

describe("StreamState", () => {
  test("requires every current stream state field and processor slice", () => {
    expect(() =>
      StreamState.parse({
        projectSlug: "public",
        path: "/missing-required-processor-slices",
        eventCount: 2,
        metadata: {},
        processors: {
          "circuit-breaker": {
            paused: false,
            pauseReason: null,
            pausedAt: null,
            config: {
              burstCapacity: 500,
              refillRatePerMinute: 500,
            },
            availableTokens: 100,
            lastRefillAtMs: null,
          },
        },
      }),
    ).toThrow();

    expect(
      StreamState.parse({
        projectSlug: "public",
        path: "/current",
        eventCount: 2,
        childPaths: [],
        metadata: {},
        processors: {
          "circuit-breaker": {
            paused: false,
            pauseReason: null,
            pausedAt: null,
            config: {
              burstCapacity: 500,
              refillRatePerMinute: 500,
            },
            availableTokens: 100,
            lastRefillAtMs: null,
          },
          "external-subscriber": {
            subscribersBySlug: {},
          },
        },
      }),
    ).toMatchObject({
      path: "/current",
      processors: {
        "external-subscriber": {
          subscribersBySlug: {},
        },
      },
    });
  });
});
