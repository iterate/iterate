import { randomUUID } from "node:crypto";
import * as v from "valibot";
import type { Logger } from "./logger.ts";

export const EventDeliveryConfig = v.object({
  callbackURL: v.string(),
  headers: v.optional(v.record(v.string(), v.string())),
  timeoutMs: v.optional(v.number()),
  retryBaseDelayMs: v.optional(v.number()),
  retryMaxDelayMs: v.optional(v.number()),
  retryMaxAttempts: v.optional(v.number()),
});
export type EventDeliveryConfig = v.InferOutput<typeof EventDeliveryConfig>;

const ITERATE_EVENT_TYPE_PREFIX = "https://events.iterate.com/" as const;
const PIDNAP_EVENT_SCHEMA_VERSION = "1";
const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_RETRY_BASE_DELAY_MS = 200;
const DEFAULT_RETRY_MAX_DELAY_MS = 5_000;
const DEFAULT_RETRY_MAX_ATTEMPTS = 0; // 0 = unlimited while process is alive

export type PidnapEventName = "pidnap/process/state-changed";

type PidnapEventType = `${typeof ITERATE_EVENT_TYPE_PREFIX}${PidnapEventName}`;

type PublishInput = {
  type: PidnapEventName;
  payload: Record<string, unknown>;
};

type PublishEvent = {
  type: PidnapEventType;
  payload: Record<string, unknown>;
};

export class EventPublisher {
  private callbackURL: string | null;
  private headers: Record<string, string>;
  private timeoutMs: number;
  private retryBaseDelayMs: number;
  private retryMaxDelayMs: number;
  private retryMaxAttempts: number;
  private logger: Logger;
  private inflight = new Set<Promise<void>>();
  private sequence = 0;
  private closeDeadlineMs: number | null = null;
  private retryEpoch = 0;

  constructor(config: EventDeliveryConfig | undefined, logger: Logger) {
    this.callbackURL = config?.callbackURL?.trim() ?? null;
    this.headers = config?.headers ?? {};
    this.timeoutMs = Math.max(100, config?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.retryBaseDelayMs = Math.max(10, config?.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS);
    this.retryMaxDelayMs = Math.max(
      this.retryBaseDelayMs,
      config?.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS,
    );
    const configuredMaxAttempts = Math.trunc(
      config?.retryMaxAttempts ?? DEFAULT_RETRY_MAX_ATTEMPTS,
    );
    this.retryMaxAttempts =
      configuredMaxAttempts <= 0 ? Number.POSITIVE_INFINITY : configuredMaxAttempts;
    this.logger = logger;
  }

  get enabled(): boolean {
    return this.callbackURL !== null && this.callbackURL.length > 0;
  }

  publish(input: PublishInput): void {
    if (!this.enabled) return;

    const event: PublishEvent = {
      type: `${ITERATE_EVENT_TYPE_PREFIX}${input.type}`,
      payload: {
        ...input.payload,
        eventId: randomUUID(),
        emittedAt: new Date().toISOString(),
        sequence: ++this.sequence,
      },
    };

    this.send(event);
  }

  async close(timeoutMs = 2_000): Promise<void> {
    if (!this.enabled || this.inflight.size === 0) return;
    const boundedTimeoutMs = Math.max(100, timeoutMs);
    const deadline = Date.now() + boundedTimeoutMs;
    this.closeDeadlineMs =
      this.closeDeadlineMs === null ? deadline : Math.min(this.closeDeadlineMs, deadline);
    let timedOut = false;

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error(`Timed out waiting for pidnap events after ${boundedTimeoutMs}ms`));
      }, boundedTimeoutMs);
    });

    try {
      await Promise.race([Promise.allSettled(Array.from(this.inflight)), timeoutPromise]);
    } catch (error) {
      timedOut = true;
      this.logger.warn("Event publisher close timeout/error:", error);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      this.closeDeadlineMs = null;
      if (timedOut) this.retryEpoch += 1;
    }
  }

  private send(event: PublishEvent): void {
    if (!this.callbackURL) return;

    const requestEpoch = this.retryEpoch;
    const request = this.deliverWithRetry(event, requestEpoch).finally(() => {
      this.inflight.delete(request);
    });
    this.inflight.add(request);
  }

  private async deliverWithRetry(event: PublishEvent, requestEpoch: number): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      if (requestEpoch !== this.retryEpoch) return;
      if (this.isPastCloseDeadline()) return;

      const delivered = await this.deliverOnce(event);
      if (delivered) return;

      if (attempt >= this.retryMaxAttempts) {
        this.logger.warn(
          `Dropping pidnap event "${event.type}" after ${Number.isFinite(this.retryMaxAttempts) ? String(this.retryMaxAttempts) : "many"} attempts`,
        );
        return;
      }

      const delayMs = this.retryDelayMsForAttempt(attempt);
      if (this.closeDeadlineMs !== null) {
        const remainingMs = this.closeDeadlineMs - Date.now();
        if (remainingMs <= 0) return;
        await this.sleep(Math.min(delayMs, remainingMs));
      } else {
        await this.sleep(delayMs);
      }
    }
  }

  private retryDelayMsForAttempt(attempt: number): number {
    const exponential = this.retryBaseDelayMs * 2 ** Math.max(0, attempt - 1);
    return Math.min(this.retryMaxDelayMs, exponential);
  }

  private async sleep(ms: number): Promise<void> {
    if (ms <= 0) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
  }

  private isPastCloseDeadline(): boolean {
    return this.closeDeadlineMs !== null && Date.now() >= this.closeDeadlineMs;
  }

  private async deliverOnce(event: PublishEvent): Promise<boolean> {
    if (!this.callbackURL) return false;

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.callbackURL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...this.headers,
        },
        body: JSON.stringify({
          events: [
            {
              type: event.type,
              payload: event.payload,
              version: PIDNAP_EVENT_SCHEMA_VERSION,
            },
          ],
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${String(response.status)} ${response.statusText}`);
      }
      return true;
    } catch (error) {
      this.logger.warn(`Failed to deliver pidnap event "${event.type}"`, error);
      return false;
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}
