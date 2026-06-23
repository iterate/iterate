import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { dispatchCallable } from "@iterate-com/shared/callable/runtime.ts";
import { trustedInternalAuthContext } from "../../auth.ts";
import type {
  Stream,
  StreamEvent as PublicStreamEvent,
  StreamEventInput as PublicStreamEventInput,
} from "../../../types.ts";
import {
  formatDurableObjectName,
  PLATFORM_PROJECT_ID,
  parseDurableObjectName,
} from "../durable-object-names.ts";
import { StreamRpcTarget } from "../../rpc-targets.ts";
import {
  StreamEvent as StreamEventSchema,
  StreamEventInput as StreamEventInputSchema,
  type StreamEvent,
  type StreamEventInput,
} from "./engine/shared/event.ts";
import type { StreamSubscriptionHandshake } from "./engine/workers/stream-processor-host.ts";
import type { StreamProcessorStream } from "./engine/stream-processor.ts";
import { getInitialProcessorState } from "./engine/shared/stream-processors.ts";
import type {
  LiveStreamSubscriberDescriptor,
  ProcessEventBatch,
  StreamCoreProcessorState,
  StreamRpc,
} from "./engine/types.ts";
import { CoreStreamProcessor } from "./engine/processors/core/implementation.ts";
import {
  CoreProcessorContract,
  type CoreProcessorState,
} from "./engine/processors/core/contract.ts";
import { createStreamSubscription } from "./engine/subscription.ts";

const StreamAppendInput = StreamEventInputSchema.extend({
  offset: z.number().int().nonnegative().optional(),
});
type StreamAppendInput = z.infer<typeof StreamAppendInput>;

/**
 * Durable stream storage and Workers RPC surface.
 *
 * HTTP/WebSocket Cap'n Web termination belongs at the fronting Worker, which
 * exposes this DO through `StreamRpcTarget`.
 */

// Cloudflare Durable Objects cap each SQLite string/blob/table row at 2 MB.
// BLOB columns do not raise that ceiling, and SQL-side substr(?) chunking would
// still require binding the oversized value first, so event JSON is chunked in JS.
const EVENT_CHUNK_SIZE = 512 * 1024;
const textEncoder = new TextEncoder();

// Version of the persisted core reduced state ("state" in KV). Bump this when
// the core reducer starts deriving NEW state from already-reduced events
// (already-committed events are never re-reduced on the incremental catch-up
// path). On wake, a stored version that differs from this constant discards
// the persisted state and rebuilds it by replaying the full event log from the
// DO's own SQLite — the same path used when KV state is missing entirely.
//
// History:
// - 1 (implicit; no "stateVersion" key in KV): pre-descendantPaths state.
// - 2: childPaths gained a sibling descendantPaths (full announced paths).
// - 3: descendantPaths removed; callers should walk immediate childPaths.
// - 4: subscriber presence — connectionsByKey roster added; processorsBySlug
//      reshaped to fold contract announcements from subscriber-connected
//      events instead of the removed processor-registered event.
// - 5: stream coordinate field renamed from projectId to projectId.
const CORE_STATE_VERSION = 5;

// How long a stream may hold idle OUTBOUND delivery connections before the
// Stream DO severs them so it (and its subscribers) can hibernate instead of
// accruing billable duration on cross-isolate RPC sessions that pin both DOs.
// Tracked with an in-memory timer (NOT a DO alarm): the retained stubs we tear
// down are in-memory and die on eviction anyway, the DO is always resident while
// it holds them (so the timer is guaranteed to fire), and a durable alarm's only
// extra power — waking a hibernated DO — is exactly what we must never do.
// Overridable via the STREAM_IDLE_TEARDOWN_MS env var (used by tests).
const DEFAULT_STREAM_IDLE_TEARDOWN_MS = 5 * 60_000;

export class StreamDurableObject extends DurableObject<Env> implements Stream {
  readonly name = parseStreamDurableObjectName(this.ctx.id.name);

