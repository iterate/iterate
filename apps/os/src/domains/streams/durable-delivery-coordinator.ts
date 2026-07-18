import type { StreamEventInput } from "iterate/processors";
import type { CoreProcessorState } from "./core-processor-contract.ts";
import type { SubscriptionCursorFence, SubscriptionCursorStore } from "./stream-storage.ts";
import { computeBackoffMs, MAX_DELIVERY_ATTEMPTS } from "./subscriber-math.ts";

/** Local receiver-call timeout. The durable watchdog trails it by five seconds. */
export const DELIVERY_TIMEOUT_MS = 60_000;
const DELIVERY_WATCHDOG_MS = DELIVERY_TIMEOUT_MS + 5_000;
const DELIVERY_WATCHDOG_RECHECK_MS = 5_000;
const INFRASTRUCTURE_RETRY_MS = 5_000;
const ALARM_PROJECTION_ATTEMPTS = 3;

/**
 * The one irreducible delivery-liveness boundary.
 *
 * Cursor/config intent is still durable, but the current activation exhausted
 * both ways of handing that intent onward: projecting a platform alarm and
 * committing the operator-owned parked transition. This error must remain
 * uncaught at the request/waitUntil boundary so telemetry describes a fatal
 * invariant, never a successful recovery. A later external activation can
 * reconstruct the preserved intent.
 */
export class StreamDeliveryFatalInvariantError extends AggregateError {
  constructor(purpose: string, errors: readonly unknown[]) {
    super(
      errors,
      `${purpose}: durable delivery intent has neither an alarm projection nor a parked transition`,
    );
    this.name = "StreamDeliveryFatalInvariantError";
  }
}

/** One config-and-cursor incarnation allowed to mutate delivery state. */
export type DeliveryAttempt = SubscriptionCursorFence & {
  configOffset: number;
};

type DurableDeliveryCoordinatorHooks = {
  coreState(): CoreProcessorState;
  store: SubscriptionCursorStore;
  appendRequiredFact(event: StreamEventInput): void;
  now(): number;
  random(): number;
  armAlarm(atMs: number): Promise<void>;
  repointAlarm(atMs: number | null): Promise<void>;
  keepAlive(promise: Promise<unknown>): void;
  abortIncarnation(reason: string): void;
  isInFlight(subscriptionKey: string): boolean;
  onParked(subscriptionKey: string): void;
};

/**
 * Owns the durable lifecycle of remote delivery attempts.
 *
 * One attempt has exactly four storage transitions:
 *
 * 1. `begin` persists an in-flight watchdog, then arms the platform alarm.
 * 2. `clearWatchdog` consumes it for an immediate local retry (poison bisect).
 * 3. `fail` replaces it with receiver-policy backoff (or a parked fact).
 * 4. The caller's fenced ack/watermark consumes it on success.
 *
 * Alarm infrastructure failures never enter receiver policy. Every write is
 * fenced to the captured cursor epoch, while `isCurrent` also fences config
 * replacement at the stream fold.
 */
export class DurableDeliveryCoordinator {
  readonly #hooks: DurableDeliveryCoordinatorHooks;
  /**
   * Config-owned retries for failures that happened before a cursor row could
   * be read and fenced. The platform alarm is their durable successor; this
   * slice keeps exact in-incarnation alarm projection from erasing it.
   */
  readonly #reconcileRetryByKey = new Map<
    string,
    { readonly configOffset: number; readonly retryAt: number }
  >();

  constructor(hooks: DurableDeliveryCoordinatorHooks) {
    this.#hooks = hooks;
  }

  isCurrent(attempt: DeliveryAttempt): boolean {
    const configured = this.#hooks.coreState().configuredSubscribersByKey[attempt.subscriptionKey];
    if (
      configured === undefined ||
      configured.parkedReason !== undefined ||
      configured.latestConfiguredEvent.offset !== attempt.configOffset
    ) {
      return false;
    }
    return this.#hooks.store.get(attempt.subscriptionKey)?.epoch === attempt.epoch;
  }

