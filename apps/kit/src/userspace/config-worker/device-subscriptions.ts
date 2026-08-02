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
    | "device-event-subscribe-exhausted"
    | "device-event-subscribe-retrying"
    | "device-metrics-subscribed"
    | "device-metrics-subscribe-exhausted"
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
    if (options.retryDelaysMs.length === 0 || options.retryDelaysMs[0] !== 0) {
      throw new Error("Device subscription retries must begin immediately.");
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
     * Metrics exhaustion is allowed to leave metricsReady=false, but the
     * retained project—and therefore the already-live PTT callback—survives.
     */
    await this.#establishMetricsSubscription(project);
  }

  async #establishEventSubscription(): Promise<Project | undefined> {
    const { retryDelaysMs } = this.#options;
    for (const [index, delayMs] of retryDelaysMs.entries()) {
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
        const nextDelayMs = retryDelaysMs[index + 1] ?? null;
        this.#options.onDiagnostic({
          attempt: this.#status.eventAttempts,
          code:
            nextDelayMs === null
              ? "device-event-subscribe-exhausted"
              : "device-event-subscribe-retrying",
          message: this.#status.lastEventError,
          nextDelayMs,
        });
      }
    }
    return undefined;
  }

  async #establishMetricsSubscription(project: Project): Promise<void> {
    const { retryDelaysMs } = this.#options;
    for (const [index, delayMs] of retryDelaysMs.entries()) {
      if (delayMs > 0) await this.#options.wait(delayMs);
      if (!this.#options.isCurrent()) return;

      this.#status.metricsAttempts += 1;
      try {
        await this.#options.subscribeToMetrics(project);
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
        const nextDelayMs = retryDelaysMs[index + 1] ?? null;
        this.#options.onDiagnostic({
          attempt: this.#status.metricsAttempts,
          code:
            nextDelayMs === null
              ? "device-metrics-subscribe-exhausted"
              : "device-metrics-subscribe-retrying",
          message: this.#status.lastMetricsError,
          nextDelayMs,
        });
      }
    }
  }
}