  #coreProcessorState: StreamCoreProcessorState;
  /** In-memory idle teardown timer; armed only while outbound connections exist. */
  #idleTimer: ReturnType<typeof setTimeout> | undefined;
  // The core processor owns the live delivery connections and reconciles them
  // against reduced state; this DO supplies the storage and RPC mechanics it
  // needs (committed-event reads, the live state, Callable dispatch).
  coreProcessor = new CoreStreamProcessor({
    stream: {
      append: (args: { streamPath?: string; event: StreamEventInput }) =>
        this.#appendFromProcessor(args),
      appendBatch: (args: { streamPath?: string; events: StreamEventInput[] }) =>
        this.#appendBatchFromProcessor(args),
      getEvent: (args: Parameters<StreamProcessorStream["getEvent"]>[0]) => this.getEvent(args),
      getEvents: (args?: Parameters<StreamProcessorStream["getEvents"]>[0]) => this.getEvents(args),
      waitForEvent: (args: Parameters<StreamProcessorStream["waitForEvent"]>[0]) =>
        this.waitForEvent(args as never),
      getProcessorRuntimeState: (
        args: Parameters<StreamProcessorStream["getProcessorRuntimeState"]>[0],
      ) => this.getProcessorRuntimeState(args),
      runtimeState: () => this.runtimeState(),
      kill: () => this.kill(),
      subscribe: (args: Parameters<StreamProcessorStream["subscribe"]>[0]) =>
        this.subscribe(args as never),
    } as unknown as StreamProcessorStream,
    keepAliveWhile: (work) => void this.ctx.waitUntil(work()),
    getEvents: (args) => this.getEvents(args),
    currentState: () => this.#coreProcessorState,
    dial: (args) => this.#connectOutboundConnection(args),
  });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#ensureStorageSchema();

    this.#coreProcessorState = this.readCoreProcessorState();

