import { setTimeout as delay } from "node:timers/promises";

export interface ProductionPcmGenerationMetrics {
  closed: boolean;
  sessionId: string;
}

export interface ProductionPcmConversationMetrics extends ProductionPcmGenerationMetrics {
  awaitingCommitAcknowledgement: boolean;
  awaitingUplinkEndMarker: boolean;
  conversationActive: boolean;
  downlinkQueuedBytes: number;
  interrupted: boolean;
  providerAvailable: boolean;
  providerBufferedBytes: number;
  providerFunctionCallsPending: number;
  providerResponseActive: boolean;
}

export interface ProductionPcmFrameMetrics extends ProductionPcmGenerationMetrics {
  downlinkFrames: number;
  previousSession?: ProductionPcmFrameMetrics | null;
  uplinkFrames: number;
}

export interface ProductionPcmGenerationProgress {
  downlinkFrames: number;
  sessionId: string;
  uplinkFrames: number;
}

export interface ProductionPcmMetricsReader<Metrics extends ProductionPcmGenerationMetrics> {
  pcmMetrics(): Promise<Metrics | null>;
}

export class ProductionPcmGenerationChangedError<
  Metrics extends ProductionPcmGenerationMetrics = ProductionPcmGenerationMetrics,
> extends Error {
  readonly expectedSessionId: string;
  readonly observedMetrics: Metrics | null;
  readonly observedSessionId: string | null;

  constructor(description: string, expectedSessionId: string, observedMetrics: Metrics | null) {
    const observedSessionId = observedMetrics?.sessionId ?? null;
    const boundary =
      observedMetrics === null
        ? "no retained PCM generation"
        : observedMetrics.closed
          ? `closed generation ${observedSessionId}`
          : `replacement generation ${observedSessionId}`;
    super(
      `Lost deployed PCM generation ${expectedSessionId} while waiting for ${description}; ` +
        `pcmMetrics() reported ${boundary}.`,
    );
    this.name = "ProductionPcmGenerationChangedError";
    this.expectedSessionId = expectedSessionId;
    this.observedMetrics = observedMetrics;
    this.observedSessionId = observedSessionId;
  }
}

export class ProductionPcmWaitTimeoutError<
  Metrics extends ProductionPcmGenerationMetrics = ProductionPcmGenerationMetrics,
> extends Error {
  readonly lastObservedMetrics: Metrics | null;

  constructor(description: string, lastObservedMetrics: Metrics | null) {
    super(`Timed out waiting for ${description}.`);
    this.name = "ProductionPcmWaitTimeoutError";
    this.lastObservedMetrics = lastObservedMetrics;
  }
}

/**
 * Describes the quiescent state between Button-B conversations.
 *
 * The device WebSocket is deliberately absent from this predicate. It is
 * infrastructure that remains open for the device's lifetime; only the Grok
 * provider and one conversation's bounded media state are disposable. A
 * closed device lane is therefore never "idle"—it is a transport incident or
 * deployment boundary that must be kept out of call-start measurements.
 */
export function productionPcmConversationIsIdle(
  metrics: ProductionPcmConversationMetrics,
): boolean {
  return (
    !metrics.closed &&
    !metrics.conversationActive &&
    !metrics.providerAvailable &&
    !metrics.providerResponseActive &&
    !metrics.interrupted &&
    !metrics.awaitingCommitAcknowledgement &&
    !metrics.awaitingUplinkEndMarker &&
    metrics.downlinkQueuedBytes === 0 &&
    metrics.providerBufferedBytes === 0 &&
    metrics.providerFunctionCallsPending === 0
  );
}

/**
 * Waits for one continuously idle, open device PCM generation.
 *
 * A single idle observation is insufficient immediately after installing a
 * userspace worker: the old Durable Object can look quiescent just before its
 * socket is replaced. Requiring one session id to remain idle for a bounded
 * settling interval prevents deployment TLS/reconnect work from being charged
 * to the following Button-B call. When the caller already owns a session id,
 * replacement is a causal failure rather than a condition to follow.
 */
export async function waitForProductionPcmConversationIdle<
  Metrics extends ProductionPcmConversationMetrics,
