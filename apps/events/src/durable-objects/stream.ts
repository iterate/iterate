import { DurableObject } from "cloudflare:workers";
import { getNextEventOffset } from "@iterate-com/shared/events/offset";
import {
  Event,
  Offset,
  StreamPath,
  StreamMetadataUpdatedPayload,
  StreamState,
  STREAM_CREATED_TYPE,
  STREAM_METADATA_UPDATED_TYPE,
  type EventInput,
} from "@iterate-com/events-contract";
import { ROOT_STREAM_PATH, getParentPath } from "~/lib/utils.ts";
const textEncoder = new TextEncoder();

/**
 * One stream per Durable Object: append-only event log in SQLite, a reduced
 * projection kept in memory and storage, and newline-delimited fanout for live
 * readers.
 *
 * The matching router in `~/orpc/routers/streams.ts` stamps a validated `path`
 * onto every append because we still do not treat `ctx.id.name` as
 * constructor-safe enough for this projection.
 *
 * Durable Object docs:
 * - https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/
 * - https://developers.cloudflare.com/durable-objects/api/state/
 * - https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
 */
export class StreamDurableObject extends DurableObject<Env> {
  private state: StreamState = {
    path: null,
    lastOffset: null,
    eventCount: 0,
    metadata: {},
  };
  private readonly subscribers = new Set<ReadableStreamDefaultController<Uint8Array>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Cloudflare recommends `blockConcurrencyWhile()` in the constructor for
    // schema setup and state hydration so requests never observe a half-initialized
    // actor: https://developers.cloudflare.com/durable-objects/api/state/
    void this.ctx.blockConcurrencyWhile(async () => {
      this.initializeStorage();
      this.state = this.loadState();
    });
  }

  /**
   * Appends a batch in three explicit phases:
   * 1. before append: resolve idempotency, run pre-append checks, and plan rows
   * 2. atomic append: write planned rows and reduced_state inside one transaction
   * 3. after append: publish committed rows and trigger post-commit side effects
   *
   * Per-event idempotency is stream-local: when an input includes an
   * `idempotencyKey` that already exists in this stream, we return the stored
   * event instead of creating a second row or advancing offsets/state.
   *
   * Durable Objects are single-threaded per object instance, and Cloudflare
   * documents that synchronous writes with no intervening `await` are atomic.
   * That lets us preflight the batch first, then keep the transaction focused
   * on writes only:
   * - https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
   * - https://developers.cloudflare.com/durable-objects/api/storage-api/
   */
  async append(args: { events: EventInput[] }) {
    if (args.events.length === 0) {
      throw new Error("At least one event is required.");
    }

    const prevState = structuredClone(this.state);
    let state = structuredClone(prevState);
    const events: Event[] = [];
    const insertedEvents: Event[] = [];
    const plannedEventsByIdempotencyKey = new Map<string, Event>();

    // Before append: plan the batch and run checks before any writes happen.
    for (const inputEvent of args.events) {
      const existingEvent =
        inputEvent.idempotencyKey == null
          ? null
          : (plannedEventsByIdempotencyKey.get(inputEvent.idempotencyKey) ??
            this.getEventByIdempotencyKey({
              path: inputEvent.path,
              idempotencyKey: inputEvent.idempotencyKey,
            }));

      if (existingEvent != null) {
        events.push(existingEvent);
        continue;
      }

      const nextOffset = Offset.parse(getNextEventOffset(state.lastOffset));

      // Future pre-append checks belong here, before the transaction begins.
      if (inputEvent.offset != null && inputEvent.offset !== nextOffset) {
        return {
          kind: "offset-precondition-failed" as const,
          message: `Client-supplied offset ${inputEvent.offset} does not match next generated offset ${nextOffset}.`,
        };
      }

      const insertedEvent = this.buildInsertedEvent({
        inputEvent,
        offset: nextOffset,
      });

      events.push(insertedEvent);
      insertedEvents.push(insertedEvent);
      state = reduceStreamState({
        state,
        event: insertedEvent,
      });

      if (insertedEvent.idempotencyKey != null) {
        plannedEventsByIdempotencyKey.set(insertedEvent.idempotencyKey, insertedEvent);
      }
    }

    // Atomic append: writes only. Any throw here should be a real failure.
    this.ctx.storage.transactionSync(() => {
      for (const insertedEvent of insertedEvents) {
        this.insertEventRowSync(insertedEvent);
      }

      this.writeReducedStateSync(state);
    });

    // After append: only committed side effects belong below this line.
    this.state = structuredClone(state);

    for (const event of insertedEvents) {
      this.publish(event);
    }

    if (prevState.eventCount === 0 && insertedEvents[0] != null) {
      this.propagateStreamCreated(insertedEvents[0]);
    }

    return {
      kind: "ok" as const,
      events,
    };
  }

  async getState(): Promise<StreamState> {
    return structuredClone(this.state);
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
  async history(args: { afterOffset?: string } = {}): Promise<Event[]> {
    if (this.state.path == null) {
      if (this.state.eventCount === 0) {
        return [];
      }

      throw new Error(
        "Stream durable object cannot read events before its reduced path is initialized.",
      );
    }

    const path = this.state.path;
    return this.listEventsAfterOffset({
      path,
      afterOffset: args.afterOffset ?? "",
    });
  }

  /**
   * Returns newline-delimited JSON so backlog and live events share the same
   * framing as `decodeEventStream()` in `~/lib/utils.ts`.
   */
  async stream(
    args: { afterOffset?: string; live?: boolean } = {},
  ): Promise<ReadableStream<Uint8Array>> {
    const backlogPromise = this.history(args);
    let subscriber: ReadableStreamDefaultController<Uint8Array> | undefined;

    return new ReadableStream<Uint8Array>({
      start: async (controller) => {
        const backlog = await backlogPromise;
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

  /**
   * `events` is the append-only log; `reduced_state` is the fast projection we
   * can return from `getState()` without replaying the whole stream on every
   * request.
   */
  private initializeStorage() {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS events (
        offset TEXT PRIMARY KEY,
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

  /**
   * Hydrates in-memory state from the reduced projection and cross-checks it
   * against the append-only log so corruption fails fast instead of silently
   * leaking inconsistent reads.
   */
  private loadState() {
    const eventRowCount =
      this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM events").one()
        ?.count ?? 0;
    const persistedStateRow = this.ctx.storage.sql
      .exec<{ json: string }>("SELECT json FROM reduced_state WHERE singleton = 1")
      .next().value;

    if (persistedStateRow == null) {
      if (eventRowCount === 0) {
        return {
          path: null,
          lastOffset: null,
          eventCount: 0,
          metadata: {},
        } satisfies StreamState;
      }

      throw new Error(
        "Stream durable object is missing reduced_state even though events exist. This object is in a broken state.",
      );
    }

    const persistedState = StreamState.parse(JSON.parse(persistedStateRow.json));
    if (persistedState.eventCount !== eventRowCount) {
      throw new Error(
        `Persisted reduced_state eventCount ${persistedState.eventCount} does not match ${eventRowCount} event rows.`,
      );
    }

    if (persistedState.eventCount > 0 && persistedState.path == null) {
      throw new Error("Persisted reduced_state is missing a path even though events exist.");
    }

    if (persistedState.eventCount > 0 && persistedState.lastOffset == null) {
      throw new Error("Persisted reduced_state is missing lastOffset even though events exist.");
    }

    return structuredClone(persistedState);
  }

  private buildInsertedEvent(args: { inputEvent: EventInput; offset: string }) {
    const { inputEvent, offset } = args;

    return Event.parse({
      path: inputEvent.path,
      offset,
      type: inputEvent.type,
      payload: inputEvent.payload,
      metadata: inputEvent.metadata,
      idempotencyKey: inputEvent.idempotencyKey,
      createdAt: new Date().toISOString(),
    });
  }

  private insertEventRowSync(event: Event) {
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
  }

  private writeReducedStateSync(state: StreamState) {
    this.ctx.storage.sql.exec(
      `INSERT INTO reduced_state (singleton, json)
       VALUES (1, json(?))
       ON CONFLICT(singleton) DO UPDATE SET json = excluded.json`,
      JSON.stringify(state),
    );
  }

  private listEventsAfterOffset(args: { path: StreamPath; afterOffset: string }) {
    const { path, afterOffset } = args;

    return this.ctx.storage.sql
      .exec<{
        offset: string;
        type: string;
        payload: string;
        metadata: string | null;
        idempotency_key: string | null;
        created_at: string;
      }>(
        `SELECT offset, type, payload, metadata, idempotency_key, created_at
        FROM events
        WHERE offset > ?
        ORDER BY offset ASC`,
        afterOffset,
      )
      .toArray()
      .map((row) =>
        Event.parse({
          path,
          offset: row.offset,
          type: row.type,
          payload: JSON.parse(row.payload),
          ...(row.metadata == null ? {} : { metadata: JSON.parse(row.metadata) }),
          ...(row.idempotency_key == null ? {} : { idempotencyKey: row.idempotency_key }),
          createdAt: row.created_at,
        }),
      );
  }

  private getEventByIdempotencyKey(args: { path: StreamPath; idempotencyKey: string }) {
    const { path, idempotencyKey } = args;

    const row = this.ctx.storage.sql
      .exec<{
        offset: string;
        type: string;
        payload: string;
        metadata: string | null;
        idempotency_key: string | null;
        created_at: string;
      }>(
        `SELECT offset, type, payload, metadata, idempotency_key, created_at
         FROM events
         WHERE idempotency_key = ?
         LIMIT 1`,
        idempotencyKey,
      )
      .next().value;

    if (row == null) {
      return null;
    }

    return Event.parse({
      path,
      offset: row.offset,
      type: row.type,
      payload: JSON.parse(row.payload),
      ...(row.metadata == null ? {} : { metadata: JSON.parse(row.metadata) }),
      ...(row.idempotency_key == null ? {} : { idempotencyKey: row.idempotency_key }),
      createdAt: row.created_at,
    });
  }

  private propagateStreamCreated(firstEvent: Event) {
    if (this.state.path == null) {
      throw new Error(
        "Stream durable object cannot propagate before its reduced path is initialized.",
      );
    }

    const createdPath = this.state.path;
    if (createdPath === ROOT_STREAM_PATH) {
      return;
    }

    const parentPaths: StreamPath[] = [];
    let parentPath = getParentPath(createdPath);
    while (parentPath != null) {
      parentPaths.push(parentPath);
      parentPath = getParentPath(parentPath);
    }

    console.info("[stream-do] propagating stream-created", {
      createdPath,
      parentPaths,
      firstOffset: firstEvent.offset,
    });

    // Parent discovery is helpful but not required for the child append to commit,
    // so we fan out in the background and only log failures.
    void Promise.allSettled(
      parentPaths.map((parentPath) => {
        const events: EventInput[] = [
          {
            path: parentPath,
            type: STREAM_CREATED_TYPE,
            payload: {
              path: createdPath,
            },
          },
        ];

        const streamStub = this.env.STREAM.getByName(parentPath);
        return streamStub.append({ events });
      }),
    ).then((results) => {
      for (const [index, result] of results.entries()) {
        if (result.status === "fulfilled") {
          continue;
        }

        console.error("[stream-do] failed to propagate stream-created", {
          createdPath,
          parentPath: parentPaths[index],
          error: result.reason,
        });
      }
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

function encodeEventLine(event: Event) {
  return textEncoder.encode(`${JSON.stringify(event)}\n`);
}

/**
 * Pure reducer for the persisted stream projection. Replay and append share the
 * same rules so state cannot drift based on which code path produced it.
 * `STREAM_METADATA_UPDATED` replaces metadata rather than deep-merging it.
 */
function reduceStreamState(args: { state: StreamState; event: Event }): StreamState {
  const { state, event } = args;
  const path = state.path ?? event.path;
  if (state.path != null && state.path !== event.path) {
    throw new Error(`Stream path mismatch. Expected ${state.path}, received ${event.path}.`);
  }

  const nextState: StreamState = {
    path,
    lastOffset: event.offset,
    eventCount: state.eventCount + 1,
    metadata: { ...state.metadata },
  };

  switch (event.type) {
    case STREAM_METADATA_UPDATED_TYPE:
      nextState.metadata = StreamMetadataUpdatedPayload.parse(event.payload).metadata;
      return nextState;
    case STREAM_CREATED_TYPE:
    default:
      return nextState;
  }
}
