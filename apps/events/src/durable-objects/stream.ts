import { DurableObject } from "cloudflare:workers";
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

const INITIAL_OFFSET_WIDTH = 16;
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
   * Appends validated events inside one transaction.
   *
   * Per-event idempotency is stream-local: when an input includes an
   * `idempotencyKey` that already exists in this stream, we return the stored
   * event instead of creating a second row or advancing offsets/state.
   */
  async append(args: { events: EventInput[] }) {
    if (args.events.length === 0) {
      throw new Error("At least one event is required.");
    }

    const created = this.state.eventCount === 0;
    let nextState = structuredClone(this.state);
    const events: Event[] = [];
    const insertedEvents: Event[] = [];

    this.ctx.storage.transactionSync(() => {
      for (const inputEvent of args.events) {
        const existingEvent =
          inputEvent.idempotencyKey == null
            ? null
            : this.getEventByIdempotencyKey({
                path: inputEvent.path,
                idempotencyKey: inputEvent.idempotencyKey,
              });

        if (existingEvent != null) {
          events.push(existingEvent);
          continue;
        }

        const insertedEvent = this.insertEventSync({
          inputEvent,
          prevOffset: nextState.lastOffset,
        });

        events.push(insertedEvent);
        nextState = reduceStreamState({
          state: nextState,
          event: insertedEvent,
        });
        insertedEvents.push(insertedEvent);
      }

      this.ctx.storage.sql.exec(
        `INSERT INTO reduced_state (singleton, json)
         VALUES (1, json(?))
         ON CONFLICT(singleton) DO UPDATE SET json = excluded.json`,
        JSON.stringify(nextState),
      );
    });

    this.state = structuredClone(nextState);

    for (const event of insertedEvents) {
      this.publish(event);
    }

    if (created && insertedEvents[0] != null) {
      this.propagateStreamCreated(insertedEvents[0]);
    }

    return { created, events };
  }

  // Cloudflare's supported way to wipe one Durable Object's persisted data is
  // `deleteAll()` on its storage, rather than an explicit instance-destruction API:
  // https://developers.cloudflare.com/durable-objects/api/storage-api/
  // https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/
  async destroy() {
    const stateBeforeDelete = structuredClone(this.state);

    for (const subscriber of this.subscribers) {
      try {
        subscriber.close();
      } catch {
        // Ignore already-closed streams; we only need best-effort teardown.
      }
    }

    this.subscribers.clear();
    await this.ctx.storage.deleteAll();
    return stateBeforeDelete;
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

  /**
   * Inserts a fresh event row using the caller-provided previous offset.
   *
   * This cannot read `this.state.lastOffset` directly because a single append
   * call can insert multiple new events, and each later event must see the
   * offset produced earlier in the same batch.
   */
  private insertEventSync(args: { inputEvent: EventInput; prevOffset: string | null }) {
    const { inputEvent, prevOffset } = args;

    const event = Event.parse({
      path: inputEvent.path,
      offset: this.nextOffset({ prevOffset }),
      type: inputEvent.type,
      payload: inputEvent.payload,
      metadata: inputEvent.metadata,
      idempotencyKey: inputEvent.idempotencyKey,
      createdAt: new Date().toISOString(),
    });

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

    return event;
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

  private nextOffset(args: { prevOffset: string | null }) {
    const { prevOffset } = args;

    // Offsets are fixed-width decimal strings so plain lexicographic ordering in
    // SQLite matches append order.
    if (prevOffset == null) {
      return Offset.parse("1".padStart(INITIAL_OFFSET_WIDTH, "0"));
    }

    if (!/^\d+$/.test(prevOffset)) {
      throw new Error(`Cannot generate the next offset after non-numeric offset ${prevOffset}.`);
    }

    const width = Math.max(prevOffset.length, INITIAL_OFFSET_WIDTH);
    return Offset.parse((BigInt(prevOffset) + 1n).toString().padStart(width, "0"));
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
