import { DurableObject } from "cloudflare:workers";
import { getNextAppendEventOffset, getNextEventOffset } from "@iterate-com/shared/events/offset";
import {
  AppendEventInput,
  Event,
  Offset,
  StreamPath,
  StreamMetadataUpdatedPayload,
  StreamState,
  STREAM_CREATED_TYPE,
  STREAM_METADATA_UPDATED_TYPE,
} from "@iterate-com/events-contract";
import { ROOT_STREAM_PATH, getParentPath } from "~/lib/utils.ts";
const textEncoder = new TextEncoder();

/**
 * One stream per Durable Object: append-only event log in SQLite, a reduced
 * projection kept in memory and storage, and newline-delimited fanout for live
 * readers.
 *
 * Each stream must be initialized exactly once with its canonical path. That
 * initialization writes a synthetic self `STREAM_CREATED` event at offset `0`,
 * so every initialized stream starts with the invariant:
 * - event `0` is always `STREAM_CREATED` for that stream's own path
 * - caller-appended events begin at offset `1`
 *
 * Later `STREAM_CREATED` events can also appear in a stream as propagated child
 * discovery events. Those propagate upward one level at a time in the "after"
 * sections of `initialize()` and `append()`.
 *
 * Durable Object docs:
 * - https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/
 * - https://developers.cloudflare.com/durable-objects/api/state/
 * - https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
 */
export class StreamDurableObject extends DurableObject<Env> {
  private state: StreamState = {
    initialized: false,
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
   * Initializes this stream's identity exactly once. The first successful call
   * commits the synthetic self-created event at offset `0`; later same-path
   * calls are no-ops.
   */
  async initialize(args: { path: StreamPath }) {
    const currentState = structuredClone(this.state);

    if (currentState.initialized) {
      assertSameStreamPath({
        expected: requireStreamPath(assertInitializedState(currentState)),
        actual: args.path,
      });
      return;
    }

    if (
      currentState.eventCount !== 0 ||
      currentState.lastOffset != null ||
      currentState.path != null
    ) {
      throw new Error("Uninitialized stream durable object has inconsistent reduced state.");
    }

    const initializedState = createInitializedState({
      previousState: currentState,
      path: args.path,
    });
    const selfCreatedEvent = this.buildInsertedEvent({
      path: args.path,
      inputEvent: {
        type: STREAM_CREATED_TYPE,
        payload: {
          path: args.path,
        },
      },
      offset: Offset.parse(getNextEventOffset(null)),
    });
    const nextState = reduceStreamState({
      state: initializedState,
      event: selfCreatedEvent,
    });

    this.ctx.storage.transactionSync(() => {
      this.insertEventRowSync(selfCreatedEvent);
      this.writeReducedStateSync(nextState);
    });

    this.state = structuredClone(nextState);
    this.publish(selfCreatedEvent);

    if (selfCreatedEvent.type === STREAM_CREATED_TYPE) {
      this.propagateStreamCreatedUpOneLevel(selfCreatedEvent);
    }
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
  async append(args: { events: AppendEventInput[] }) {
    if (args.events.length === 0) {
      throw new Error("At least one event is required.");
    }

    const prevState = assertInitializedState(structuredClone(this.state));
    let state: StreamState = structuredClone(prevState);
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
              path: requireStreamPath(state),
              idempotencyKey: inputEvent.idempotencyKey,
            }));

      if (existingEvent != null) {
        events.push(existingEvent);
        continue;
      }

      const nextOffset = Offset.parse(
        getNextAppendEventOffset({
          initialized: state.initialized,
          lastOffset: state.lastOffset,
        }),
      );

      // Future pre-append checks belong here, before the transaction begins.
      if (inputEvent.offset != null && inputEvent.offset !== nextOffset) {
        return {
          kind: "offset-precondition-failed" as const,
          message: `Client-supplied offset ${inputEvent.offset} does not match next generated offset ${nextOffset}.`,
        };
      }