  /** A successful row read transfers this exact config's retry ownership to its cursor row. */
  reconciled(subscriptionKey: string, configOffset: number): void {
    if (this.#reconcileRetryByKey.get(subscriptionKey)?.configOffset === configOffset) {
      this.#reconcileRetryByKey.delete(subscriptionKey);
    }
  }

  /** A parked configuration has no remaining automatic delivery obligation. */
  forgetReconcile(subscriptionKey: string): void {
    this.#reconcileRetryByKey.delete(subscriptionKey);
  }

  /**
   * Recover a failure that happened before reconciliation acquired a cursor
   * epoch. First retry row acquisition and enter the ordinary fenced
   * infrastructure path. If the row remains unreadable, retain a config-owned
   * alarm slice; terminal alarm-projection failure parks without inventing a
   * cursor offset or fence.
   */
  recoverReconcile(args: {
    subscriptionKey: string;
    configOffset: number;
    initialCursor: number;
    error: unknown;
  }): void {
    const existing = this.#reconcileRetryByKey.get(args.subscriptionKey);
    if (existing?.configOffset === args.configOffset && existing.retryAt > this.#hooks.now()) {
      return;
    }
    const retryAt = this.#hooks.now() + INFRASTRUCTURE_RETRY_MS;
    const ownership = { configOffset: args.configOffset, retryAt } as const;
    this.#reconcileRetryByKey.set(args.subscriptionKey, ownership);
    const ownsRetry = () => this.#reconcileRetryByKey.get(args.subscriptionKey) === ownership;
    const releaseRetry = () => {
      if (ownsRetry()) this.#reconcileRetryByKey.delete(args.subscriptionKey);
    };
    const work = (async () => {
      let acquisitionError: unknown = args.error;
      for (
        let recoveryAttempt = 1;
        recoveryAttempt <= ALARM_PROJECTION_ATTEMPTS;
        recoveryAttempt += 1
      ) {
        if (!ownsRetry() || !this.#isConfigurationCurrent(args)) {
          releaseRetry();
          return;
        }
        try {
          this.#hooks.store.ensure(args.subscriptionKey, args.initialCursor);
          const row = this.#hooks.store.get(args.subscriptionKey);
          if (row === undefined) throw new Error("subscription cursor missing after ensure");
          const disposition = await this.retryInfrastructure(
            {
              subscriptionKey: args.subscriptionKey,
              configOffset: args.configOffset,
              epoch: row.epoch,
            },
            args.error,
          );
          if (disposition !== "stale" || !this.#isConfigurationCurrent(args)) {
            releaseRetry();
            return;
          }
          acquisitionError = new Error(
            `subscription cursor changed during reconciliation recovery for ${args.subscriptionKey}`,
          );
        } catch (error) {
          acquisitionError = error;
          console.warn("stream cursor acquisition recovery failed", {
            subscriptionKey: args.subscriptionKey,
            recoveryAttempt,
            attempts: ALARM_PROJECTION_ATTEMPTS,
            error,
          });
        }
      }

      if (!ownsRetry() || !this.#isConfigurationCurrent(args)) {
        releaseRetry();
        return;
      }
      const projectionError = await this.#armWithRetries(
        retryAt,
        `subscription reconciliation ${args.subscriptionKey}`,
      );
      if (projectionError === undefined) {
        if (!this.#isConfigurationCurrent(args)) releaseRetry();
        return;
      }
      if (!ownsRetry() || !this.#isConfigurationCurrent(args)) {
        releaseRetry();
        return;
      }

      const terminalError = new AggregateError(
        [args.error, acquisitionError, projectionError],
        "subscription reconciliation and alarm projection failed",
      );
      const recovery = await this.#parkOrReproject({
        error: terminalError,
        park: () =>
          this.#parkConfigurationWithoutCursor({
            subscriptionKey: args.subscriptionKey,
            configOffset: args.configOffset,
            attempts: ALARM_PROJECTION_ATTEMPTS,
            error: terminalError,
          }),
        purpose: `subscription reconciliation ${args.subscriptionKey}`,
      });
      if (recovery === "parked") releaseRetry();
    })();
    this.#hooks.keepAlive(work);
  }

  /** Persist and arm the successor wake before crossing a remote boundary. */
  async begin(attempt: DeliveryAttempt): Promise<"ready" | "stale" | "parked"> {
    if (!this.#isConfigurationCurrent(attempt)) return "stale";
    const watchdogAt = this.#hooks.now() + DELIVERY_WATCHDOG_MS;
    // The fenced UPDATE is both the epoch check and the first durable
    // obligation. A separate pre-write get() could fail after reconciliation
    // captured this fence and strand a quiet stream with no watchdog at all.
    if (!this.#hooks.store.beginAttempt(attempt, watchdogAt)) return "stale";
    const projectionError = await this.#armWithRetries(watchdogAt, "delivery watchdog");
    if (projectionError !== undefined) {
      const recovery = await this.#parkOrReproject({
        error: projectionError,
        park: () =>
          this.#park(attempt, ALARM_PROJECTION_ATTEMPTS, projectionError, "infrastructure-failure"),
        purpose: "delivery watchdog projection",
      });
      if (recovery === "parked") return "parked";
    }
    return this.isCurrent(attempt) ? "ready" : "stale";
  }

  /** Consume an in-flight watchdog without introducing policy backoff. */
  clearWatchdog(attempt: DeliveryAttempt): boolean {
    if (!this.isCurrent(attempt)) return false;
    this.#hooks.store.clearWatchdog(attempt);
    return true;
  }

  /** Receiver failure: bounded policy backoff, then a loud parked transition. */
  async fail(attempt: DeliveryAttempt, error: unknown): Promise<void> {
    if (!this.isCurrent(attempt)) return;
    const row = this.#hooks.store.get(attempt.subscriptionKey);
    if (row === undefined || row.epoch !== attempt.epoch) return;
    const attemptCount = Math.min(row.attempt + 1, MAX_DELIVERY_ATTEMPTS);
    if (attemptCount < MAX_DELIVERY_ATTEMPTS) {
      await this.#backoff(attempt, attemptCount, error);
      return;
    }

    await this.park(attempt, attemptCount, error);
  }

  /**
   * Singleton application rejection while poison isolation is active.
   * Availability attempts and poison confirmations are deliberately separate:
   * a prior outage can make the generic circuit breaker conservative, but can
   * never prove an event poison.
   */
  async failPoison(
    attempt: DeliveryAttempt,
    args: { error: unknown; poisonOffset: number; poisonConfirmations: number },
  ): Promise<void> {
    if (!this.isCurrent(attempt)) return;
    const row = this.#hooks.store.get(attempt.subscriptionKey);
    if (row === undefined || row.epoch !== attempt.epoch) return;
    const attemptCount = Math.min(row.attempt + 1, MAX_DELIVERY_ATTEMPTS);
    if (attemptCount >= MAX_DELIVERY_ATTEMPTS) {
      await this.park(attempt, attemptCount, args.error);
      return;
    }
    await this.#backoffPoison(attempt, {
      attemptCount,
      error: args.error,
      poisonOffset: args.poisonOffset,
      poisonConfirmations: args.poisonConfirmations,
    });
  }

  /** Local failure: preserve receiver policy counters and arrange a fresh incarnation wake. */
  async retryInfrastructure(
    attempt: DeliveryAttempt,
    error: unknown,
  ): Promise<"scheduled" | "parked" | "stale"> {
    if (!this.#isConfigurationCurrent(attempt)) return "stale";
    const retryAt = this.#hooks.now() + INFRASTRUCTURE_RETRY_MS;
    if (
      !this.#hooks.store.deferInfrastructure(attempt, {
        nextAttemptAt: retryAt,
        error: errorMessage(error),
      })
    ) {
      return "stale";
    }
    const projectionError = await this.#armWithRetries(retryAt, "infrastructure retry");
    if (projectionError !== undefined) {
      const recovery = await this.#parkOrReproject({
        error: projectionError,
        park: () =>
          this.#park(attempt, ALARM_PROJECTION_ATTEMPTS, projectionError, "infrastructure-failure"),
        purpose: "infrastructure retry projection",
      });
      return recovery === "parked" ? "parked" : "scheduled";
    }
    return "scheduled";
  }

  /**
   * Give up loudly after a caller-specific terminal policy decision.
   *
   * Poison skipping uses a consecutive-skip threshold that can park before
   * the generic delivery-attempt ceiling, so parking is an explicit durable
   * transition rather than an implementation detail of `fail`.
   */
  async park(attempt: DeliveryAttempt, attempts: number, error: unknown): Promise<void> {
    await this.#park(attempt, attempts, error, "receiver-failure");
  }

  async #park(
    attempt: DeliveryAttempt,
    attempts: number,
    error: unknown,
    reason: "receiver-failure" | "infrastructure-failure",
  ): Promise<void> {
    if (!this.isCurrent(attempt)) return;
    const row = this.#hooks.store.get(attempt.subscriptionKey);
    if (row === undefined || row.epoch !== attempt.epoch) return;

    try {
      this.#hooks.appendRequiredFact({
        type: "events.iterate.com/stream/subscription-parked",
        payload: {
          subscriptionKey: attempt.subscriptionKey,
          atOffset: row.ackedOffset,
          attempts,
          reason,
          error: errorMessage(error),
        },
      });
    } catch (parkError) {
      console.error("stream subscription park fact failed", {
        subscriptionKey: attempt.subscriptionKey,
        reason,
        error: parkError,
        deliveryError: error,
      });
      if (reason === "infrastructure-failure") throw parkError;
      await this.#backoff(attempt, attempts, parkError);
      return;
    }

    try {
      // The parked fact is now authoritative. Clear its cursor deadlines so
      // the parked row cannot hot-loop the shared alarm.
      this.#hooks.store.ackAttempt(attempt, row.ackedOffset);
    } catch (cleanupError) {
      console.error("stream parked cursor cleanup failed; restarting incarnation", {
        subscriptionKey: attempt.subscriptionKey,
        error: cleanupError,
      });
      this.#hooks.abortIncarnation("stream parked cursor cleanup failed");
      return;
    }
    this.#hooks.onParked(attempt.subscriptionKey);
  }

  async #backoff(attempt: DeliveryAttempt, attemptCount: number, error: unknown): Promise<void> {
    if (!this.isCurrent(attempt)) return;
    const retryAt = this.#hooks.now() + computeBackoffMs(attemptCount, this.#hooks.random());
    this.#hooks.store.nack(attempt, {
      attempt: attemptCount,
      nextAttemptAt: retryAt,
      error: errorMessage(error),
    });
    const projectionError = await this.#armWithRetries(retryAt, "receiver retry");
    if (projectionError !== undefined) {
      await this.#parkOrReproject({
        error: projectionError,
        park: () =>
          this.#park(attempt, ALARM_PROJECTION_ATTEMPTS, projectionError, "infrastructure-failure"),
        purpose: "receiver retry projection",
      });
    }
  }

  async #backoffPoison(
    attempt: DeliveryAttempt,
    args: {
      attemptCount: number;
      error: unknown;
      poisonOffset: number;
      poisonConfirmations: number;
    },
  ): Promise<void> {
    if (!this.isCurrent(attempt)) return;
    const retryAt = this.#hooks.now() + computeBackoffMs(args.attemptCount, this.#hooks.random());
    this.#hooks.store.nackPoison(attempt, {
      attempt: args.attemptCount,
      nextAttemptAt: retryAt,
      error: errorMessage(args.error),
      poisonOffset: args.poisonOffset,
      poisonConfirmations: args.poisonConfirmations,
    });
    const projectionError = await this.#armWithRetries(retryAt, "poison confirmation retry");
    if (projectionError !== undefined) {
      await this.#parkOrReproject({
        error: projectionError,
        park: () =>
          this.#park(attempt, ALARM_PROJECTION_ATTEMPTS, projectionError, "infrastructure-failure"),
        purpose: "poison confirmation retry projection",
      });
    }
  }

  /**
   * Finish one failed alarm projection through one of its two durable exits.
   * Parking is retried first because it is the bounded terminal policy;
   * otherwise an exact alarm projection retains automatic ownership. Only a
   * compound failure of both routes is fatal, and neither route's failure is
   * mistaken for an incarnation restart.
   */
  async #parkOrReproject(args: {
    error: unknown;
    park(): Promise<void>;
    purpose: string;
  }): Promise<"parked" | "reprojected"> {
    const parkFailures: unknown[] = [];
    for (let attempt = 1; attempt <= ALARM_PROJECTION_ATTEMPTS; attempt += 1) {
      try {
        await args.park();
        return "parked";
      } catch (error) {
        parkFailures.push(error);
        console.warn("stream terminal park transition attempt failed", {
          purpose: args.purpose,
          attempt,
          attempts: ALARM_PROJECTION_ATTEMPTS,
          error,
        });
      }
    }

    const parkError = new AggregateError(
      parkFailures,
      `${args.purpose} park transition failed after bounded retries`,
    );
    try {
      await this.repointAlarmWithRetries(`${args.purpose} recovery projection`);
      return "reprojected";
    } catch (projectionError) {
      throw new StreamDeliveryFatalInvariantError(args.purpose, [
        args.error,
        parkError,
        projectionError,
      ]);
    }
  }

  async #armWithRetries(atMs: number, purpose: string): Promise<unknown | undefined> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= ALARM_PROJECTION_ATTEMPTS; attempt += 1) {
      try {
        await this.#hooks.armAlarm(atMs);
        return undefined;
      } catch (error) {
        lastError = error;
        console.warn("stream alarm projection attempt failed", {
          purpose,
          attempt,
          attempts: ALARM_PROJECTION_ATTEMPTS,
          atMs,
          error,
        });
      }
    }
    return lastError;
  }

  /** Exact platform-alarm projection after the platform consumed one alarm. */
  repointAlarmFromStore(): Promise<void> {
    const state = this.#hooks.coreState();
    const now = this.#hooks.now();
    let next: number | null = null;
    for (const row of this.#hooks.store.list()) {
      if (row.nextAttemptAt === null) continue;
      const configured = state.configuredSubscribersByKey[row.subscriptionKey];
      if (configured === undefined || configured.parkedReason !== undefined) continue;
      const candidate =
        this.#hooks.isInFlight(row.subscriptionKey) && row.nextAttemptAt <= now
          ? now + DELIVERY_WATCHDOG_RECHECK_MS
          : row.nextAttemptAt;
      if (next === null || candidate < next) next = candidate;
    }
    for (const [subscriptionKey, pending] of this.#reconcileRetryByKey) {
      const configured = state.configuredSubscribersByKey[subscriptionKey];
      if (
        configured === undefined ||
        configured.parkedReason !== undefined ||
        configured.latestConfiguredEvent.offset !== pending.configOffset
      ) {
        this.#reconcileRetryByKey.delete(subscriptionKey);
        continue;
      }
      if (next === null || pending.retryAt < next) next = pending.retryAt;
    }
    return this.#hooks.repointAlarm(next);
  }

  /** Bounded exact projection for a path whose current activation has no successor left. */
  async repointAlarmWithRetries(purpose: string): Promise<void> {
    const failures: unknown[] = [];
    for (let attempt = 1; attempt <= ALARM_PROJECTION_ATTEMPTS; attempt += 1) {
      try {
        await this.repointAlarmFromStore();
        return;
      } catch (error) {
        failures.push(error);
        console.warn("stream exact alarm projection attempt failed", {
          purpose,
          attempt,
          attempts: ALARM_PROJECTION_ATTEMPTS,
          error,
        });
      }
    }
    throw new AggregateError(failures, `${purpose} failed after bounded retries`);
  }

  /** Best-effort cleanup after an already-durable attempt transition. */
  async repointAfterAttempt(): Promise<void> {
    try {
      await this.repointAlarmFromStore();
    } catch (error) {
      console.error("stream alarm repoint after delivery failed", error);
    }
  }

  /**
   * Convert every still-scheduled delivery into explicit operator-owned state.
   * Used only when an activation source has exhausted its own bounded retry
   * policy and leaving a deadline behind would silently orphan work.
   */
  async parkOutstandingInfrastructure(error: unknown, attempts: number): Promise<void> {
    const state = this.#hooks.coreState();
    for (const row of this.#hooks.store.list()) {
      if (row.nextAttemptAt === null) continue;
      const configured = state.configuredSubscribersByKey[row.subscriptionKey];
      if (configured === undefined || configured.parkedReason !== undefined) continue;
      await this.#park(
        {
          subscriptionKey: row.subscriptionKey,
          configOffset: configured.latestConfiguredEvent.offset,
          epoch: row.epoch,
        },
        attempts,
        error,
        "infrastructure-failure",
      );
    }
    for (const [subscriptionKey, pending] of [...this.#reconcileRetryByKey]) {
      const configured = this.#hooks.coreState().configuredSubscribersByKey[subscriptionKey];
      if (
        configured === undefined ||
        configured.parkedReason !== undefined ||
        configured.latestConfiguredEvent.offset !== pending.configOffset
      ) {
        this.#reconcileRetryByKey.delete(subscriptionKey);
        continue;
      }
      await this.#parkConfigurationWithoutCursor({
        subscriptionKey,
        configOffset: pending.configOffset,
        attempts,
        error,
      });
      if (!this.#isConfigurationCurrent({ subscriptionKey, configOffset: pending.configOffset })) {
        this.#reconcileRetryByKey.delete(subscriptionKey);
      }
    }
  }

  /** Final native-alarm/boot recovery, owned here rather than by callers. */
  recoverExhaustedAlarm(error: unknown, attempts: number, purpose: string): Promise<void> {
    return this.#parkOrReproject({
      error,
      park: () => this.parkOutstandingInfrastructure(error, attempts),
      purpose,
    }).then(() => undefined);
  }

  /** Every fresh incarnation reprojects row intent before relying on alarms. */
  recoverAlarmAfterBoot(): void {
    const work = (async () => {
      let lastError: unknown;
      for (let attempt = 1; attempt <= ALARM_PROJECTION_ATTEMPTS; attempt += 1) {
        try {
          await this.repointAlarmFromStore();
          return;
        } catch (error) {
          lastError = error;
          console.warn("stream alarm recovery projection failed", {
            attempt,
            attempts: ALARM_PROJECTION_ATTEMPTS,
            error,
          });
        }
      }

      // There is no independent activator after constructor/background work.
      // Either make the outstanding intent operator-owned or durably re-arm
      // it; a compound failure remains a fatal waitUntil rejection.
      await this.recoverExhaustedAlarm(
        lastError,
        ALARM_PROJECTION_ATTEMPTS,
        "stream boot alarm recovery",
      );
    })();
    this.#hooks.keepAlive(work);
  }

  async #parkConfigurationWithoutCursor(args: {
    subscriptionKey: string;
    configOffset: number;
    attempts: number;
    error: unknown;
  }): Promise<void> {
    const configured = this.#hooks.coreState().configuredSubscribersByKey[args.subscriptionKey];
    if (
      configured === undefined ||
      configured.parkedReason !== undefined ||
      configured.latestConfiguredEvent.offset !== args.configOffset
    ) {
      return;
    }

    let row;
    try {
      row = this.#hooks.store.get(args.subscriptionKey);
    } catch (error) {
      console.error("stream cursor remained unreadable while parking reconciliation", {
        subscriptionKey: args.subscriptionKey,
        error,
      });
    }
    if (row !== undefined) {
      await this.#park(
        {
          subscriptionKey: args.subscriptionKey,
          configOffset: args.configOffset,
          epoch: row.epoch,
        },
        args.attempts,
        args.error,
        "infrastructure-failure",
      );
      return;
    }

    this.#hooks.appendRequiredFact({
      type: "events.iterate.com/stream/subscription-parked",
      payload: {
        subscriptionKey: args.subscriptionKey,
        attempts: args.attempts,
        reason: "infrastructure-failure",
        error: errorMessage(args.error),
      },
    });
    this.#hooks.onParked(args.subscriptionKey);
  }

  #isConfigurationCurrent(args: { subscriptionKey: string; configOffset: number }): boolean {
    const configured = this.#hooks.coreState().configuredSubscribersByKey[args.subscriptionKey];
    return (
      configured !== undefined &&
      configured.parkedReason === undefined &&
      configured.latestConfiguredEvent.offset === args.configOffset
    );
  }
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)) || "unknown error";
}
