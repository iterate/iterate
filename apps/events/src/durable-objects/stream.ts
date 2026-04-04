import { DurableObject } from "cloudflare:workers";
import {
  type DestroyStreamResult,
  type Event,
  Event as EventSchema,
  type EventInput,
  EventInput as EventInputSchema,
  type StreamMetadataUpdatedEvent,
  type StreamPath,
  StreamState,
} from "@iterate-com/events-contract";
import { getInitializedStreamStub, StreamOffsetPreconditionError } from "~/lib/stream-helpers.ts";
import { getAncestorStreamPaths } from "~/lib/stream-path-ancestors.ts";
/**
 *
 * IMPORTANT: This file should not be changed without explicit planning consent
 * from a human! It is actually relatively good!
 *
 * One stream per Durable Object: append-only event log in SQLite, a reduced
 * projection kept in memory and storage, and newline-delimited fanout for live
 * readers.
 *
 * Each stream must be initialized exactly once with its canonical path. That
 * initialization writes a synthetic `stream-initialized` event at offset 1,
 * so every initialized stream starts with the invariant:
 * - event at offset 1 is always `stream-initialized` for that stream's own path
 * - caller-appended events begin at offset 2
 *
 * Child discovery is a separate built-in event. After a stream commits its own
 * self-init event, it appends `child-stream-created` to every ancestor stream
 * in parallel.
 *
 * Durable Object docs:
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

  // Cloudflare recommends `blockConcurrencyWhile()` in the constructor for
  // schema setup and state hydration so requests never observe a half-initialized
  // actor: https://developers.cloudflare.com/durable-objects/api/state/
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    void this.ctx.blockConcurrencyWhile(async () => {
      this.ensureSchema();

      // Pull reduced state out of the database - we always keep it in memory
      // (we don't ever want all events in memory, because there might be LOTS of them)
      const persistedStateRow = this.ctx.storage.sql
        .exec<{ json: string }>("SELECT json FROM reduced_state WHERE singleton = 1")
        .next().value;

      if (persistedStateRow != null) {
        const parsed = StreamState.safeParse(JSON.parse(persistedStateRow.json));
        if (parsed.success) {
          this._state = parsed.data;
        } else {
          // Deliberately not crashing — throwing from the DO constructor makes
          // the object permanently unaddressable and much harder to debug.
          console.error(
            "[stream-do] persisted reduced_state failed StreamState validation, leaving _state null so initialize() can re-derive it",
            { error: parsed.error, raw: persistedStateRow.json },
          );
        }
      }
    });
  }

  /**
   * Ensures this stream exists. On the very first call, commits a synthetic
   * `stream-initialized` event at offset 1 through `append()`. Subsequent
   * calls are no-ops.
   *
   * Think of this like the durable object constructor. We take arguments like { path }
   * and set the initial state.
   *
   * All external callers go through `getInitializedStreamStub()` in
   * `~/lib/stream-helpers.ts`, which calls this before returning the stub.
   */
  initialize(args: { path: StreamPath }) {
    if (this._state != null) {
      return;
    }

    // Re-create tables if they were wiped by destroy() → deleteAll().
    // The constructor's blockConcurrencyWhile only runs once per DO lifetime.
    this.ensureSchema();

    this._state = {
      path: args.path,
      maxOffset: 0,
      metadata: {},
    };

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

  /**
   * Appends one event in three explicit phases:
   * 1. before append: resolve idempotency and run pre-append checks
   * 2. atomic append: write the row and reduced_state inside one transaction
   * 3. after append: publish the committed row and trigger post-commit side effects
   *
   * Per-event idempotency is stream-local: when an input includes an
   * `idempotencyKey` that already exists in this stream, we return the stored
   * event instead of creating a second row or advancing offsets/state.
   */
  append(inputEvent: EventInput): Event {
    const parsedInputEvent = EventInputSchema.parse(inputEvent);

    if (parsedInputEvent.idempotencyKey != null) {
      const existingEvent = this.getEventByIdempotencyKey(parsedInputEvent.idempotencyKey);
      if (existingEvent != null) {
        return existingEvent;
      }
    }

    if (
      parsedInputEvent.type === "https://events.iterate.com/events/stream/initialized" &&
      this.state.maxOffset > 0
    ) {
      throw new Error("stream-initialized may only be appended once");
    }

    const nextOffset = this.state.maxOffset + 1;

    if (parsedInputEvent.offset != null && parsedInputEvent.offset !== nextOffset) {
      throw new StreamOffsetPreconditionError(
        `Client-supplied offset ${parsedInputEvent.offset} does not match next generated offset ${nextOffset}.`,
      );
    }

    const event = {
      ...parsedInputEvent,
      streamPath: this.state.path,
      offset: nextOffset,
      createdAt: new Date().toISOString(),
    };

    const nextState = reduceStreamState({ state: this.state, event });

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
    });

    this._state = nextState;

    this.publish(event);

    switch (event.type) {
      case "https://events.iterate.com/events/stream/initialized": {
        this.appendToAncestorStreams({
          path: event.streamPath,
          eventInput: {
            type: "https://events.iterate.com/events/stream/child-stream-created",
            payload: { path: event.streamPath },
            metadata: event.metadata,
          },
        });
        break;
      }
    }
    return event;
  }

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
      finalState: stateBeforeDelete,
    };
  }

  /**
   * Reconstruct canonical events from trusted SQLite rows.
   *
   * We validate aggressively on append and trust stored rows on read so an older
   * row does not start throwing `Event.parse()` exceptions on every history or
   * live-stream read. The NDJSON consumer in `decodeEventStream()` still expects
   * newline-delimited JSON objects, but it skips malformed lines instead of
   * killing the whole live subscription.
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

  private appendToAncestorStreams(args: {
    path: StreamPath;
    eventInput: EventInput & { payload: { path: StreamPath } };
  }) {
    const ancestorPaths = getAncestorStreamPaths(args.path);
    if (ancestorPaths.length === 0) {
      return;
    }

    void Promise.all(
      ancestorPaths.map(async (path) => {
        const stream = await getInitializedStreamStub({ path });
        await stream.append(args.eventInput);
      }),
    ).catch((error) => {
      console.error("[stream-do] failed to propagate event to ancestor streams", {
        path: args.path,
        ancestorPaths,
        eventType: args.eventInput.type,
        error,
      });
    });
  }

  private parseEventRow(row: SqliteEventRow | null | undefined): Event | null {
    if (row == null) {
      return null;
    }
    return EventSchema.parse({
      streamPath: this.state.path,
      offset: row.offset,
      type: row.type,
      payload: JSON.parse(row.payload),
      metadata: row.metadata == null ? undefined : JSON.parse(row.metadata),
      idempotencyKey: row.idempotency_key ?? undefined,
      createdAt: row.created_at,
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

/**
 * Pure reducer for the persisted stream projection. Replay and append share the
 * same rules so state cannot drift based on which code path produced it.
 *
 * `initialize()` sets the initial state (with `maxOffset: 0`), then appends
 * the synthetic `stream-initialized` event through the normal `append()` path.
 * After that, `stream-metadata-updated` replaces the metadata snapshot and all
 * other events simply advance the max offset.
 */
function reduceStreamState(args: { state: StreamState; event: Event }): StreamState {
  const { state, event } = args;

  if (state.path !== event.streamPath) {
    throw new Error(
      `This should never happen. Somebody is trying to append an event to the wrong stream. Stream has path ${state.path}, but the event has path ${event.streamPath}.`,
    );
  }

  state.maxOffset++;

  switch (event.type) {
    case "https://events.iterate.com/events/stream/metadata-updated": {
      // TODO: Talk to Misha about how to express "built-in event or generic event"
      // without breaking payload narrowing here.
      const metadataUpdatedEvent = event as StreamMetadataUpdatedEvent;
      return {
        ...state,
        metadata: metadataUpdatedEvent.payload.metadata,
      };
    }

    default: {
      return state;
    }
  }
}
