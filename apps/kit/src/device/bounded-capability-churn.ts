export interface BoundedCapabilityChurnSummary {
  completedCycles: number;
  elapsedMs: number;
  failedCycles: number;
  maximumCycleLatencyMs: number;
  requestedCyclesPerSecond: number;
  scheduledCycles: number;
  schemaVersion: 1;
  skippedBusyCycles: number;
  startedCycles: number;
}

export type BoundedCapabilityChurnAssessment =
  | {
      kind: "healthy";
    }
  | {
      completionFraction: number;
      kind: "failure";
      reason: string;
    };

interface BoundedCapabilityChurnOptions {
  cyclesPerSecond: number;
  monotonicNow?: () => number;
  onFailure?: (error: Error) => void;
  operation(): PromiseLike<void> | void;
  operationTimeoutMs: number;
}

/**
 * Applies periodic control-plane work without creating a second hidden queue.
 *
 * The physical purpose of this helper is to make Cap'n Web, TLS, Wi-Fi, and
 * device control serialization compete with PCM while proving that the audio
 * lane remains continuous. A normal interval callback is unsafe for that job:
 * promises launched on every tick can accumulate indefinitely when the device
 * slows down, turning “load” into an ever-staler request backlog.
 *
 * This runner admits at most one operation. A tick arriving while it is busy
 * is counted and discarded, and one stuck operation is bounded by a timeout.
 * The transport session—not this scheduling helper—owns cancellation of the
 * underlying RPC after timeout. This distinction is intentional: JavaScript
 * promises are not cancellable, but the harness still retains only one such
 * operation and tears its socket down at run completion.
 */
export class BoundedCapabilityChurn {
  readonly #cyclesPerSecond: number;
  readonly #intervalMs: number;
  readonly #monotonicNow: () => number;
  readonly #onFailure?: (error: Error) => void;
  readonly #operation: () => PromiseLike<void> | void;
  readonly #operationTimeoutMs: number;
  #completedCycles = 0;
  #failedCycles = 0;
  #inFlight: Promise<void> | undefined;
  #maximumCycleLatencyMs = 0;
  #scheduledCycles = 0;
  #skippedBusyCycles = 0;
  #startedAtMs: number | undefined;
  #startedCycles = 0;
  #stopPromise: Promise<BoundedCapabilityChurnSummary> | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: BoundedCapabilityChurnOptions) {
    if (
      !Number.isSafeInteger(options.cyclesPerSecond) ||
      options.cyclesPerSecond < 1 ||
      options.cyclesPerSecond > 100
    ) {
      throw new TypeError("Capability churn must run from 1 through 100 cycles per second.");
    }
    if (!Number.isSafeInteger(options.operationTimeoutMs) || options.operationTimeoutMs < 1) {
      throw new TypeError("Capability churn operation timeout must be a positive integer.");
    }
    this.#cyclesPerSecond = options.cyclesPerSecond;
    this.#intervalMs = 1_000 / options.cyclesPerSecond;
    this.#monotonicNow = options.monotonicNow ?? performance.now.bind(performance);
    this.#onFailure = options.onFailure;
    this.#operation = options.operation;
    this.#operationTimeoutMs = options.operationTimeoutMs;
  }

  start() {
    if (this.#startedAtMs !== undefined) {
      throw new Error("Capability churn has already started.");
    }
    this.#startedAtMs = this.#monotonicNow();
    this.#tick();
    this.#timer = setInterval(() => this.#tick(), this.#intervalMs);
  }

  stop(): Promise<BoundedCapabilityChurnSummary> {
    if (this.#startedAtMs === undefined) {
      return Promise.reject(new Error("Capability churn has not started."));
    }
    if (this.#stopPromise) return this.#stopPromise;
    this.#stopScheduling();
    this.#stopPromise = (async () => {
      await this.#inFlight;
      return {
        completedCycles: this.#completedCycles,
        elapsedMs: this.#monotonicNow() - this.#startedAtMs!,
        failedCycles: this.#failedCycles,
        maximumCycleLatencyMs: this.#maximumCycleLatencyMs,
        requestedCyclesPerSecond: this.#cyclesPerSecond,
        scheduledCycles: this.#scheduledCycles,
        schemaVersion: 1,
        skippedBusyCycles: this.#skippedBusyCycles,
        startedCycles: this.#startedCycles,
      };
    })();
    return this.#stopPromise;
  }

  #stopScheduling() {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  #tick() {
    this.#scheduledCycles += 1;
    if (this.#inFlight) {
      this.#skippedBusyCycles += 1;
      return;
    }
    this.#startedCycles += 1;
    const startedAtMs = this.#monotonicNow();
    const operation = this.#runOperation(startedAtMs);
    this.#inFlight = operation;
    void operation.then(() => {
      if (this.#inFlight === operation) this.#inFlight = undefined;
    });
  }

  async #runOperation(startedAtMs: number) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(() => this.#operation()),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () =>
              reject(
                new Error(`Capability churn operation exceeded ${this.#operationTimeoutMs}ms.`),
              ),
            this.#operationTimeoutMs,
          );
        }),
      ]);
      this.#completedCycles += 1;
    } catch (error) {
      this.#failedCycles += 1;
      this.#stopScheduling();
      this.#onFailure?.(
        error instanceof Error ? error : new Error(`Capability churn failed: ${String(error)}`),
      );
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      this.#maximumCycleLatencyMs = Math.max(
        this.#maximumCycleLatencyMs,
        this.#monotonicNow() - startedAtMs,
      );
    }
  }
}

/**
 * Judges whether the requested diagnostic load was actually applied.
 *
 * Audio continuity under a nominal 20 Hz setting says little if most cycles
 * were skipped. Conversely, one boundary tick may race the explicit stop, so
 * the default physical policy can demand a high fraction without requiring an
 * impossible exact timer count.
 */
export function assessBoundedCapabilityChurn(
  summary: BoundedCapabilityChurnSummary,
  minimumCompletionFraction: number,
): BoundedCapabilityChurnAssessment {
  if (
    !Number.isFinite(minimumCompletionFraction) ||
    minimumCompletionFraction <= 0 ||
    minimumCompletionFraction > 1
  ) {
    throw new TypeError("Minimum capability churn completion fraction must be in (0, 1].");
  }
  const completionFraction =
    summary.scheduledCycles === 0 ? 0 : summary.completedCycles / summary.scheduledCycles;
  if (summary.failedCycles > 0) {
    return {
      completionFraction,
      kind: "failure",
      reason: `${summary.failedCycles} capability churn cycle(s) failed.`,
    };
  }
  if (summary.completedCycles === 0 || completionFraction < minimumCompletionFraction) {
    return {
      completionFraction,
      kind: "failure",
      reason:
        `Capability churn completed ${summary.completedCycles}/${summary.scheduledCycles} ` +
        `scheduled cycles (${completionFraction.toFixed(3)}), below ` +
        `${minimumCompletionFraction.toFixed(3)}.`,
    };
  }
  return { kind: "healthy" };
}
