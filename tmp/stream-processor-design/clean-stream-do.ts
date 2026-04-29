import { DurableObject } from "cloudflare:workers";
import type {
  BuiltinProcessor,
  StreamEvent,
  StreamEventInput,
} from "../../packages/shared/src/stream-processors/stream-processor.ts";
import {
  runProcessorAfterAppend,
  runProcessorReduce,
} from "../../packages/shared/src/stream-processors/stream-processor.ts";

/**
 * What `apps/events/src/durable-objects/stream.ts` might become after cleanup.
 *
 * This DO owns the append-only log and structural stream invariants. It hosts
 * only built-in processors that require beforeAppend or same-transaction state.
 */

type StreamCoreState = {
  projectSlug: string;
  path: string;
  eventCount: number;
  metadata: Record<string, unknown>;
  childPaths: string[];
};

type BuiltinSlot<Contract> = {
  processor: BuiltinProcessor<Contract>;
  state: unknown;
};

export class CleanStreamDO extends DurableObject {
  #coreState!: StreamCoreState;
  #builtinSlots: BuiltinSlot<unknown>[] = [];

  append(input: StreamEventInput): StreamEvent {
    const stored = this.#findByIdempotencyKey(input.idempotencyKey);
    if (stored != null) return stored;

    const nextOffset = this.#runBeforeAppend(input);
    const event = this.#materializeEvent({ input, offset: nextOffset });

    const nextCoreState = this.#reduceCore(event);
    const nextBuiltinSlots = this.#reduceBuiltinProcessors(event);

    this.#commit({
      event,
      coreState: nextCoreState,
      builtinSlots: nextBuiltinSlots,
    });

    this.#afterAppend(event);
    return event;
  }

  #runBeforeAppend(input: StreamEventInput): number {
    const nextOffset = this.#coreState.eventCount + 1;

    for (const slot of this.#builtinSlots) {
      slot.processor.implementation.beforeAppend?.({
        event: input,
        state: slot.state as never,
      });
    }

    return nextOffset;
  }

  #reduceCore(event: StreamEvent): StreamCoreState {
    switch (event.type) {
      case "https://events.iterate.com/events/stream/metadata-updated":
        return { ...this.#coreState, eventCount: event.offset, metadata: event.payload as never };
      default:
        return { ...this.#coreState, eventCount: event.offset };
    }
  }

  #reduceBuiltinProcessors(event: StreamEvent) {
    return this.#builtinSlots.map((slot) => {
      const reduction = runProcessorReduce({
        processor: slot.processor,
        event,
        state: slot.state as never,
      });
      return reduction == null ? slot : { ...slot, state: reduction.state };
    });
  }

  #commit(args: {
    event: StreamEvent;
    coreState: StreamCoreState;
    builtinSlots: BuiltinSlot<unknown>[];
  }) {
    /**
     * One transaction:
     * - insert event
     * - upsert reduced core state
     * - upsert built-in processor state slices
     */
    this.#coreState = args.coreState;
    this.#builtinSlots = args.builtinSlots;
  }

  #afterAppend(event: StreamEvent) {
    this.#publish(event);
    this.#propagateChildStreamCreated(event);

    for (const slot of this.#builtinSlots) {
      const promise = runProcessorAfterAppend({
        processor: slot.processor,
        event: event as never,
        previousState: slot.state as never,
        state: slot.state as never,
        streamApi: this.#builtinStreamApi() as never,
        signal: new AbortController().signal,
      });
      this.ctx.waitUntil(promise.catch(console.error));
    }
  }

  #materializeEvent(args: { input: StreamEventInput; offset: number }): StreamEvent {
    return {
      streamPath: this.#coreState.path,
      ...args.input,
      offset: args.offset,
      createdAt: new Date().toISOString(),
    };
  }

  #findByIdempotencyKey(_key: string | undefined): StreamEvent | null {
    return null;
  }

  #publish(_event: StreamEvent) {}

  #propagateChildStreamCreated(_event: StreamEvent) {}

  #builtinStreamApi() {
    return {
      append: async ({ event }: { event: StreamEventInput }) => this.append(event),
      read: async () => [],
      subscribe: async function* () {},
    };
  }
}

/**
 * Cleanup insight:
 *
 * Most current `stream.ts` logic is not processor logic. The parts that remain
 * core are:
 *
 * - idempotency table
 * - offset allocation
 * - SQLite transaction
 * - child stream propagation
 * - live subscriber fanout
 * - beforeAppend gates
 * - one Cloudflare alarm slot
 *
 * Everything else should move toward processor contracts.
 */
