import { setTimeout as delay } from "node:timers/promises";

export interface ProductionPcmGenerationMetrics {
  closed: boolean;
  sessionId: string;
}

export interface ProductionPcmMetricsReader<Metrics extends ProductionPcmGenerationMetrics> {
  pcmMetrics(): Promise<Metrics | null>;
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
