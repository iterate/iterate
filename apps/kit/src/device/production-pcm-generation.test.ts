import { describe, expect, test } from "vitest";
import {
  productionPcmConversationIsIdle,
  productionPcmGenerationProgress,
  ProductionPcmGenerationChangedError,
  waitForProductionPcmConversationIdle,
  waitForProductionPcmMetrics,
} from "./production-pcm-generation.ts";

interface TestMetrics {
  closed: boolean;
  sessionId: string;
  uplinkFrames: number;
}

describe("production PCM generation wait", () => {
  test("treats a warm device lane with no provider as idle", async () => {
    /*
     * Button B owns the provider conversation, not the device `/pcm` lane.
     * Waiting for `closed` here reintroduced the old cold-connect lifecycle
     * into every latency proof: the test could only proceed after a coincident
     * deploy or network reconnect. The idle contract therefore requires the
     * same socket to remain open while provider and media work are quiescent.
     */
    const metrics = {
      awaitingCommitAcknowledgement: false,
      awaitingUplinkEndMarker: false,
      closed: false,
      conversationActive: false,
      downlinkQueuedBytes: 0,
      interrupted: false,
      providerAvailable: false,
      providerBufferedBytes: 0,
      providerFunctionCallsPending: 0,
      providerResponseActive: false,
      sessionId: "warm-device-lane",
    };
    let reads = 0;

    expect(productionPcmConversationIsIdle(metrics)).toBe(true);
    await expect(
      waitForProductionPcmConversationIdle({
        description: "the provider conversation to retire",
        minimumStableMs: 0,
        pollIntervalMs: 0,
        timeoutMs: 1_000,
        worker: {
          async pcmMetrics() {
            reads += 1;
            return metrics;
          },
        },
      }),
    ).resolves.toBe(metrics);
    expect(reads).toBe(1);
  });

  test("rejects a replacement while settling the expected warm lane", async () => {
    /*
     * A worker install can replace the socket between the first idle poll and
     * Button B start. Accepting the replacement makes its TLS/reconnect delay
     * look like call setup. Once the harness names a generation, any identity
     * change must fail immediately and retain both session ids for diagnosis.
     */
    const idle = {
      awaitingCommitAcknowledgement: false,
      awaitingUplinkEndMarker: false,
      closed: false,
      conversationActive: false,
      downlinkQueuedBytes: 0,
      interrupted: false,
      providerAvailable: false,
      providerBufferedBytes: 0,
      providerFunctionCallsPending: 0,
      providerResponseActive: false,
    };
    const observations = [
      { ...idle, sessionId: "expected" },
      { ...idle, sessionId: "replacement" },
    ];
    let index = 0;

    const failure = await waitForProductionPcmConversationIdle({
      description: "the warm device lane to remain stable",
      expectedSessionId: "expected",
      minimumStableMs: 1_000,
      pollIntervalMs: 0,
      timeoutMs: 1_000,
      worker: {
        async pcmMetrics() {
          return observations[Math.min(index++, observations.length - 1)];
        },
      },
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProductionPcmGenerationChangedError);
    expect(failure).toMatchObject({
      expectedSessionId: "expected",
      observedSessionId: "replacement",
    });
  });

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