    // When the durable object boots up the _first time_, we add a
    // events.iterate.com/stream/created event to the stream.
    //
    // And every time it's woken up for any reason (inbound fetch, rpc or alarm),
    // we append a "woken" event to the stream. The woken fact is also what
    // restores outbound connections: the core processor's reconciler runs as
    // its post-commit side effect, so a stream that wakes with configured
    // subscriptions but no new appends still reconnects.
    if (this.#coreProcessorState.eventCount === 0) {
      this.append({
        event: {
          type: "events.iterate.com/stream/created",
          payload: { projectId: this.name.projectId, path: this.name.path },
        },
      });
    }
    // each time the durable object wakes up, we append this event
    this.append({
      event: {
        type: "events.iterate.com/stream/woken",
        payload: { incarnationId: crypto.randomUUID() },
      },
    });
  }

  #ensureStorageSchema(): void {
    // Keep storage normalized:
    // - `events` is the offset-ordered metadata/index table.
    // - `event_chunks` stores the full event JSON as bounded UTF-8 byte rows.
    this.#createEventsTable();
    this.#createEventChunksTable();
  }

  #createEventsTable(): void {
    this.ctx.storage.sql.exec(`
      -- Stream-owned append log metadata. Full event JSON is stored in event_chunks.
      -- offset is the replay cursor; idempotency_key's unique constraint is its lookup index.
      create table if not exists events (
        offset integer primary key autoincrement,
        type text not null,
        created_at text not null,
        idempotency_key text unique
      )
    `);
  }

  #createEventChunksTable(): void {
    this.ctx.storage.sql.exec(`
      -- Full committed event JSON split into ordered byte chunks. The WITHOUT ROWID
      -- primary key is the lookup index used by point reads and range replay.
      create table if not exists event_chunks (
        offset integer not null,
        chunk_index integer not null,
        chunk_bytes blob not null,
        primary key (offset, chunk_index),
        foreign key (offset) references events(offset) on delete cascade
      ) without rowid
    `);
  }

  protected readCoreProcessorState(): StreamCoreProcessorState {
    const stored = this.ctx.storage.kv.get<unknown>("state");
    const storedVersion = this.ctx.storage.kv.get<unknown>("stateVersion") ?? 1;
    // State persisted by a reducer of a different version is incomplete (it
    // was reduced before newer derived fields existed), so it is discarded and
    // rebuilt from the event log rather than trusted.
    const storedStateIsCurrent = stored !== undefined && storedVersion === CORE_STATE_VERSION;
    const storedState = storedStateIsCurrent
      ? CoreProcessorContract.stateSchema.parse(stored)
      : this.#recoverCoreProcessorStateFromEventLog();
    if (storedState === undefined) return getInitialProcessorState(CoreProcessorContract);

    const state = this.#catchUpCoreProcessorState(storedState);

    if (!storedStateIsCurrent || state.maxOffset !== storedState.maxOffset) {
      this.writeCoreProcessorState(state);
    }
    return state;
  }

  protected writeCoreProcessorState(state: StreamCoreProcessorState): void {
    this.ctx.storage.kv.put("state", state);
    this.ctx.storage.kv.put("stateVersion", CORE_STATE_VERSION);
  }

  #catchUpCoreProcessorState(state: StreamCoreProcessorState): StreamCoreProcessorState {
    const highestOffset = this.#readHighestEventOffset();
    if (highestOffset <= state.maxOffset) return state;

    return this.#reduceCoreProcessorState({
      state,
      events: this.#readEventsInRange({
        afterOffset: state.maxOffset,
        beforeOffset: highestOffset + 1,
        limit: highestOffset - state.maxOffset,
      }),
    });
  }

  #readHighestEventOffset(): number {
    return (
      this.ctx.storage.sql
        .exec<{ offset: number | null }>("select max(offset) as offset from events")
        .toArray()[0]?.offset ?? 0
    );
  }

  #appendEventRows(events: StreamEvent[]): void {
    for (const event of events) {
      const rawJson = JSON.stringify(event);
      this.ctx.storage.sql.exec(
        `
          insert into events (offset, type, created_at, idempotency_key)
          values (?, ?, ?, ?)
        `,
        event.offset,
        event.type,
        event.createdAt,
        event.idempotencyKey ?? null,
      );
      this.#insertEventChunks(event.offset, rawJson);
    }
  }

  #insertEventChunks(offset: number, rawJson: string): void {
    const rawJsonBytes = textEncoder.encode(rawJson);
    for (const [chunkIndex, chunk] of chunkBytes(rawJsonBytes, EVENT_CHUNK_SIZE)) {
      this.ctx.storage.sql.exec(
        `
          insert into event_chunks (offset, chunk_index, chunk_bytes)
          values (?, ?, ?)
        `,
        offset,
        chunkIndex,
        chunk,
      );
    }
  }

  #readEventByOffset(offset: number): StreamEvent | undefined {
    const row = this.ctx.storage.sql
      .exec<{ offset: number }>(
        `
          select offset
          from events
          where offset = ?
          limit 1
        `,
        offset,
      )
      .toArray()[0];
    if (row === undefined) return undefined;
    return this.#readEventFromChunks(row.offset);
  }

  #readEventByIdempotencyKey(idempotencyKey: string): StreamEvent | undefined {
    const row = this.ctx.storage.sql
      .exec<{ offset: number }>(
        `
          select offset
          from events
          where idempotency_key = ?
          limit 1
        `,
        idempotencyKey,
      )
      .toArray()[0];
    if (row === undefined) return undefined;
    return this.#readEventFromChunks(row.offset);
  }

  #readEventFromChunks(offset: number): StreamEvent {
    // Do not use group_concat here: it would recreate a multi-MiB SQLite result cell.
    // Returning bounded chunk rows and joining in JS keeps SQLite row sizes predictable.
    const chunks = this.ctx.storage.sql
      .exec<{ chunkBytes: ArrayBuffer }>(
        `
          select chunk_bytes as chunkBytes
          from event_chunks
          where offset = ?
          order by chunk_index asc
        `,
        offset,
      )
      .toArray()
      .map((row) => row.chunkBytes);
    const rawJson = decodeChunks(chunks);
    return StreamEventSchema.parse(JSON.parse(rawJson));
  }

  #readEventsInRange(args: {
    afterOffset: number;
    beforeOffset: number;
    limit: number;
  }): StreamEvent[] {
    // One indexed metadata subquery picks the replay window; the join then streams each
    // event's chunks in primary-key order (offset, chunk_index).
    const chunks = this.ctx.storage.sql
      .exec<{ offset: number; chunkBytes: ArrayBuffer }>(
        `
          select selected.offset as offset, event_chunks.chunk_bytes as chunkBytes
          from (
            select offset
            from events
            where offset > ?
              and offset < ?
            order by offset asc
            limit ?
          ) selected
          join event_chunks on event_chunks.offset = selected.offset
          order by selected.offset asc, event_chunks.chunk_index asc
        `,
        args.afterOffset,
        args.beforeOffset,
        args.limit,
      )
      .toArray();
    const chunksByOffset = new Map<number, ArrayBuffer[]>();
    for (const chunk of chunks) {
      const eventChunks = chunksByOffset.get(chunk.offset);
      if (eventChunks === undefined) {
        chunksByOffset.set(chunk.offset, [chunk.chunkBytes]);
      } else {
        eventChunks.push(chunk.chunkBytes);
      }
    }
    return [...chunksByOffset.values()].map((eventChunks) =>
      StreamEventSchema.parse(JSON.parse(decodeChunks(eventChunks))),
    );
  }

  #recoverCoreProcessorStateFromEventLog(): StreamCoreProcessorState | undefined {
    const events = this.#readEventsInRange({
      afterOffset: 0,
      beforeOffset: Number.MAX_SAFE_INTEGER,
      limit: Number.MAX_SAFE_INTEGER,
    });
    if (events.length === 0) return undefined;

    // KV state is the fast path, but SQL rows are the durable source of truth.
    // If a deployed DO has rows but no KV state, replay the event log instead of
    // treating the stream as empty and trying to insert offset 1 again.
    return this.#reduceCoreProcessorState({
      state: getInitialProcessorState(CoreProcessorContract),
      events,
    });
  }

  #reduceCoreProcessorState(args: {
    state: StreamCoreProcessorState;
    events: readonly StreamEvent[];
  }): StreamCoreProcessorState {
    let state = args.state;
    for (const event of args.events) {
      if (event.offset <= state.maxOffset) continue;
      state = this.coreProcessor.reduceEvent({ event, state });
    }
    return state;
  }

  #resolveStream(streamPath: string): Pick<Stream, "append" | "appendBatch"> {
    const resolvedPath = resolveStreamPath(this.#coreProcessorState.path, streamPath);
    if (resolvedPath === resolveStreamPath(this.#coreProcessorState.path, ".")) return this;
    return this.env.STREAM.getByName(
      formatDurableObjectName({
        path: resolvedPath,
        projectId: this.name.projectId,
      }),
    ) as unknown as Pick<Stream, "append" | "appendBatch">;
  }

  /**
   * Convenience RPC for appending one event.
   *
   * Uses `appendBatch()`, so all append ordering and persistence stays in one place.
   */
  append(args: { event: PublicStreamEventInput }): PublicStreamEvent {
    return this.#appendBatchHere({
      events: [args.event as StreamAppendInput],
    })[0]! as PublicStreamEvent;
  }

  /**
   * Synchronously assigns offsets, reduces, persists, then wakes delivery.
   *
   * What actually happens for `appendBatch({ events: [a, b] })` on a stream at
   * `maxOffset: 4`:
   * 1. `a` becomes offset 5, `b` becomes offset 6; each is folded into reduced state.
   *    An event whose `idempotencyKey` already exists is skipped and the existing
   *    event is returned in its place (so the returned array stays input-aligned).
   * 2. Event rows + the new core processor state are written in one await-free turn.
   *    After this line the append has succeeded.
   * 3. Post-commit fan-out: every live connection's `wake()` is called (its pump then
   *    reads offsets 5..6 from storage and delivers them); reconciliation runs only if
   *    one of the new events was a `subscription-configured`. Neither can fail the
   *    append.
   *
   * Returns the persisted events (including offsets + `createdAt`) in input order.
   */
  appendBatch(args: { events: PublicStreamEventInput[] }): PublicStreamEvent[] {
    return this.#appendBatchHere({
      events: args.events as StreamAppendInput[],
    }) as PublicStreamEvent[];
  }

  appendInternal(args: { events: StreamAppendInput[] }): void {
    this.#appendBatchHere({ events: args.events });
  }

  #appendFromProcessor(args: { streamPath?: string; event: StreamEventInput }) {
    if (args.streamPath !== undefined) {
      return this.#resolveStream(args.streamPath).append({
        event: args.event as PublicStreamEventInput,
      });
    }
    return this.append({ event: args.event as PublicStreamEventInput });
  }

  #appendBatchFromProcessor(args: { streamPath?: string; events: StreamEventInput[] }) {
    if (args.streamPath !== undefined) {
      return this.#resolveStream(args.streamPath).appendBatch({
        events: args.events as PublicStreamEventInput[],
      });
    }
    return this.appendBatch({ events: args.events as PublicStreamEventInput[] });
  }

  #appendBatchHere(args: { events: StreamAppendInput[] }): StreamEvent[] {
    let workingCoreProcessorState = this.#coreProcessorState;
    const events: StreamEvent[] = [];
    const newEvents: StreamEvent[] = [];
    const reducedSideEffects: Array<{
      event: StreamEvent;
      previousState: StreamCoreProcessorState;
      state: StreamCoreProcessorState;
    }> = [];
    const idempotencyHitsInBatch = new Map<string, StreamEvent>();
    // 1. Prepare events and reduced state.
    for (const eventInput of args.events) {
      const input = StreamAppendInput.strict().parse(eventInput);

      if (input.idempotencyKey !== undefined) {
        // Same-batch idempotency should behave like already-persisted idempotency.
        const existing =
          idempotencyHitsInBatch.get(input.idempotencyKey) ??
          this.getEvent({ idempotencyKey: input.idempotencyKey });
        if (existing !== undefined) {
          if (input.offset !== undefined && input.offset !== existing.offset) {
            throw new Error(`idempotency hit at offset ${existing.offset}, got ${input.offset}`);
          }
          events.push(existing);
          continue;
        }
      }

      this.coreProcessor.validateAppend({
        event: input,
        state: workingCoreProcessorState,
      });

      const committed: StreamEvent = {
        ...input,
        offset: workingCoreProcessorState.maxOffset + 1,
        createdAt: new Date().toISOString(),
      };
      if (input.offset !== undefined && input.offset !== committed.offset) {
        throw new Error(`expected offset ${committed.offset}, got ${input.offset}`);
      }

      const previousCoreProcessorState = workingCoreProcessorState;
      workingCoreProcessorState = this.coreProcessor.reduceEvent({
        event: committed,
        state: previousCoreProcessorState,
      });

      // Core side effects are deferred until after the commit below:
      // `processReducedEvent` side effects (e.g. announcing this stream to its
      // ancestors) call back into `append`/`#resolveStream`, which read
      // `this.#coreProcessorState` — running them mid-batch would observe the
      // stale pre-append state (on a brand-new stream that still has the
      // placeholder project/path).
      reducedSideEffects.push({
        event: committed,
        previousState: previousCoreProcessorState,
        state: workingCoreProcessorState,
      });

      events.push(committed);
      newEvents.push(committed);
      if (committed.idempotencyKey !== undefined) {
        idempotencyHitsInBatch.set(committed.idempotencyKey, committed);
      }
    }

    if (newEvents.length === 0) return events;

    // 2. Persist new event rows and reduced core processor state.
    // Durable Object SQL storage runs synchronously in the object's thread. The
    // first-party docs say each sql.exec() call is atomic, cursors should be fully
    // consumed before awaits, and Output Gates hold responses until writes are durable:
    // https://developers.cloudflare.com/durable-objects/api/sql-storage/
    // https://blog.cloudflare.com/sqlite-in-durable-objects/
    //
    // Keep this section await-free: event rows + core processor state are the append boundary.
    this.#appendEventRows(newEvents);
    this.writeCoreProcessorState(workingCoreProcessorState);
    this.#coreProcessorState = workingCoreProcessorState;

    // Post-commit core side effects (see the deferral note above). Inline core
    // side effects are fire-and-forget (`runInBackground`), so this cannot fail
    // the append.
    for (const reduced of reducedSideEffects) {
      this.coreProcessor.processReducedEvent(reduced);
    }

    // 3. Wake live delivery. Append success is already decided above — this is
    // pure post-commit fan-out. (Connection reconciliation is not triggered
    // here: it is the core processor's side effect for the woken and
    // subscription-configured facts, which ran in the loop above.)
    this.coreProcessor.wakeConnections();

    // Re-dial any configured subscription left without a live connection — e.g.
    // an idle teardown (here or on the subscriber), a clean unsubscribe, etc.
    // severed it. The subscriber re-handshakes from its durable checkpoint, so
    // replay covers this very event. Cheap (O(subscriptions)) and a no-op once
    // everything is connected.
    //
    // Exactly ONE event type is excluded as a re-dial trigger:
    // `subscriber-disconnected`. `connection.close()` appends one as it removes
    // the connection from the map, so at that instant `needsOutboundReconcile()`
    // is transiently true for the just-closed key — reconciling on it would
    // immediately re-dial and undo every teardown (idle / unsubscribed /
    // replaced / …). Re-dial must wait for the next genuine append. Every OTHER
    // event is safe to trigger on: `woken` and `subscription-configured` have
    // already reconciled via the core's reduced-event side effect (so the check
    // is a no-op), and `subscriber-connected` only lands while its key is
    // connected/connecting (also a no-op). We deliberately do NOT exclude the
    // whole `stream/*` event family — only this single self-undoing event.
    const SUBSCRIBER_DISCONNECTED_TYPE = "events.iterate.com/stream/subscriber-disconnected";
    const hasRedialTriggeringAppend = newEvents.some(
      (event) => event.type !== SUBSCRIBER_DISCONNECTED_TYPE,
    );
    if (hasRedialTriggeringAppend && this.coreProcessor.needsOutboundReconcile()) {
      this.coreProcessor.reconcileConnections();
    }

    // Re-arm (or clear) the in-memory idle timer against the post-append
    // connection set, so a stream that just went quiet sheds its outbound
    // delivery sessions and lets both DOs hibernate.
    this.#armOrClearIdleTimer();

    return events;
  }

  getEvent(
    args: { offset: number; idempotencyKey?: never } | { idempotencyKey: string; offset?: never },
  ): StreamEvent | undefined {
    if (args.idempotencyKey !== undefined) {
      return this.#readEventByIdempotencyKey(args.idempotencyKey);
    }
    const event = this.#readEventByOffset(args.offset);
    if (event === undefined) throw new Error(`No stream event found at offset ${args.offset}.`);
    return event;
  }

  getEvents(
    args: {
      afterOffset?: number;
      beforeOffset?: number | null;
      limit?: number;
    } = {},
  ): PublicStreamEvent[] {
    const limit = args.limit;
    if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
      throw new Error("getEvents limit must be a positive integer.");
    }

    // Later this should accept event type filters for subscription catch-up and
    // operator views. Keep the first SQLite shape offset-only until that design is real.
    return this.#readEventsInRange({
      afterOffset: args.afterOffset ?? 0,
      beforeOffset: args.beforeOffset ?? Number.MAX_SAFE_INTEGER,
      limit: limit ?? Number.MAX_SAFE_INTEGER,
    }) as PublicStreamEvent[];
  }

  /**
   * One-shot convenience over `subscribe()`: replay from the requested cursor,
   * then live-tail until a caller predicate accepts an event.
   *
   * This is intentionally not a durable waiter. If the RPC caller or this DO
   * incarnation dies, the wait dies too; callers that need retry semantics
   * should call again with the same `afterOffset`.
   */
  async waitForEvent(args: {
    afterOffset?: number;
    eventTypes?: readonly string[];
    predicate?: (event: StreamEvent) => boolean | Promise<boolean>;
    timeoutMs: number;
  }): Promise<StreamEvent> {
    if (args.eventTypes === undefined && args.predicate === undefined) {
      throw new Error("waitForEvent requires eventTypes or predicate.");
    }
    if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
      throw new Error("waitForEvent timeoutMs must be a positive number.");
    }
    if (
      args.afterOffset !== undefined &&
      (!Number.isInteger(args.afterOffset) || args.afterOffset < 0)
    ) {
      throw new Error("waitForEvent afterOffset must be a non-negative integer.");
    }

    const predicate = args.predicate ?? (() => true);
    const seenEvents: StreamEvent[] = [];
    const subscription = createStreamSubscription();
    const timeout = Promise.withResolvers<never>();
    const timer = setTimeout(() => {
      timeout.reject(
        new Error(`Timed out waiting for stream event. Saw: ${JSON.stringify(seenEvents)}`),
      );
    }, args.timeoutMs);
    let handle: { unsubscribe(): void } | undefined;

    try {
      handle = this.subscribe({
        eventTypes: args.eventTypes,
        replayAfterOffset: args.afterOffset,
        subscriber: { description: "waitForEvent" },
        processEventBatch: subscription.processEventBatch as Parameters<
          Stream["subscribe"]
        >[0]["processEventBatch"],
      });

      const match = (async () => {
        // Batches are queued synchronously; async predicate work happens here
        // so stream delivery is never blocked on caller code.
        for await (const batch of subscription) {
          seenEvents.push(...batch.events);
          for (const event of batch.events) {
            if (await predicate(event)) return event;
          }
        }
        throw new Error("Stream subscription closed before matching event.");
      })();

      // If timeout wins, cleanup closes the iterator; observe that loser too.
      void match.catch(() => {});
      return await Promise.race([match, timeout.promise]);
    } finally {
      clearTimeout(timer);
      handle?.unsubscribe();
      await subscription[Symbol.asyncDispose]();
    }
  }

  reduce(args: {
    event: StreamEvent;
    coreProcessorState?: StreamCoreProcessorState;
  }): StreamCoreProcessorState {
    const base = args.coreProcessorState ?? this.#coreProcessorState;

    return this.coreProcessor.reduceEvent({
      event: args.event,
      state: base,
    });
  }

  /**
   * Subscribes to catch-up then live event batches.
   *
   * `subscribe({ subscriptionKey: "s", processEventBatch })` live-tails by default. Passing
   * `replayAfterOffset: 0` replays from the first event before live delivery; passing
   * `replayAfterOffset: 3` starts at offset 4. Re-subscribing with the same key replaces
   * the old connection. Omit `subscriptionKey` for an anonymous subscription; the stream
   * assigns a random key and returns it. Call the returned `unsubscribe()` to stop
   * delivery.
   *
   * Every batch carries the stream's core reduced `state` as of
   * `streamMaxOffset`, and every subscription — with or without replay —
   * immediately receives one batch on open so the subscriber can paint its
   * first render without a separate getState call: the replay batch when there
   * is one, otherwise a batch with `events: []`.
   *
   * Pass `events: false` for a state-only subscription: same batches, but
   * `events` is always `[]` and consecutive appends coalesce into one state
   * delivery. Replay is meaningless without events, so state-only
   * subscriptions are implicitly live-from-now (`replayAfterOffset` ignored).
   */
  subscribe(args: Parameters<Stream["subscribe"]>[0]): {
    subscriptionKey: string;
    streamMaxOffset: number;
    unsubscribe(): void;
  } {
    const subscriptionKey = args.subscriptionKey?.trim() || crypto.randomUUID();
    return this.coreProcessor.openConnection({
      ...args,
      processEventBatch: args.processEventBatch as ProcessEventBatch,
      subscriber: args.subscriber as LiveStreamSubscriberDescriptor | undefined,
      subscriptionKey,
      direction: "inbound",
    });
  }

  subscribeOutbound(args: {
    subscriptionKey: string;
    processEventBatch: ProcessEventBatch;
    replayAfterOffset?: number;
    /** Only deliver these event types. Omit (or include `"*"`) for everything. */
    eventTypes?: readonly string[];
    /** Who is subscribing; lands on the stream's presence roster. */
    subscriber?: LiveStreamSubscriberDescriptor;
  }): { subscriptionKey: string; streamMaxOffset: number; unsubscribe(): void } {
    return this.coreProcessor.openConnection({ ...args, direction: "outbound" });
  }

  getProcessorRuntimeState(args: { subscriptionKey: string }) {
    return this.coreProcessor.getProcessorRuntimeState(args);
  }

  runtimeState() {
    return {
      coreProcessorState: this.#coreProcessorState,
      runtime: {
        connections: this.coreProcessor.connectionsRuntimeState(),
      },
    };
  }

  #idleTeardownMs(): number {
    const raw = (this.env as { STREAM_IDLE_TEARDOWN_MS?: string | number }).STREAM_IDLE_TEARDOWN_MS;
    const parsed = typeof raw === "string" ? Number(raw) : raw;
    return typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0
      ? parsed
      : DEFAULT_STREAM_IDLE_TEARDOWN_MS;
  }

  // Keep the in-memory idle timer armed only while the DO holds outbound
  // delivery connections (the thing that pins it resident). Reset on every
  // append; cleared once no outbound connection remains. No storage writes, and
  // nothing scheduled against a hibernated DO.
  #armOrClearIdleTimer(): void {
    if (this.#idleTimer !== undefined) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = undefined;
    }
    if (!this.coreProcessor.hasLiveOutboundConnections()) return;
    this.#idleTimer = setTimeout(() => this.runIdleTeardownNow(), this.#idleTeardownMs());
  }

  /**
   * Sever every idle outbound connection now — the idle timer's action, also
   * callable directly (tests / operator "put this quiet stream to sleep").
   * Disposes the retained callback stubs so the freed subscriber DOs hibernate;
   * the durable subscription config is kept, so the next append re-dials
   * (`needsOutboundReconcile` in `#appendBatchHere`).
   */
  runIdleTeardownNow(): void {
    this.#idleTimer = undefined;
    this.coreProcessor.closeIdleOutboundConnections();
  }

  /**
   * Wipes this stream's durable storage and aborts the current incarnation.
   * The next request boots a fresh stream (new `created` + `woken` events).
   */
  async reset(): Promise<void> {
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.sync();
    this.kill();
  }

  /** Kills the current Durable Object incarnation so experiments can observe restart behavior. */
  kill(): void {
    this.ctx.abort("kill requested");
  }

  /**
   * Dials a configured subscriber by dispatching its Callable descriptor with
   * the subscription handshake. The payload carries a live stream RpcTarget —
   * Callable's workers-rpc dispatch is plain Workers RPC, so the stub survives —
   * and the host is expected to call back `subscribe` to start receiving
   * batches.
   */
  async #connectOutboundConnection(args: {
    configured: CoreProcessorState["subscriptionsByKey"][string];
    subscriptionKey: string;
  }) {
    await dispatchCallable({
      callable: args.configured.latestConfiguredEvent.payload.subscriber.callable,
      ctx: {
        env: this.env as unknown as Record<string, unknown>,
        exports: (this.ctx as { exports?: Record<string, unknown> }).exports,
      },
      payload: {
        stream: new StreamRpcTarget({
          auth: trustedInternalAuthContext(),
          path: this.name.path,
          projectId: this.name.projectId === PLATFORM_PROJECT_ID ? null : this.name.projectId,
        }) as unknown as StreamRpc,
        subscriptionKey: args.subscriptionKey,
        streamMaxOffset: this.#coreProcessorState.maxOffset,
        streamRuntimeState: { coreProcessorState: this.#coreProcessorState },
      } satisfies StreamSubscriptionHandshake,
    });
  }
}

