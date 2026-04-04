import { DurableObject } from "cloudflare:workers";
import {
  type DestroyStreamResult,
  Event,
  EventInput,
  type StreamMetadataUpdatedEvent,
  StreamPath,
  StreamState,
} from "@iterate-com/events-contract";
import { circuitBreakerProcessor } from "./circuit-breaker.ts";
import { jsonataTransformerProcessor } from "./jsonata-transformer.ts";
import type { BuiltinProcessor } from "./define-processor.ts";
import { getInitializedStreamStub, StreamOffsetPreconditionError } from "~/lib/stream-helpers.ts";

type ProcessorSlugKey = keyof StreamState["processors"];

const processors: BuiltinProcessor[] = [circuitBreakerProcessor, jsonataTransformerProcessor];

function getProcessorState(state: StreamState, slug: string) {
  return state.processors[slug as ProcessorSlugKey];
}

/**
 * One stream per Durable Object: an append-only event log persisted in SQLite,
 * with a reduced in-memory projection and newline-delimited fanout for live
 * readers.
 *
 * ## Append lifecycle
 *
 * Every event passes through three phases that intentionally mirror the hooks
 * on `Processor` / `BuiltinProcessor` in `define-processor.ts`:
 *
 *   beforeAppend  →  reduce  →  afterAppend
 *
 * The stream core runs its own logic in each phase first (idempotency, offset
 * guards, eventCount, parent propagation), then delegates to the registered
 * builtin processors in the same phase. This is by design: the stream core is
 * effectively the "zeroth" processor, but its state lives at the top level of
 * StreamState (path, eventCount, metadata) rather than under
 * `state.processors`, because it owns structural invariants that are not
 * pluggable.
 *
 * ## Processor asymmetry
 *
 * The design intent is that _most_ stream functionality should be
 * implementable as a Processor — a pluggable unit with `reduce` and
 * `afterAppend` hooks that can, in principle, run across a network boundary
 * (reading the event stream remotely, then deciding whether to enact side
 * effects or append derived events back).
 *
 * BuiltinProcessors are a privileged subset that run in-process inside this
 * Durable Object. Because they share the single-threaded actor, they
 * additionally get a synchronous `beforeAppend` hook that can reject events
 * before they are committed (e.g. the circuit breaker).
 *
 * The stream core itself has a handful of responsibilities that sit outside
 * the processor model entirely — initialization, storage, offset sequencing,
 * and parent-tree propagation — because they are structural invariants of the
 * stream, not pluggable behavior.
 *
 * ## Pull subscriptions
 *
 * The `history()` and `stream()` methods expose the event log for pull-based
 * consumption. A remote consumer reads events, then either enacts external
 * side effects or appends derived events to this or other streams. Those
 * consumers are conceptually Processors (not BuiltinProcessors), since they
 * do not run synchronously inside this Durable Object.
 *
 * ## Cloudflare Durable Object docs
 *
 * - https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/
 * - https://developers.cloudflare.com/durable-objects/api/state/
 * - https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
 */
export class StreamDurableObject extends DurableObject<Env> {
  private _state: StreamState | null = null;
  private readonly subscribers = new Set<ReadableStreamDefaultController<Uint8Array>>();

  private get state(): StreamState {
    if (this._state == null) {
      throw new Error(
        "Stream durable object state was accessed before initialize({ path }) completed. Callers must use getInitializedStreamStub().",
      );
    }

    return this._state;
  }

  // ---------------------------------------------------------------------------
  // Construction & initialization
  // ---------------------------------------------------------------------------

