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

  constructor(hooks: DurableDeliveryCoordinatorHooks) {
    this.#hooks = hooks;
  }

  capture(subscriptionKey: string, configOffset: number): DeliveryAttempt | undefined {
    const row = this.#hooks.store.get(subscriptionKey);
    return row === undefined ? undefined : { subscriptionKey, configOffset, epoch: row.epoch };
  }

  isCurrent(attempt: DeliveryAttempt): boolean {
    const configured = this.#hooks.coreState().configuredSubscribersByKey[attempt.subscriptionKey];
    if (
      configured === undefined ||
      configured.parkedAtOffset !== undefined ||
      configured.latestConfiguredEvent.offset !== attempt.configOffset
    ) {
      return false;
    }
    return this.#hooks.store.get(attempt.subscriptionKey)?.epoch === attempt.epoch;
  }

  /** Persist and arm the successor wake before crossing a remote boundary. */
  async begin(attempt: DeliveryAttempt): Promise<"ready" | "stale" | "parked"> {
    if (!this.isCurrent(attempt)) return "stale";
    const watchdogAt = this.#hooks.now() + DELIVERY_WATCHDOG_MS;
    this.#hooks.store.beginAttempt(attempt, watchdogAt);
    const projectionError = await this.#armWithRetries(watchdogAt, "delivery watchdog");
    if (projectionError !== undefined) {
      await this.#park(
        attempt,
        ALARM_PROJECTION_ATTEMPTS,
        projectionError,
        "infrastructure-failure",
      );
      return "parked";
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
    if (!this.isCurrent(attempt)) return "stale";
    const retryAt = this.#hooks.now() + INFRASTRUCTURE_RETRY_MS;
    this.#hooks.store.deferInfrastructure(attempt, {
      nextAttemptAt: retryAt,
      error: errorMessage(error),
    });
    const projectionError = await this.#armWithRetries(retryAt, "infrastructure retry");
    if (projectionError !== undefined) {
      await this.#park(
        attempt,
        ALARM_PROJECTION_ATTEMPTS,
        projectionError,
        "infrastructure-failure",
      );
      return "parked";
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
      await this.#park(
        attempt,
        ALARM_PROJECTION_ATTEMPTS,
        projectionError,
        "infrastructure-failure",
      );
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
      await this.#park(
        attempt,
        ALARM_PROJECTION_ATTEMPTS,
        projectionError,
        "infrastructure-failure",
      );
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
      if (configured === undefined || configured.parkedAtOffset !== undefined) continue;
      const candidate =
        this.#hooks.isInFlight(row.subscriptionKey) && row.nextAttemptAt <= now
          ? now + DELIVERY_WATCHDOG_RECHECK_MS
          : row.nextAttemptAt;
      if (next === null || candidate < next) next = candidate;
    }
    return this.#hooks.repointAlarm(next);
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
      if (configured === undefined || configured.parkedAtOffset !== undefined) continue;
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
      // Convert every orphanable deadline into explicit operator-owned parked
      // state instead of aborting into a quiet, permanently stuck stream.
      await this.parkOutstandingInfrastructure(lastError, ALARM_PROJECTION_ATTEMPTS);
    })().catch((error) => {
      console.error("stream alarm recovery terminal transition failed; restarting incarnation", {
        error,
      });
      this.#hooks.abortIncarnation("stream alarm recovery terminal transition failed");
    });
    this.#hooks.keepAlive(work);
  }
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)) || "unknown error";
}
