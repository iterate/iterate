import type { StreamEvent } from "iterate/processors";
import type { SizedStreamEvent } from "./stream-storage.ts";

/**
 * Ephemeral event bodies live only for the lifetime of one Stream Durable
 * Object incarnation. This byte budget bounds the JSON represented by those
 * events; JavaScript object overhead is additional and intentionally reported
 * separately from SQLite storage.
 */
const EPHEMERAL_EVENT_BUFFER_MAX_BYTES = 10 * 1024 * 1024;

const textEncoder = new TextEncoder();

/** Memory use and FIFO eviction totals for one Durable Object incarnation. */
export type EphemeralEventBufferRuntimeState = {
  maxBytes: number;
  bytes: number;
  eventCount: number;
  oldestOffset?: number;
  newestOffset?: number;
  evictedEventCount: number;
  evictedBytes: number;
};

/** A bounded, offset-ordered, memory-only buffer of ephemeral events. */
export class EphemeralEventBuffer {
  readonly #maxBytes: number;
  #events: Array<SizedStreamEvent | undefined> = [];
  #head = 0;
  #bytes = 0;
  #evictedEventCount = 0;
  #evictedBytes = 0;

  constructor(maxBytes = EPHEMERAL_EVENT_BUFFER_MAX_BYTES) {
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
      throw new Error("ephemeral event buffer maxBytes must be a positive integer");
    }
    this.#maxBytes = maxBytes;
  }

  /**
   * Size and validate events without mutating the buffer. The append commit
   * path calls this before its SQLite writes so an oversized event rejects the
   * entire append batch before offsets are consumed.
   */
  prepare(events: readonly StreamEvent[]): SizedStreamEvent[] {
    return events.map((event) => {
      if (event.ephemeral !== true) {
        throw new Error("the ephemeral event buffer only accepts ephemeral events");
      }
      const byteLength = textEncoder.encode(JSON.stringify(event)).byteLength;
      if (byteLength > this.#maxBytes) {
        throw new Error(
          `ephemeral event at offset ${event.offset} is ${byteLength} bytes; the memory-only limit is ${this.#maxBytes} bytes`,
        );
      }
      return { event, byteLength };
    });
  }

  /** Add already-validated events and discard the oldest until within budget. */
  commit(events: readonly SizedStreamEvent[]): void {
    for (const sized of events) {
      this.#events.push(sized);
      this.#bytes += sized.byteLength;
      // Trim after every addition instead of temporarily retaining the whole
      // append batch. A caller may append more than one buffer's worth at
      // once; active sessions can receive that batch, while replay retains
      // only its newest suffix.
      while (this.#bytes > this.#maxBytes) {
        const evicted = this.#events[this.#head];
        if (!evicted) {
          throw new Error("ephemeral event buffer byte accounting became inconsistent");
        }
        this.#events[this.#head] = undefined;
        this.#head += 1;
        this.#bytes -= evicted.byteLength;
        this.#evictedEventCount += 1;
        this.#evictedBytes += evicted.byteLength;
      }
    }
    // Release the consumed array prefix periodically. Clearing each slot above
    // releases event bodies immediately; batching the array copy keeps FIFO
    // eviction amortized instead of making every eviction shift the full list.
    if (this.#head >= 1_024) {
      this.#events = this.#events.slice(this.#head);
      this.#head = 0;
    }
  }

  getByOffset(offset: number): StreamEvent | undefined {
    for (let index = this.#head; index < this.#events.length; index += 1) {
      const entry = this.#events[index];
      if (!entry) continue;
      if (entry.event.offset === offset) return entry.event;
      if (entry.event.offset > offset) return undefined;
    }
    return undefined;
  }

  getRangeSized(args: {
    afterOffset: number;
    beforeOffset: number;
    eventTypes?: readonly string[];
    limit: number;
  }): SizedStreamEvent[] {
    if (args.eventTypes?.length === 0) return [];
    const eventTypes =
      !args.eventTypes || args.eventTypes.includes("*") ? undefined : new Set(args.eventTypes);
    const selected: SizedStreamEvent[] = [];
    for (let index = this.#head; index < this.#events.length; index += 1) {
      const entry = this.#events[index];
      if (!entry) continue;
      const event = entry.event;
      if (event.offset <= args.afterOffset) continue;
      if (event.offset >= args.beforeOffset) break;
      if (eventTypes && !eventTypes.has(event.type)) continue;
      selected.push(entry);
      if (selected.length === args.limit) break;
    }
    return selected;
  }

  runtimeState(): EphemeralEventBufferRuntimeState {
    return {
      maxBytes: this.#maxBytes,
      bytes: this.#bytes,
      eventCount: this.#events.length - this.#head,
      oldestOffset: this.#events[this.#head]?.event.offset,
      newestOffset: this.#events.at(-1)?.event.offset,
      evictedEventCount: this.#evictedEventCount,
      evictedBytes: this.#evictedBytes,
    };
  }
}