  /**
   * Hydrates in-memory state from persisted SQLite and ensures the schema
   * exists. This is infrastructure-level bootstrapping — intentionally outside
   * the processor model, because processors depend on a fully initialized
   * stream to operate on.
   *
   * Cloudflare recommends `blockConcurrencyWhile()` in the constructor so
   * requests never observe a half-initialized actor.
   * https://developers.cloudflare.com/durable-objects/api/state/
   */
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    void this.ctx.blockConcurrencyWhile(async () => {
      this.ensureSchema();

      const persistedStateRow = this.ctx.storage.sql
        .exec<{ json: string }>("SELECT json FROM reduced_state WHERE singleton = 1")
        .next().value;

      if (persistedStateRow == null) {
        return;
      }

      const rawState = JSON.parse(persistedStateRow.json);
      const parsed = StreamState.safeParse(rawState);
      if (parsed.success) {
        this._state = parsed.data;

        try {
          this.append({
            type: "https://events.iterate.com/events/stream/durable-object-constructed",
            payload: {},
          });
        } catch (error) {
          console.error(
            "[stream-do] failed to append durable-object-constructed after rehydration",
            {
              path: parsed.data.path,
              error,
            },
          );
          throw error;
        }

        return;
      }

      // Deliberately not crashing — throwing from the DO constructor makes
      // the object permanently unaddressable and much harder to debug.
      console.error(
        "[stream-do] persisted reduced_state failed validation, leaving _state null so initialize() can re-derive it",
        { error: parsed.error, raw: persistedStateRow.json },
      );
    });
  }

  /**
   * Ensures this stream exists. On the very first call, commits a synthetic
   * `stream-initialized` event at offset 1 through `append()`. Subsequent
   * calls are no-ops.
   *
   * Think of this like the durable object constructor. We take arguments like
   * { path } and set the initial state.
   *
   * All external callers go through `getInitializedStreamStub()` in
   * `~/lib/stream-helpers.ts`, which calls this before returning the stub.
   */
  initialize(args: { path: StreamPath }) {
    if (this._state != null) {
      return;
    }

    this.ensureSchema();

    const processorState: Record<string, Record<string, unknown>> = {};
    for (const processor of processors) {
      processorState[processor.slug] = structuredClone(processor.initialState);
    }

    this._state = {
      path: args.path,
      eventCount: 0,
      metadata: {},
      processors: processorState,
    } as StreamState;

    try {
      this.append({
        type: "https://events.iterate.com/events/stream/initialized",
        payload: { path: args.path },
      });
    } catch (error) {
      this._state = null;
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Append lifecycle
  //
  // The four methods below — append, beforeAppend, reduce, afterAppend —
  // mirror the hook structure on BuiltinProcessor in define-processor.ts.
  //
  // In each phase the stream core runs its own privileged logic first, then
  // delegates to the registered builtin processors. This symmetry is
  // intentional: the stream core is effectively the "zeroth" processor, but
  // its state lives at the top level of StreamState rather than under
  // `state.processors`, because it owns structural invariants (path,
  // eventCount, initialization, parent propagation) that are not pluggable.
  // ---------------------------------------------------------------------------

  /**
   * Public entry point for appending an event. Handles idempotency up front,
   * then orchestrates the three lifecycle phases and the atomic SQLite commit:
   *
   *   parse → idempotency check → beforeAppend → build event → reduce → commit → afterAppend
   */
  append(inputEvent: EventInput): Event {
    const input = EventInput.parse(inputEvent);

    if (input.idempotencyKey != null) {
      const existingEvent = this.getEventByIdempotencyKey(input.idempotencyKey);
      if (existingEvent != null) return existingEvent;
    }

    const nextOffset = this.beforeAppend(input);

    const event = {
      streamPath: this.state.path,
      ...input,
      offset: nextOffset,
      createdAt: new Date().toISOString(),
    };

    const nextState = this.reduce(event);

    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO events (offset, type, payload, metadata, idempotency_key, created_at)
         VALUES (?, ?, json(?), ?, ?, ?)`,
        event.offset,
        event.type,
        JSON.stringify(event.payload),
        event.metadata === undefined ? null : JSON.stringify(event.metadata),
        event.idempotencyKey ?? null,
        event.createdAt,
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO reduced_state (singleton, json)
         VALUES (1, json(?))
         ON CONFLICT(singleton) DO UPDATE SET json = excluded.json`,
        JSON.stringify(nextState),
      );
      this._state = nextState;
    });

    this.afterAppend(event);

    return event;
  }

  /**
   * Validate-or-throw boundary. Enforces core invariants and runs builtin
   * processor gates before any state mutation occurs:
   *
   * 1. Core invariants: stream-initialized uniqueness, offset precondition.
   * 2. Builtin processor beforeAppend hooks (e.g. circuit-breaker rejection).
   *
   * Returns the next offset to use. Idempotency is handled by `append()`
   * before this method is called — by the time we get here, the input is
   * known to be a genuinely new event.
   */
  private beforeAppend(input: EventInput): number {
    if (
      input.type === "https://events.iterate.com/events/stream/initialized" &&
      this.state.eventCount > 0
    ) {
      throw new Error("stream-initialized may only be appended once");
    }

    const nextOffset = this.state.eventCount + 1;

    if (input.offset != null && input.offset !== nextOffset) {
      throw new StreamOffsetPreconditionError(
        `Client-supplied offset ${input.offset} does not match next generated offset ${nextOffset}.`,
      );
    }

    for (const processor of processors) {
      processor.beforeAppend?.({
        event: input,
        state: getProcessorState(this.state, processor.slug),
      });
    }

    return nextOffset;
  }

  /**
   * Pure reduction: computes the next StreamState from the current state and
   * the committed event, without performing any I/O.
   *
   * Core stream state (eventCount, metadata) is reduced first, then each
   * builtin processor reduces its own slice under `state.processors`. This
   * mirrors the processor `reduce` hook but for the privileged top-level
   * fields that are not modeled as processor state.
   */
  private reduce(event: Event): StreamState {
    if (this.state.path !== event.streamPath) {
      throw new Error(
        `This should never happen. Somebody is trying to append an event to the wrong stream. Stream has path ${this.state.path}, but the event has path ${event.streamPath}.`,
      );
    }

    // --- Core stream state ---
    let nextState: StreamState = {
      ...structuredClone(this.state),
      eventCount: this.state.eventCount + 1,
    };

    switch (event.type) {
      case "https://events.iterate.com/events/stream/metadata-updated": {
        // TODO get type narrowing working properly here without cast
        const metadataUpdatedEvent = event as StreamMetadataUpdatedEvent;
        nextState = { ...nextState, metadata: metadataUpdatedEvent.payload.metadata };
        break;
      }
    }

    // --- Builtin processors ---
    for (const processor of processors) {
      if (processor.reduce) {
        const nextSlice = processor.reduce({
          event,
          state: getProcessorState(nextState, processor.slug),
        });
        nextState = {
          ...nextState,
          processors: { ...nextState.processors, [processor.slug]: nextSlice },
        };
      }
    }

    return nextState;
  }

  /**
   * Post-commit side effects, in order:
   *
   * 1. Subscriber fanout: push the committed event to all live pull-subscription
   *    readers connected via `stream()`.
   *
   * 2. Core propagation: after `stream-initialized`, notify the parent stream
   *    with `child-stream-created`. After `child-stream-created`, re-propagate
   *    it one level up. This is a structural concern of the stream tree, not
   *    something a pluggable processor should own.
   *
   * 3. Builtin processor afterAppend hooks: each processor may inspect the
   *    committed event and its own state slice, then optionally append derived
   *    events back into this stream (e.g. circuit-breaker auto-pause, JSONata
   *    transformer output).
   */
  private afterAppend(event: Event) {
    // --- Subscriber fanout ---
    this.publish(event);

    // --- Core: parent-tree propagation ---
    switch (event.type) {
      case "https://events.iterate.com/events/stream/initialized": {
        this.appendToParent({
          type: "https://events.iterate.com/events/stream/child-stream-created",
          payload: { childPath: this.state.path },
          metadata: event.metadata,
        });
        break;
      }
      case "https://events.iterate.com/events/stream/child-stream-created": {
        this.appendToParent({
          type: event.type,
          payload: event.payload,
          metadata: event.metadata,
        });
        break;
      }
    }

    // --- Builtin processor hooks ---
    for (const processor of processors) {
      const result = processor.afterAppend?.({
        append: (nextEvent) => this.append(nextEvent),
        event,
        state: getProcessorState(this.state, processor.slug),
      });

      if (result == null) {
        continue;
      }

      void result.catch((error) => {
        console.error("[stream-do] processor afterAppend failed", {
          path: this.state.path,
          processor: processor.slug,
          eventType: event.type,
          error,
        });
      });
    }
  }

  // ---------------------------------------------------------------------------
  // State & lifecycle
  // ---------------------------------------------------------------------------

  getState(): StreamState {
    return this.state;
  }

  // Cloudflare's supported way to wipe a Durable Object's persisted data is
  // `deleteAll()` on its storage rather than an explicit instance-destruction API:
  // https://developers.cloudflare.com/durable-objects/api/storage-api/
  // https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/
  async destroy(): Promise<DestroyStreamResult> {
    const stateBeforeDelete = structuredClone(this._state);

    for (const subscriber of this.subscribers) {
      try {
        subscriber.close();
      } catch {}
    }
    this.subscribers.clear();

    await this.ctx.storage.deleteAll();

    this._state = null;

    return {
      destroyed: true,
      finalState: stateBeforeDelete ?? null,
    };
  }

  // ---------------------------------------------------------------------------
  // Pull subscriptions
  //
  // These methods expose the event log for remote consumers that pull events
  // over the network and then either enact external side effects or append
  // derived events to this or other streams.
  //
  // Those consumers are conceptually Processors — they have the same
  // reduce/afterAppend shape — but they are not BuiltinProcessors, because
  // they do not run synchronously inside this Durable Object and cannot
  // participate in the synchronous beforeAppend gate.
  // ---------------------------------------------------------------------------

  /**
   * Reconstruct canonical events from trusted SQLite rows.
   *
   * We validate aggressively on append and trust stored rows on read so an
   * older row does not start throwing `Event.parse()` exceptions on every
   * history or live-stream read. The NDJSON consumer in `decodeEventStream()`
   * still expects newline-delimited JSON objects, but it skips malformed lines
   * instead of killing the whole live subscription.
   */
  history(args: { afterOffset?: number } = {}): Event[] {
    const afterOffset = args.afterOffset ?? 0;

    return this.ctx.storage.sql
      .exec<SqliteEventRow>(
        `SELECT * FROM events WHERE offset > ? ORDER BY offset ASC`,
        afterOffset,
      )
      .toArray()
      .flatMap((row) => {
        const event = this.parseEventRow(row);
        return event ? [event] : [];
      });
  }

  /**
   * Returns newline-delimited JSON so backlog and live events share the same
   * framing as `decodeEventStream()` in `~/lib/utils.ts`.
   */
  stream(args: { afterOffset?: number; live?: boolean } = {}): ReadableStream<Uint8Array> {
    const backlog = this.history(args);
    let subscriber: ReadableStreamDefaultController<Uint8Array> | undefined;

    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        for (const event of backlog) {
          controller.enqueue(encodeEventLine(event));
        }

        if (!args.live) {
          controller.close();
          return;
        }

        subscriber = controller;
        this.subscribers.add(controller);
      },
      cancel: () => {
        if (subscriber) {
          this.subscribers.delete(subscriber);
        }
      },
    });
  }

  private publish(event: Event) {
    const chunk = encodeEventLine(event);

    for (const subscriber of this.subscribers) {
      try {
        subscriber.enqueue(chunk);
      } catch {
        this.subscribers.delete(subscriber);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Storage & helpers
  // ---------------------------------------------------------------------------

  private ensureSchema() {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS events (
        offset INTEGER PRIMARY KEY,
        type TEXT NOT NULL,
        payload TEXT NOT NULL CHECK(json_valid(payload)),
        metadata TEXT CHECK(metadata IS NULL OR (json_valid(metadata) AND json_type(metadata) = 'object')),
        idempotency_key TEXT UNIQUE,
        created_at TEXT NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS reduced_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        json TEXT NOT NULL CHECK(json_valid(json))
      )
    `);
  }

  private getEventByIdempotencyKey(idempotencyKey: string) {
    const row = this.ctx.storage.sql
      .exec<SqliteEventRow>(
        `SELECT * FROM events WHERE idempotency_key = ? LIMIT 1`,
        idempotencyKey,
      )
      .next().value;

    return this.parseEventRow(row);
  }

  private appendToParent(eventInput: EventInput) {
    const path = this.state.path;
    if (path === "/") {
      return;
    }

    const lastSlashIndex = path.lastIndexOf("/");
    const parentPath = lastSlashIndex === 0 ? "/" : StreamPath.parse(path.slice(0, lastSlashIndex));

    void getInitializedStreamStub({ path: parentPath })
      .then((parent) => parent.append(eventInput))
      .catch((error) => {
        console.error("[stream-do] failed to propagate event to parent stream", {
          path: this.state.path,
          eventType: eventInput.type,
          error,
        });
      });
  }

  private parseEventRow(row: SqliteEventRow | null | undefined): Event | null {
    if (row == null) {
      return null;
    }
    return {
      streamPath: this.state.path,
      offset: row.offset,
      type: row.type,
      payload: JSON.parse(row.payload),
      metadata: row.metadata == null ? undefined : JSON.parse(row.metadata),
      idempotencyKey: row.idempotency_key ?? undefined,
      createdAt: row.created_at,
    } as Event;
  }
}

const textEncoder = new TextEncoder();

function encodeEventLine(event: Event) {
  return textEncoder.encode(`${JSON.stringify(event)}\n`);
}

type SqliteEventRow = {
  offset: number;
  type: string;
  payload: string;
  metadata: string | null;
  idempotency_key: string | null;
  created_at: string;
};
