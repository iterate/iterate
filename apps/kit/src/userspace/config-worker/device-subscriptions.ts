export interface DeviceSubscriptionMetrics {
  eventAttempts: number;
  eventFailures: number;
  eventReady: boolean;
  lastEventError: string | null;
  lastMetricsError: string | null;
  metricsAttempts: number;
  metricsFailures: number;
  metricsReady: boolean;
}

export type DeviceSubscriptionLifecycleDiagnostic = {
  attempt: number;
  code:
    | "device-event-subscribed"
    | "device-event-subscribe-retrying"
    | "device-metrics-subscribed"
    | "device-metrics-subscribe-retrying";
  message: string | null;
  nextDelayMs: number | null;
};

interface DeviceSubscriptionCoordinatorOptions<Project> {
  isCurrent(): boolean;
  onDiagnostic(diagnostic: DeviceSubscriptionLifecycleDiagnostic): void;
  openProject(): Promise<Project>;
  releaseProject(project: Project): void;
  retainProject(project: Project): boolean;
  retryDelaysMs: readonly number[];
  subscribeToEvents(project: Project): Promise<void>;
  subscribeToMetrics(project: Project): Promise<void>;
  wait(delayMs: number): Promise<void>;
}

/**
 * Owns the asymmetric lifecycle of the device's two callback subscriptions.
 *
 * PTT events are part of the audio control plane: without them a manual call
 * cannot start, interrupt, or commit a turn. Metrics are an observability
 * plane. They should retry and report degradation, but they must not destroy a
 * working event callback. Production exposed why this distinction matters:
 * event subscription delivered its initial snapshot, metrics then rejected a
 * full subscriber table, and a shared catch disposed the project session that
 * owned both callbacks.
 *
 * One retained Cap'n Web project still owns both callbacks. That keeps socket
 * and heap cost bounded. The important boundary is failure ownership, not an
 * extra connection: only failure before the event subscription is established
 * releases the project and retries the critical lane.
 */
export class DeviceSubscriptionCoordinator<Project> {
  readonly #options: DeviceSubscriptionCoordinatorOptions<Project>;
  readonly #status: DeviceSubscriptionMetrics = {
    eventAttempts: 0,
    eventFailures: 0,
    eventReady: false,
    lastEventError: null,
    lastMetricsError: null,
    metricsAttempts: 0,
    metricsFailures: 0,
    metricsReady: false,
  };

  constructor(options: DeviceSubscriptionCoordinatorOptions<Project>) {
    if (
      options.retryDelaysMs.length < 2 ||
      options.retryDelaysMs[0] !== 0 ||
      (options.retryDelaysMs.at(-1) ?? 0) <= 0
    ) {
      throw new Error(
        "Device subscription retries must begin immediately and end at a positive bounded cadence.",
      );
    }
    this.#options = options;
  }

  metrics(): DeviceSubscriptionMetrics {
    return { ...this.#status };
  }

  async establish(): Promise<void> {
    const project = await this.#establishEventSubscription();
    if (project === undefined) return;

    /*
     * This deliberately sits outside the event subscription's try/catch.
     * Metrics degradation is allowed to leave metricsReady=false while it
     * retries, but the retained project—and therefore the already-live PTT
     * callback—survives.
     */
    await this.#establishMetricsSubscription(project);
  }

  async #establishEventSubscription(): Promise<Project | undefined> {
    const { retryDelaysMs } = this.#options;
    const maximumRetryIndex = retryDelaysMs.length - 1;
    for (let retryIndex = 0; ; retryIndex += 1) {
      const delayIndex = Math.min(retryIndex, maximumRetryIndex);
      const delayMs = retryDelaysMs[delayIndex];
      if (delayMs > 0) await this.#options.wait(delayMs);
      if (!this.#options.isCurrent()) return undefined;

      this.#status.eventAttempts += 1;
      let project: Project | undefined;
      try {
        project = await this.#options.openProject();
        if (!this.#options.isCurrent() || !this.#options.retainProject(project)) {
          this.#options.releaseProject(project);
          return undefined;
        }
        await this.#options.subscribeToEvents(project);
        if (!this.#options.isCurrent()) {
          /*
           * A replacement /pcm generation may win while the remote subscribe
           * call is in flight. Releasing this exact retained generation keeps
           * a late success from becoming an unowned callback export.
           */
          this.#options.releaseProject(project);
          return undefined;
        }
        this.#status.eventReady = true;
        this.#status.lastEventError = null;
        this.#options.onDiagnostic({
          attempt: this.#status.eventAttempts,
          code: "device-event-subscribed",
          message: null,
          nextDelayMs: null,
        });
        return project;
      } catch (error) {
        if (project !== undefined) this.#options.releaseProject(project);
        this.#status.eventFailures += 1;
        this.#status.lastEventError = error instanceof Error ? error.message : String(error);
        if (!this.#options.isCurrent()) return undefined;
        const nextDelayMs = retryDelaysMs[Math.min(retryIndex + 1, maximumRetryIndex)];
        /*
         * The critical callback follows the PCM generation's lifetime, not a
         * finite attempt budget. A Stick can remount minutes after an outage;
         * declaring it permanently exhausted while /pcm remains open creates
         * the observed half-alive state. Repeat only the final bounded delay,
         * so recovery has constant memory and one outstanding timer.
         *
         * The counter remains exact on every attempt, but logs become sparse
         * once the backoff plateaus. Emitting a warning every eight seconds
         * forever would turn an already-classified outage into error spam and
         * compete with the evidence needed to diagnose it.
         */
        const plateauAttempt = retryIndex - maximumRetryIndex;
        const shouldReport = retryIndex <= maximumRetryIndex || plateauAttempt % 32 === 0;
        if (shouldReport) {
          this.#options.onDiagnostic({
            attempt: this.#status.eventAttempts,
            code: "device-event-subscribe-retrying",
            message: this.#status.lastEventError,
            nextDelayMs,
          });
        }
      }
    }
  }

  async #establishMetricsSubscription(project: Project): Promise<void> {
    const { retryDelaysMs } = this.#options;
    const maximumRetryIndex = retryDelaysMs.length - 1;
    for (let retryIndex = 0; ; retryIndex += 1) {
      const delayIndex = Math.min(retryIndex, maximumRetryIndex);
      const delayMs = retryDelaysMs[delayIndex];
      if (delayMs > 0) await this.#options.wait(delayMs);
      if (!this.#options.isCurrent()) return;

      this.#status.metricsAttempts += 1;
      try {
        await this.#options.subscribeToMetrics(project);
        if (!this.#options.isCurrent()) return;
        this.#status.metricsReady = true;
        this.#status.lastMetricsError = null;
        this.#options.onDiagnostic({
          attempt: this.#status.metricsAttempts,
          code: "device-metrics-subscribed",
          message: null,
          nextDelayMs: null,
        });
        return;
      } catch (error) {
        this.#status.metricsFailures += 1;
        this.#status.lastMetricsError = error instanceof Error ? error.message : String(error);
        if (!this.#options.isCurrent()) return;
        const nextDelayMs = retryDelaysMs[Math.min(retryIndex + 1, maximumRetryIndex)];
        const plateauAttempt = retryIndex - maximumRetryIndex;
        const shouldReport = retryIndex <= maximumRetryIndex || plateauAttempt % 32 === 0;
        if (shouldReport) {
          this.#options.onDiagnostic({
            attempt: this.#status.metricsAttempts,
            code: "device-metrics-subscribe-retrying",
            message: this.#status.lastMetricsError,
            nextDelayMs,
          });
        }
      }
    }
  }
}
