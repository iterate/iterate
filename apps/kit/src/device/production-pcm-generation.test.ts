import { describe, expect, test } from "vitest";
import {
  ProductionPcmGenerationChangedError,
  waitForProductionPcmMetrics,
} from "./production-pcm-generation.ts";

interface TestMetrics {
  closed: boolean;
  sessionId: string;
  uplinkFrames: number;
}

describe("production PCM generation wait", () => {
  test("fails at the first replacement instead of timing out against another session", async () => {
    /*
     * A healthy Stick can reconnect quickly enough that the worker's public
     * `pcmMetrics()` capability already reports a replacement by the next
     * 100 ms poll. Continuing to compare that replacement's reset counters to
     * the baseline creates a misleading ten-second timeout and cleanup then
     * overwrites the only useful closed-session report. The production proof
     * therefore treats identity as part of every post-connect assertion.
     */
    const observations: TestMetrics[] = [
      { closed: false, sessionId: "expected", uplinkFrames: 8 },
      { closed: false, sessionId: "replacement", uplinkFrames: 0 },
    ];
    let index = 0;
    const worker = {
      async pcmMetrics() {
        return observations[Math.min(index++, observations.length - 1)];
      },
    };

    const failure = await waitForProductionPcmMetrics({
      description: "the remote PTT release",
      expectedSessionId: "expected",
      pollIntervalMs: 0,
      predicate: (metrics) => metrics.uplinkFrames > 100,
      timeoutMs: 1_000,
      worker,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProductionPcmGenerationChangedError);
    expect(failure).toMatchObject({
      expectedSessionId: "expected",
      observedMetrics: observations[1],
      observedSessionId: "replacement",
    });
    expect(index).toBe(2);
  });
});