/**
 * Resolves `streamPath` against the current stream's path into a canonical
 * leading-slash path used for the target Durable Object name.
 *
 * Stream identity uses leading-slash paths everywhere — DO names, ancestor paths
 * and runner names all keep it — so resolution preserves
 * the leading slash rather than stripping it. Relative paths (`child`, `./child`,
 * `../sibling`) resolve against `basePath`; absolute paths (`/root/x`) resolve from
 * the root. `.` and empty segments are ignored, `..` pops a segment, and a `..` that
 * would pop past the root throws rather than silently clamping at `/`.
 */
export function resolveStreamPath(basePath: string, streamPath: string): string {
  const segments = streamPath.startsWith("/") ? [] : basePath.split("/").filter(Boolean);
  for (const segment of streamPath.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) {
        throw new Error(
          `streamPath "${streamPath}" escapes the stream root (resolved from "${basePath}")`,
        );
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

function parseStreamDurableObjectName(name: string | undefined) {
  if (!name) {
    throw new Error("Stream Durable Object must be addressed by name.");
  }
  return parseDurableObjectName(name);
}

function* chunkBytes(value: Uint8Array, chunkSize: number): Generator<[number, ArrayBuffer]> {
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new Error("chunkSize must be a positive integer.");
  }
  let chunkIndex = 0;
  for (let start = 0; start < value.byteLength; start += chunkSize) {
    const end = Math.min(start + chunkSize, value.byteLength);
    const chunk = new ArrayBuffer(end - start);
    new Uint8Array(chunk).set(value.subarray(start, end));
    yield [chunkIndex, chunk];
    chunkIndex += 1;
  }
  if (chunkIndex === 0) yield [0, new ArrayBuffer(0)];
}

function decodeChunks(chunks: ArrayBuffer[]): string {
  const textDecoder = new TextDecoder();
  let value = "";
  for (const chunk of chunks) value += textDecoder.decode(chunk, { stream: true });
  return value + textDecoder.decode();
}
