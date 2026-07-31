import type { StreamEventInput } from "iterate/sdk";
import { isKitDeviceId } from "./device-id.ts";
import type { ProviderNonPcmEvent } from "./pcm-proxy.ts";

export function kitDeviceEventStreamPath(deviceId: string): `/devices/${string}` {
  if (!isKitDeviceId(deviceId)) {
    throw new Error(`Invalid Iterate Kit device id: ${JSON.stringify(deviceId)}.`);
  }
  return `/devices/${deviceId}`;
}

/** Backwards-compatible name used by the retained Stick proof reader. */
export const DEFAULT_KIT_DEVICE_ID = "m5sticks3";
export const KIT_DEVICE_EVENT_STREAM_PATH = kitDeviceEventStreamPath(DEFAULT_KIT_DEVICE_ID);
export const KIT_PROVIDER_EVENT_STREAM_EVENT_TYPE = "events.iterate.com/kit/provider-event";

const maximumPendingEvents = 64;
const maximumPendingRawBytes = 256 * 1_024;
const maximumRawEventBytes = 64 * 1_024;
const maximumAppendBatchEvents = 8;

export interface ProviderEventStreamMetrics {
  appendFailures: number;
  appendedEvents: number;
  droppedEvents: number;
  lastAppendError: string | null;
  lastAppendedSequence: number;
  observedEvents: number;
  pendingEvents: number;
  pendingRawBytes: number;
  pendingRawHighWaterBytes: number;
}

interface QueuedProviderEvent {
  input: StreamEventInput;
  rawBytes: number;
  sequence: number;
}

export interface ProviderEventStreamDiagnostic {
  code: "provider-event-stream-append-failed" | "provider-event-stream-overflow";
  detail: Record<string, unknown>;
  severity: "error";
}

interface ProviderEventStreamJournalOptions {
  append(...events: StreamEventInput[]): Promise<unknown>;
  onDiagnostic?: (diagnostic: ProviderEventStreamDiagnostic) => void;
  waitUntil?: (promise: Promise<void>) => void;
}

/**
 * A bounded, best-effort journal for the provider's text lane.
 *
 * Stream storage is useful forensic evidence but is not part of the realtime
 * audio contract. Consequently `observe()` never awaits ITX, and exactly one
 * drain promise owns a small userspace queue. A failed append discards the
 * current diagnostic generation once, reports the exact loss, and lets a
 * later provider event make one fresh attempt; it cannot create an invisible
 * promise chain, an unbounded transcript, or backpressure on PCM handling.
 */
export class ProviderEventStreamJournal {
  readonly #append: (...events: StreamEventInput[]) => Promise<unknown>;
  readonly #onDiagnostic: (diagnostic: ProviderEventStreamDiagnostic) => void;
  readonly #waitUntil: (promise: Promise<void>) => void;
  readonly #queue: QueuedProviderEvent[] = [];
  #appendFailures = 0;
  #appendedEvents = 0;
  #drainPromise: Promise<void> | undefined;
  #droppedEvents = 0;
  #lastAppendError: string | null = null;
  #lastAppendedSequence = 0;
  #observedEvents = 0;
  #pendingRawBytes = 0;
  #pendingRawHighWaterBytes = 0;

  constructor(options: ProviderEventStreamJournalOptions) {
    this.#append = (...events) => options.append(...events);
    this.#onDiagnostic = options.onDiagnostic ?? (() => undefined);
    this.#waitUntil = options.waitUntil ?? (() => undefined);
  }

  observe(event: ProviderNonPcmEvent, sessionId: string, receivedAtMs = Date.now()): void {
    this.#observedEvents += 1;
    const sequence = this.#observedEvents;
    const rawBytes = new TextEncoder().encode(event.raw).byteLength;
    if (
      rawBytes > maximumRawEventBytes ||
      this.#queue.length >= maximumPendingEvents ||
      this.#pendingRawBytes + rawBytes > maximumPendingRawBytes
    ) {
      this.#droppedEvents += 1;
      this.#onDiagnostic({
        code: "provider-event-stream-overflow",
        detail: {
          maximumPendingEvents,
          maximumPendingRawBytes,
          maximumRawEventBytes,
          pendingEvents: this.#queue.length,
          pendingRawBytes: this.#pendingRawBytes,
          rawBytes,
          sequence,
          sessionId,
        },
        severity: "error",
      });
      return;
    }

    this.#queue.push({
      input: {
        idempotencyKey: `kit-provider-event:${sessionId}:${sequence}`,
        payload: {
          providerType: event.type,
          raw: event.raw,
          receivedAtMs,
          sequence,
          sessionId,
        },
        type: KIT_PROVIDER_EVENT_STREAM_EVENT_TYPE,
      },
      rawBytes,
      sequence,
    });
    this.#pendingRawBytes += rawBytes;
    this.#pendingRawHighWaterBytes = Math.max(
      this.#pendingRawHighWaterBytes,
      this.#pendingRawBytes,
    );
    this.#startDrain();
  }

  metrics(): ProviderEventStreamMetrics {
    return {
      appendFailures: this.#appendFailures,
      appendedEvents: this.#appendedEvents,
      droppedEvents: this.#droppedEvents,
      lastAppendError: this.#lastAppendError,
      lastAppendedSequence: this.#lastAppendedSequence,
      observedEvents: this.#observedEvents,
      pendingEvents: this.#queue.length,
      pendingRawBytes: this.#pendingRawBytes,
      pendingRawHighWaterBytes: this.#pendingRawHighWaterBytes,
    };
  }

  async settled(): Promise<void> {
    await this.#drainPromise;
  }

  #startDrain(): void {
    if (this.#drainPromise !== undefined) return;
    const drain = this.#drain().finally(() => {
      if (this.#drainPromise === drain) this.#drainPromise = undefined;
    });
    this.#drainPromise = drain;
    this.#waitUntil(drain);
  }

  async #drain(): Promise<void> {
    while (this.#queue.length > 0) {
      const batch = this.#queue.slice(0, maximumAppendBatchEvents);
      try {
        await this.#append(...batch.map((queued) => queued.input));
      } catch (error) {
        /*
         * The ITX session or stream may be unavailable as a generation ends.
         * Retrying that same queue forever would turn optional diagnostics
         * into memory pressure on live audio. Drop the explicitly counted
         * generation; the next observed event is allowed one fresh attempt.
         */
        const dropped = this.#queue.splice(0);
        this.#appendFailures += 1;
        this.#droppedEvents += dropped.length;
        this.#pendingRawBytes = 0;
        this.#lastAppendError = (error instanceof Error ? error.message : String(error)).slice(
          0,
          256,
        );
        this.#onDiagnostic({
          code: "provider-event-stream-append-failed",
          detail: {
            droppedEvents: dropped.length,
            message: this.#lastAppendError,
          },
          severity: "error",
        });
        return;
      }

      this.#queue.splice(0, batch.length);
      this.#pendingRawBytes -= batch.reduce((total, queued) => total + queued.rawBytes, 0);
      this.#appendedEvents += batch.length;
      this.#lastAppendedSequence = batch.at(-1)?.sequence ?? this.#lastAppendedSequence;
    }
  }
}