      const insertedEvent = this.buildInsertedEvent({
        path: requireStreamPath(state),
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
      if (event.type === STREAM_CREATED_TYPE) {
        this.propagateStreamCreatedUpOneLevel(event);
      }
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
    if (!this.state.initialized) {
      return [];
    }

    const path = requireStreamPath(assertInitializedState(this.state));
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
          initialized: false,
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

    const persistedState = StreamState.parse(
      normalizePersistedState({
        rawState: JSON.parse(persistedStateRow.json),
        eventRowCount,
      }),
    );
    if (persistedState.eventCount !== eventRowCount) {
      throw new Error(
        `Persisted reduced_state eventCount ${persistedState.eventCount} does not match ${eventRowCount} event rows.`,
      );
    }

    if (!persistedState.initialized) {
      if (eventRowCount > 0 || persistedState.path != null || persistedState.lastOffset != null) {
        throw new Error("Uninitialized reduced_state cannot point at a path or existing events.");
      }

      return structuredClone(persistedState);
    }

    if (persistedState.path == null) {
      throw new Error("Persisted reduced_state is missing a path even though it is initialized.");
    }

    if (persistedState.lastOffset == null) {
      throw new Error(
        "Persisted reduced_state is missing lastOffset even though it is initialized.",
      );
    }

    return structuredClone(persistedState);
  }

  private buildInsertedEvent(args: {
    path: StreamPath;
    inputEvent: AppendEventInput;
    offset: string;
  }) {
    const { path, inputEvent, offset } = args;

    return Event.parse({
      path,
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

  private propagateStreamCreatedUpOneLevel(event: Event) {
    const parentPath = getParentPath(event.path);
    if (parentPath == null || event.path === ROOT_STREAM_PATH) {
      return;
    }

    console.info("[stream-do] propagating stream-created", {
      streamPath: event.path,
      parentPath,
      propagatedPath:
        typeof event.payload.path === "string"
          ? event.payload.path
          : "<invalid-stream-created-payload>",
      offset: event.offset,
    });

    // Parent discovery is helpful but not required for the child append to
    // commit, so we fan out in the background and only log failures.
    const streamStub = this.env.STREAM.getByName(parentPath);
    void streamStub
      .initialize({ path: parentPath })
      .then(() =>
        streamStub.append({
          events: [
            {
              type: STREAM_CREATED_TYPE,
              payload: event.payload,
              ...(event.metadata == null ? {} : { metadata: event.metadata }),
            },
          ],
        }),
      )
      .catch((error) => {
        console.error("[stream-do] failed to propagate stream-created", {
          streamPath: event.path,
          parentPath,
          error,
        });
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

function normalizePersistedState(args: { rawState: unknown; eventRowCount: number }) {
  if (args.rawState == null || typeof args.rawState !== "object") {
    return args.rawState;
  }

  const rawState = args.rawState as Record<string, unknown>;
  if (typeof rawState.initialized === "boolean") {
    return rawState;
  }

  return {
    ...rawState,
    initialized: args.eventRowCount > 0 || rawState.path != null || rawState.lastOffset != null,
  };
}

function assertInitializedState(state: StreamState) {
  if (!state.initialized) {
    throw new Error("Stream durable object is not initialized.");
  }

  return state as StreamState & {
    initialized: true;
  };
}

function requireStreamPath(state: StreamState) {
  if (state.path == null) {
    throw new Error("Initialized stream durable object is missing path.");
  }

  return state.path;
}

function assertSameStreamPath(args: { expected: StreamPath; actual: StreamPath }) {
  if (args.expected !== args.actual) {
    throw new Error(`Stream path mismatch. Expected ${args.expected}, received ${args.actual}.`);
  }
}

function createInitializedState(args: {
  previousState: StreamState;
  path: StreamPath;
}): StreamState {
  if (args.previousState.initialized) {
    return args.previousState;
  }

  return {
    initialized: true,
    path: args.path,
    lastOffset: null,
    eventCount: 0,
    metadata: { ...args.previousState.metadata },
  };
}

/**
 * Pure reducer for the persisted stream projection. Replay and append share the
 * same rules so state cannot drift based on which code path produced it.
 * `STREAM_METADATA_UPDATED` replaces metadata rather than deep-merging it.
 */
function reduceStreamState(args: { state: StreamState; event: Event }): StreamState {
  const { event } = args;
  const state = assertInitializedState(args.state);
  assertSameStreamPath({
    expected: requireStreamPath(state),
    actual: event.path,
  });

  const nextState: StreamState = {
    initialized: true,
    path: requireStreamPath(state),
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
