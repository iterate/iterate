import { describe, expect, test } from "vitest";
import { toStreamState } from "./stream-runtime.ts";

describe("toStreamState", () => {
  test("projects real core state onto the StreamState contract, dropping processor internals", () => {
    // Shaped like a real root stream's runtimeState(): non-empty
    // subscriptions, paused flags, maxOffset — none of it part of the public
    // contract. A past version fabricated a processors payload from this that
    // the schema rejected at runtime; the parse inside toStreamState is what
    // keeps the projection and the contract from drifting again.
    const state = toStreamState({
      coreProcessorState: {
        namespace: "prj_123",
        path: "/",
        eventCount: 42,
        maxOffset: 42,
        childPaths: ["/agents", "/repos"],
        metadata: { title: "root" },
        paused: false,
        pauseReason: null,
        processorsBySlug: {},
        subscriptionsByKey: {
          "project-lifecycle:prj_123": { latestConfiguredEvent: { offset: 7 } },
        },
      },
    } as never);

    expect(state).toEqual({
      namespace: "prj_123",
      path: "/",
      eventCount: 42,
      childPaths: ["/agents", "/repos"],
      metadata: { title: "root" },
    });
  });
});
