import { describe, expect, test } from "vitest";
import {
  productionPcmGenerationProgress,
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

  test("attributes progress to the failed generation after a fast replacement", () => {
    /*
     * The Stick deliberately reconnects after discarding stale microphone
     * history. By the time the proof reads metrics, the active counters may
     * belong to the replacement while the worker retains the failed session
     * under `previousSession`. Mixing those generations would either erase
     * real byte progress or make the replacement look like part of the failed
     * conversation. Failure attribution must recover only the exact baseline
     * generation and preserve its cumulative frame delta.
     */
    const baseline = {
      closed: false,
      downlinkFrames: 3,
      sessionId: "expected",
      uplinkFrames: 7,
    };
    const replacement = {
      closed: false,
      downlinkFrames: 0,
      previousSession: {
        closed: true,
        downlinkFrames: 5,
        sessionId: "expected",
        uplinkFrames: 161,
      },
      sessionId: "replacement",
      uplinkFrames: 90,
    };

    expect(
      productionPcmGenerationProgress({
        baseline,
        observations: [
          {
            closed: false,
            downlinkFrames: 4,
            sessionId: "expected",
            uplinkFrames: 20,
          },
          replacement,
        ],
      }),
    ).toEqual({
      downlinkFrames: 2,
      sessionId: "expected",
      uplinkFrames: 154,
    });
  });
});
