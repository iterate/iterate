import { DurableObject } from "cloudflare:workers";
import {
  type ChildStreamCreatedEvent,
  type DestroyStreamResult,
  type Event,
  Event as EventSchema,
  type EventInput,
  EventInput as EventInputSchema,
  type ProjectSlug,
  StreamInitializedEvent,
  type StreamMetadataUpdatedEvent,
  type StreamPath,
  StreamState,
} from "@iterate-com/events-contract";
import { getAncestorStreamPaths } from "~/lib/stream-path-ancestors.ts";
import { getStreamStub, StreamOffsetPreconditionError } from "~/lib/stream-helpers.ts";

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
        "Stream durable object state was accessed before initialize({ projectSlug, path }) completed. Callers must use getInitializedStreamStub().",
      );
    }

    return this._state;
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    void this.ctx.blockConcurrencyWhile(async () => {
      this.ensureSchema();

      const persistedStateRow = this.ctx.storage.sql
        .exec<{ json: string }>("SELECT json FROM reduced_state WHERE singleton = 1")
        .next().value;

      if (persistedStateRow != null) {
        const parsed = StreamState.safeParse(JSON.parse(persistedStateRow.json));
        if (parsed.success) {
          this._state = parsed.data;
        } else {
          console.error(
            "[stream-do] persisted reduced_state failed StreamState validation, leaving _state null so initialize() can re-derive it",
            { error: parsed.error, raw: persistedStateRow.json },
          );
        }
      }
    });
  }

  initialize(args: { projectSlug: ProjectSlug; path: StreamPath }) {
    if (this._state != null) {
      return;
    }

    this.ensureSchema();

    this._state = {
      projectSlug: args.projectSlug,
      path: args.path,
      maxOffset: 0,
      metadata: {},
      children: [],
    };

    try {
      this.append({
        type: "https://events.iterate.com/events/stream/initialized",
        payload: { projectSlug: args.projectSlug, path: args.path },
      });
    } catch (error) {
      this._state = null;
      throw error;
    }
  }

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

    if (event.type === "https://events.iterate.com/events/stream/initialized") {
      const ancestorPaths = getAncestorStreamPaths(event.streamPath);

      if (ancestorPaths.length > 0) {
        void Promise.all(
          ancestorPaths.map(async (path) => {
            const stream = await this.getInitializedStreamStub(path);
            await stream.append({
              type: "https://events.iterate.com/events/stream/child-stream-created",
              payload: { path: event.streamPath },
              metadata: event.metadata,
            });
          }),
        ).catch((error) => {
          console.error("[stream-do] failed to propagate event to ancestor streams", {
            path: event.streamPath,
            ancestorPaths,
            eventType: "https://events.iterate.com/events/stream/child-stream-created",
            error,
          });
        });
      }
    }

    return event;
  }

  getState(): StreamState {
    return this.state;
  }

  async destroy(args: { destroyChildren?: boolean } = {}): Promise<DestroyStreamResult> {
    const childEntries = args.destroyChildren ? await this.destroyChildStreams() : {};

    const path = this._state?.path;
    const finalState = structuredClone(this._state);

    for (const subscriber of this.subscribers) {
      try {
        subscriber.close();
      } catch {}
    }
    this.subscribers.clear();
    await this.ctx.storage.deleteAll();
    this._state = null;

    const finalStateByPath: DestroyStreamResult["finalStateByPath"] = {
      ...childEntries,
      ...(path != null ? { [path]: { finalState } } : {}),
    };

    return {
      destroyedStreamCount: Object.keys(finalStateByPath).length,
      finalStateByPath,
    };
  }

  history(args: { afterOffset?: number } = {}): Event[] {
    if (this._state == null) {
      return [];
    }

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

  listChildren() {
    return [...(this._state?.children ?? [])].sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt),
    );
  }

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

  private async getInitializedStreamStub(path: StreamPath) {
    const stub = getStreamStub({
      projectSlug: this.state.projectSlug,
      path,
    });
    await stub.initialize({
      projectSlug: this.state.projectSlug,
      path,
    });
    return stub;
  }

  private async destroyChildStreams(): Promise<DestroyStreamResult["finalStateByPath"]> {
    const childPaths = (this._state?.children ?? [])
      .map(({ path }) => path)
      .sort((left, right) => right.length - left.length);

    const results = await Promise.all(
      childPaths.map(async (path) => {
        const stub = await this.getInitializedStreamStub(path);
        return stub.destroy();
      }),
    );

    return results.reduce<DestroyStreamResult["finalStateByPath"]>(
      (acc, { finalStateByPath }) => ({ ...acc, ...finalStateByPath }),
      {},
    );
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
    const line = encodeEventLine(event);

    for (const subscriber of this.subscribers) {
      try {
        subscriber.enqueue(line);
      } catch {
        this.subscribers.delete(subscriber);
      }
    }
  }
}

/**
 * Pure reducer for the persisted stream projection. Replay and append share the
 * same rules so state cannot drift based on which code path produced it.
 *
 * `initialize()` sets the initial state, then appends the synthetic
 * `stream-initialized` event through the normal `append()` path.
 */
function reduceStreamState(args: { state: StreamState; event: Event }): StreamState {
  const { state, event } = args;

  if (state.path !== event.streamPath) {
    throw new Error(
      `This should never happen. Somebody is trying to append an event to the wrong stream. Stream has path ${state.path}, but the event has path ${event.streamPath}.`,
    );
  }

  const base = { ...state, maxOffset: event.offset };

  switch (event.type) {
    case "https://events.iterate.com/events/stream/metadata-updated": {
      const metadataUpdatedEvent = event as StreamMetadataUpdatedEvent;
      return { ...base, metadata: metadataUpdatedEvent.payload.metadata };
    }

    case "https://events.iterate.com/events/stream/child-stream-created": {
      const childEvent = event as ChildStreamCreatedEvent;
      const alreadyTracked = base.children.some((child) => child.path === childEvent.payload.path);
      if (alreadyTracked) {
        return base;
      }

      return {
        ...base,
        children: [...base.children, { path: childEvent.payload.path, createdAt: event.createdAt }],
      };
    }

    default:
      return base;
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
