import { DurableObject } from "cloudflare:workers";
import { getNextEventOffset } from "@iterate-com/shared/events/offset";
import {
  childStreamCreatedEventType,
  Event,
  EventInput,
  Offset,
  streamInitializedEventType,
  streamMetadataUpdatedEventType,
  StreamPath,
  StreamState,
} from "@iterate-com/events-contract";
import {
  getParentStreamBinding,
  StreamAppendInputError,
  StreamOffsetPreconditionError,
} from "~/lib/stream-helpers.ts";
const textEncoder = new TextEncoder();

/**
 * One stream per Durable Object: append-only event log in SQLite, a reduced
 * projection kept in memory and storage, and newline-delimited fanout for live
 * readers.
 *
 * Each stream must be initialized exactly once with its canonical path. That
 * initialization writes a synthetic self `stream-initialized` event at offset `0`,
 * so every initialized stream starts with the invariant:
 * - event `0` is always `stream-initialized` for that stream's own path
 * - caller-appended events begin at offset `1`
 *
 * Child discovery is a separate built-in event. After a stream commits its own
 * self-init event, it appends `child-stream-created` to its parent. Parents then
 * propagate that same child discovery event upward one level at a time.
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
   * commits the synthetic self-initialized event at offset `0`; later same-path
   * calls are no-ops.
   */
  initialize(args: { path: StreamPath }) {
    const currentState = structuredClone(this.state);

    if (currentState.initialized) {
      const currentPath = currentState.path;
      if (currentPath == null) {
        throw new Error("Initialized stream durable object is missing path.");
      }

      if (currentPath !== args.path) {
        throw new Error(`Stream path mismatch. Expected ${currentPath}, received ${args.path}.`);
      }
      return;
    }

    return this.append({
      type: streamInitializedEventType,
      payload: {
        path: args.path,
      },
    });
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
  async append(inputEvent: EventInput) {
    const parsedInputEvent = EventInput.parse(inputEvent);
    const currentState = structuredClone(this.state);
    const isStreamInitializedEvent = isStreamInitializedEventInput(parsedInputEvent);

    if (!isStreamInitializedEvent && !currentState.initialized) {
      throw new Error("Stream durable object is not initialized.");
    }

    const path = currentState.initialized
      ? (() => {
          if (currentState.path == null) {
            throw new Error("Initialized stream durable object is missing path.");
          }

          return currentState.path;
        })()
      : getStreamInitializedInputPath(parsedInputEvent);

    const existingEvent =
      parsedInputEvent.idempotencyKey == null
        ? null
        : this.getEventByIdempotencyKey({
            path,
            idempotencyKey: parsedInputEvent.idempotencyKey,
          });

    if (existingEvent != null) {
      return existingEvent;
    }

    const nextOffset = Offset.parse(getNextEventOffset(currentState.lastOffset));

    // Future pre-append checks belong here, before the transaction begins.
    if (parsedInputEvent.offset != null && parsedInputEvent.offset !== nextOffset) {
      throw new StreamOffsetPreconditionError(
        `Client-supplied offset ${parsedInputEvent.offset} does not match next generated offset ${nextOffset}.`,
      );
    }

    const event = this.buildInsertedEvent({
      path,
      inputEvent: parsedInputEvent,
      offset: nextOffset,
    });
    const nextState = reduceStreamState({
      state: currentState,
      event,
    });

    this.ctx.storage.transactionSync(() => {
      this.insertEventRowSync(event);
      this.writeReducedStateSync(nextState);
    });

    this.state = structuredClone(nextState);
    this.publish(event);
    this.afterAppend(event);
    return event;
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

    const path = this.state.path;
    if (path == null) {
      throw new Error("Initialized stream durable object is missing path.");
    }

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

    const persistedState = StreamState.parse(JSON.parse(persistedStateRow.json));
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

  private buildInsertedEvent(args: { path: StreamPath; inputEvent: EventInput; offset: string }) {
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

  private afterAppend(event: Event) {
    switch (event.type) {
      case streamInitializedEventType:
        this.propagateChildStreamCreated({
          streamPath: event.path,
          childPath: getStreamInitializedEventPath(event),
          metadata: event.metadata,
        });
        return;
      case childStreamCreatedEventType:
        this.propagateChildStreamCreated({
          streamPath: event.path,
          childPath: getChildStreamCreatedEventPath(event),
          metadata: event.metadata,
        });
        return;
      default:
        return;
    }
  }

  private propagateChildStreamCreated(args: {
    streamPath: StreamPath;
    childPath: StreamPath;
    metadata?: Event["metadata"];
  }) {
    const parent = getParentStreamBinding(this.env, args.streamPath);
    if (parent == null) {
      return;
    }

    console.info("[stream-do] propagating child-stream-created", {
      streamPath: args.streamPath,
      parentPath: parent.parentPath,
      childPath: args.childPath,
    });

    // Child discovery helps the parent/root indexes stay fresh, but the child
    // append has already committed, so propagation failures are logged only.
    void Promise.resolve(parent.streamStub)
      .then(async (streamStub) => {
        await streamStub.initialize({ path: parent.parentPath });
        return streamStub.append({
          type: childStreamCreatedEventType,
          payload: {
            path: args.childPath,
          },
          ...(args.metadata == null ? {} : { metadata: args.metadata }),
        });
      })
      .catch((error) => {
        console.error("[stream-do] failed to propagate child-stream-created", {
          streamPath: args.streamPath,
          parentPath: parent.parentPath,
          childPath: args.childPath,
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

function isStreamInitializedEventInput(event: EventInput): event is EventInput & {
  type: typeof streamInitializedEventType;
  payload: { path: StreamPath };
} {
  return event.type === streamInitializedEventType;
}

function getStreamInitializedInputPath(event: EventInput) {
  if (event.type !== streamInitializedEventType) {
    throw new Error(`Expected ${streamInitializedEventType}, received ${event.type}.`);
  }

  return (event.payload as { path: StreamPath }).path;
}

function getStreamInitializedEventPath(event: Event) {
  if (event.type !== streamInitializedEventType) {
    throw new Error(`Expected ${streamInitializedEventType}, received ${event.type}.`);
  }

  return (event.payload as { path: StreamPath }).path;
}

function getChildStreamCreatedEventPath(event: Event) {
  if (event.type !== childStreamCreatedEventType) {
    throw new Error(`Expected ${childStreamCreatedEventType}, received ${event.type}.`);
  }

  return (event.payload as { path: StreamPath }).path;
}

function getStreamMetadataUpdatedEventMetadata(event: Event) {
  if (event.type !== streamMetadataUpdatedEventType) {
    throw new Error(`Expected ${streamMetadataUpdatedEventType}, received ${event.type}.`);
  }

  return (event.payload as { metadata: StreamState["metadata"] }).metadata;
}

/**
 * Pure reducer for the persisted stream projection. Replay and append share the
 * same rules so state cannot drift based on which code path produced it.
 * `stream-initialized` is self-only and may happen once. `stream-metadata-updated`
 * replaces the metadata snapshot. Other events preserve metadata and simply
 * advance offsets/event counts.
 */
function reduceStreamState(args: { state: StreamState; event: Event }): StreamState {
  const { state, event } = args;

  switch (event.type) {
    case streamInitializedEventType: {
      if (state.initialized) {
        throw new StreamAppendInputError("stream-initialized may only be appended once.");
      }

      const initializedPath = getStreamInitializedEventPath(event);
      if (event.path !== initializedPath) {
        throw new Error(
          `Uninitialized stream durable object expected self initialization for ${initializedPath}, received event for ${event.path}.`,
        );
      }

      return {
        initialized: true,
        path: event.path,
        lastOffset: event.offset,
        eventCount: state.eventCount + 1,
        metadata: { ...state.metadata },
      };
    }
    default:
      break;
  }

  if (!state.initialized) {
    throw new Error("Stream durable object is not initialized.");
  }

  const streamPath = state.path;
  if (streamPath == null) {
    throw new Error("Initialized stream durable object is missing path.");
  }

  if (streamPath !== event.path) {
    throw new Error(`Stream path mismatch. Expected ${streamPath}, received ${event.path}.`);
  }

  switch (event.type) {
    case streamMetadataUpdatedEventType:
      return {
        initialized: true,
        path: streamPath,
        lastOffset: event.offset,
        eventCount: state.eventCount + 1,
        metadata: getStreamMetadataUpdatedEventMetadata(event),
      };
    default:
      return {
        initialized: true,
        path: streamPath,
        lastOffset: event.offset,
        eventCount: state.eventCount + 1,
        metadata: { ...state.metadata },
      };
  }
}
