import { describe, expect, test } from "vitest";
import { StreamState } from "@iterate-com/shared/streams/types";
import { StreamNavigationState } from "./stream-navigation-state.ts";

describe("StreamNavigationState", () => {
  test("ignores processor state that is irrelevant to stream navigation", () => {
    const state = {
      namespace: "project-id",
      path: "/",
      eventCount: 42,
      childPaths: ["/agents", "/repos"],
      metadata: {},
      processors: {
        "circuit-breaker": {
          config: {
            maxEventsPerSecond: null,
          },
          paused: false,
          pausedAt: null,
          reason: null,
        },
        "external-subscriber": {
          subscribersBySlug: {
            "project-lifecycle:prj_123": {
              slug: "project-lifecycle:prj_123",
              type: "callable",
              callable: {
                type: "fetch",
                via: {
                  type: "legacy-do-binding",
                  bindingName: "PROJECT",
                },
              },
            },
          },
        },
      },
    };

    // Captured real-world state: StreamState rejects it (processors mismatch),
    // which is the bug StreamNavigationState exists to sidestep.
    expect(StreamState.safeParse(state).success).toBe(false);
    expect(StreamNavigationState.parse(state)).toEqual({
      namespace: "project-id",
      path: "/",
      eventCount: 42,
      childPaths: ["/agents", "/repos"],
      metadata: {},
    });
  });
});