>(options: ProductionPcmConversationIdleWaitOptions<Metrics>): Promise<Metrics> {
  const deadline = performance.now() + options.timeoutMs;
  const minimumStableMs = options.minimumStableMs ?? 1_000;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  let candidateSessionId: string | undefined;
  let candidateSinceMs = 0;
  let lastObservedMetrics: Metrics | null = null;

  while (performance.now() < deadline) {
    const metrics = await options.worker.pcmMetrics();
    lastObservedMetrics = metrics;
    if (
      options.expectedSessionId !== undefined &&
      (metrics === null || metrics.closed || metrics.sessionId !== options.expectedSessionId)
    ) {
      throw new ProductionPcmGenerationChangedError(
        options.description,
        options.expectedSessionId,
        metrics,
      );
    }

    if (metrics !== null && productionPcmConversationIsIdle(metrics)) {
      const observedAtMs = performance.now();
      if (candidateSessionId !== metrics.sessionId) {
        candidateSessionId = metrics.sessionId;
        candidateSinceMs = observedAtMs;
      }
      if (observedAtMs - candidateSinceMs >= minimumStableMs) return metrics;
    } else {
      candidateSessionId = undefined;
      candidateSinceMs = 0;
    }
    await delay(pollIntervalMs);
  }

  throw new ProductionPcmWaitTimeoutError(options.description, lastObservedMetrics);
}

/**
 * Recovers byte-accounting progress for exactly one deployed PCM generation.
 *
 * A reconnect replaces the active worker metrics before a 100 ms proof poll
 * necessarily sees the close. The worker deliberately retains the just-closed
 * report as `previousSession`; that is the causal evidence for the failed
 * interval, while the replacement's counters belong to a new conversation.
 * Looking through only this one bounded retention slot mirrors the worker's
 * contract and prevents a harness-side history or cross-generation sum.
 */
export function productionPcmGenerationProgress(input: {
  baseline: ProductionPcmFrameMetrics;
  observations: readonly (ProductionPcmFrameMetrics | null | undefined)[];
}): ProductionPcmGenerationProgress {
  const sessionId = input.baseline.sessionId;
  let maximumDownlinkFrames = input.baseline.downlinkFrames;
  let maximumUplinkFrames = input.baseline.uplinkFrames;

  for (const observation of input.observations) {
    const matching =
      observation?.sessionId === sessionId
        ? observation
        : observation?.previousSession?.sessionId === sessionId
          ? observation.previousSession
          : undefined;
    if (!matching) continue;
    maximumDownlinkFrames = Math.max(maximumDownlinkFrames, matching.downlinkFrames);
    maximumUplinkFrames = Math.max(maximumUplinkFrames, matching.uplinkFrames);
  }

  return {
    downlinkFrames: maximumDownlinkFrames - input.baseline.downlinkFrames,
    sessionId,
    uplinkFrames: maximumUplinkFrames - input.baseline.uplinkFrames,
  };
}

/**
 * Polls the worker's public diagnostics capability while preserving one PCM
 * generation as a causal unit.
 *
 * The proof deliberately does not follow reconnects. A replacement may be a
 * successful recovery for the product, but frames and counters on opposite
 * sides of that boundary cannot prove a lossless conversation. Failing on the
 * first identity change also preserves the replacement snapshot before proof
 * cleanup can produce yet another session and erase the useful attribution.
 */
export async function waitForProductionPcmMetrics<Metrics extends ProductionPcmGenerationMetrics>(
  options: ProductionPcmWaitOptions<Metrics>,
): Promise<Metrics> {
  const deadline = performance.now() + options.timeoutMs;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  let lastObservedMetrics: Metrics | null = null;

  while (performance.now() < deadline) {
    const metrics = await options.worker.pcmMetrics();
    lastObservedMetrics = metrics;
    if (options.expectedSessionId !== undefined) {
      const expectedGenerationIsUsable =
        metrics !== null &&
        metrics.sessionId === options.expectedSessionId &&
        (options.allowClosedExpectedSession === true || !metrics.closed);
      if (!expectedGenerationIsUsable) {
        throw new ProductionPcmGenerationChangedError(
          options.description,
          options.expectedSessionId,
          metrics,
        );
      }
    }
    if (metrics !== null && options.predicate(metrics)) return metrics;
    await delay(pollIntervalMs);
  }

  throw new ProductionPcmWaitTimeoutError(options.description, lastObservedMetrics);
}

interface ProductionPcmWaitOptions<Metrics extends ProductionPcmGenerationMetrics> {
  allowClosedExpectedSession?: boolean;
  description: string;
  expectedSessionId?: string;
  pollIntervalMs?: number;
  predicate(metrics: Metrics): boolean;
  timeoutMs: number;
  worker: ProductionPcmMetricsReader<Metrics>;
}

interface ProductionPcmConversationIdleWaitOptions<
  Metrics extends ProductionPcmConversationMetrics,
> {
  description: string;
  expectedSessionId?: string;
  minimumStableMs?: number;
  pollIntervalMs?: number;
  timeoutMs: number;
  worker: ProductionPcmMetricsReader<Metrics>;
}
