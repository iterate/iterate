import { DurableObject } from "cloudflare:workers";
import { dispatchCallable } from "@iterate-com/shared/callable/runtime.ts";
import {
  StreamEvent as StreamEventSchema,
  StreamEventInput as StreamEventInputSchema,
  type StreamEvent,
  type StreamEventInput,
} from "../../shared/event.ts";
import type { StreamSubscriptionHandshake } from "../stream-processor-host.ts";
import { getInitialProcessorState } from "../../shared/stream-processors.ts";
import type { ProcessEventBatch, StreamCoreProcessorState } from "../../types.ts";
import { CoreStreamProcessor } from "../../processors/core/implementation.ts";
import { CoreProcessorContract, type CoreProcessorState } from "../../processors/core/contract.ts";
import type { StreamRpc } from "../../types.ts";
import { makeRpcTargetClass, type RpcTargetClass } from "../../shared/rpc-target.ts";
import { disposeIgnoredRpcResult, retainProcessEventBatch } from "../rpc-lifecycle.ts";

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
const CORE_STATE_VERSION = 3;

export class Stream extends DurableObject<Env> implements StreamRpc {
  #coreProcessorState: StreamCoreProcessorState;
  // Whether the SQLite tables exist yet. A stream that has never been appended
  // to has no storage and no events; both are created lazily by the first append.
  #storageReady: boolean;
  coreProcessor = new CoreStreamProcessor({
    iterateContext: {
      stream: {
        append: (args) => this.append(args),
        appendBatch: (args) => this.appendBatch(args),
      },
    },
  });

  // Live delivery connections, keyed by subscriptionKey. Runtime-only: outbound
  // connections are recreated from reduced state, inbound from a fresh subscribe().
  #connections = new Map<string, Connection>();
  // subscriptionKeys with an outbound handshake in flight, so concurrent
  // reconciliation runs never dial the same runner twice.
  #connecting = new Set<string>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Lazy initialization: a never-appended stream has no tables. Don't create
    // them here — only detect whether a prior incarnation already did.
    this.#storageReady = this.#eventsTableExists();
    this.#coreProcessorState = this.readCoreProcessorState();

    // An uninitialized stream stays completely empty: no storage, no `created`,
    // no `woken`, nothing to reconcile — connecting to a stream you never append
    // to leaves no trace. The first append initializes it with `created` +
    // `woken` (see `#appendBatchHere`). An already-initialized stream waking up
    // records this incarnation's `woken` and restores any outbound subscriptions
    // it should have — without this, a stream that wakes with configured
    // subscriptions but no new appends never reconnects.
    if (this.#coreProcessorState.maxOffset > 0) {
      this.append({
        event: {
          type: "events.iterate.com/stream/woken",
          payload: { incarnationId: crypto.randomUUID() },
        },
      });
      this.#reconcile();
    }
  }

  /** Cheap existence check that does not itself create the table. */
  #eventsTableExists(): boolean {
    return (
      this.ctx.storage.sql
        .exec("select 1 from sqlite_master where type = 'table' and name = 'events' limit 1")
        .toArray().length > 0
    );
  }

  #ensureStorageSchema(): void {
    // Keep storage normalized:
    // - `events` is the offset-ordered metadata/index table.
    // - `event_chunks` stores the full event JSON as bounded UTF-8 byte rows.
    this.#createEventsTable();
    this.#createEventChunksTable();
    this.#storageReady = true;
  }

  /**
   * The stream's identity, from its DO name (`namespace:/some/stream/path`).
   * This is the source of truth even before initialization — a lazily
   * uninitialized stream's reduced state still holds the `"uninitialized"`
   * placeholders, so path resolution and the `created` event must use the name.
   */
  #streamIdentity(): { namespace: string; path: string } {
    if (!this.ctx.id.name) throw new Error("ctx.id.name is falsey - this should never happen");
    const [namespace, path] = this.ctx.id.name.split(":");
    return { namespace, path };
  }

  /**
   * The events the first append prepends to lazily initialize a stream:
   * `created` (offset 1) then `woken` for the initializing incarnation. Later
   * incarnations append their own `woken` from the constructor.
   */
  #initEventInputs(): StreamEventInput[] {
    const { namespace, path } = this.#streamIdentity();
    return [
      { type: "events.iterate.com/stream/created", payload: { namespace, path } },
      {
        type: "events.iterate.com/stream/woken",
        payload: { incarnationId: crypto.randomUUID() },
      },
    ];
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
      : // No usable KV state. Replay the event log only if storage exists; a
        // never-appended stream has no tables and is simply uninitialized.
        this.#storageReady
        ? this.#recoverCoreProcessorStateFromEventLog()
        : undefined;
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
    if (!this.#storageReady) return 0;
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
    if (!this.#storageReady) return undefined;
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
    if (!this.#storageReady) return undefined;
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
    if (!this.#storageReady) return [];
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

  #resolveStream(streamPath: string): Pick<StreamRpc, "append" | "appendBatch"> {
    // Resolve against the DO's own name, not reduced state: a lazily
    // uninitialized stream has only `"uninitialized"` placeholders in state, but
    // its real namespace/path are always known from its name. Without this,
    // appending to a relative child of a not-yet-appended parent targets the
    // wrong stream.
    const { namespace, path } = this.#streamIdentity();
    const resolvedPath = resolveStreamPath(path, streamPath);
    if (resolvedPath === resolveStreamPath(path, ".")) return this;
    return this.env.STREAM.getByName(`${namespace}:${resolvedPath}`);
  }

  /**
   * Convenience RPC for appending one event.
   *
   * Uses `appendBatch()`, so all append ordering and persistence stays in one place.
   */
  append(args: {
    streamPath?: string;
    event: StreamEventInput;
  }): StreamEvent | Promise<StreamEvent> {
    if (args.streamPath !== undefined) {
      return this.#resolveStream(args.streamPath).append({ event: args.event });
    }
    return this.#appendBatchHere({ events: [args.event] })[0]!;
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
  appendBatch(args: {
    streamPath?: string;
    events: StreamEventInput[];
  }): StreamEvent[] | Promise<StreamEvent[]> {
    if (args.streamPath !== undefined) {
      return this.#resolveStream(args.streamPath).appendBatch({ events: args.events });
    }

    return this.#appendBatchHere({ events: args.events });
  }

  #appendBatchHere(args: { events: StreamEventInput[] }): StreamEvent[] {
    // Lazy initialization: the first real append creates storage and prepends
    // `created` (offset 1) + `woken` (offset 2). A never-appended stream has no
    // tables and no events; an empty append leaves it that way.
    let inputEvents = args.events;
    let prependedCount = 0;
    if (
      this.#coreProcessorState.maxOffset === 0 &&
      inputEvents.length > 0 &&
      inputEvents[0]?.type !== "events.iterate.com/stream/created"
    ) {
      const init = this.#initEventInputs();
      inputEvents = [...init, ...inputEvents];
      prependedCount = init.length;
    }
    if (inputEvents.length > 0 && !this.#storageReady) {
      this.#ensureStorageSchema();
    }

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
    for (const eventInput of inputEvents) {
      const input = StreamEventInputSchema.strict().parse(eventInput);

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
      // stale pre-append state (on a brand-new stream that is the
      // "uninitialized" placeholder namespace/path).
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

    // 3. Wake live delivery; reconcile only when subscription topology changed.
    // Append success is already decided above — this is pure post-commit fan-out.
    for (const connection of this.#connections.values()) connection.wake();
    if (
      newEvents.some((event) => event.type === "events.iterate.com/stream/subscription-configured")
    ) {
      this.#reconcile();
    }

    // Return only the caller's events, input-aligned. The `created`/`woken`
    // events we prepended for lazy init are committed but are not part of the
    // caller's batch.
    return prependedCount > 0 ? events.slice(prependedCount) : events;
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
  ): StreamEvent[] {
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
    });
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
   */
  subscribe(args: {
    subscriptionKey?: string;
    processEventBatch: ProcessEventBatch;
    replayAfterOffset?: number;
    /** Only deliver these event types. Omit (or include `"*"`) for everything. */
    eventTypes?: readonly string[];
  }): { subscriptionKey: string; streamMaxOffset: number; unsubscribe(): void } {
    const subscriptionKey = args.subscriptionKey?.trim() || crypto.randomUUID();
    return this.#openConnection({ ...args, subscriptionKey, direction: "inbound" });
  }

  subscribeOutbound(args: {
    subscriptionKey: string;
    processEventBatch: ProcessEventBatch;
    replayAfterOffset?: number;
    /** Only deliver these event types. Omit (or include `"*"`) for everything. */
    eventTypes?: readonly string[];
  }): { subscriptionKey: string; streamMaxOffset: number; unsubscribe(): void } {
    return this.#openConnection({ ...args, direction: "outbound" });
  }

  runtimeState() {
    return {
      coreProcessorState: this.#coreProcessorState,
      runtime: {
        connections: Object.fromEntries(
          [...this.#connections].map(([subscriptionKey, connection]) => [
            subscriptionKey,
            {
              direction: connection.direction,
              startedAt: connection.startedAt,
              cursor: connection.cursor,
              batchesSent: connection.batchesSent,
              eventsSent: connection.eventsSent,
              lastDeliveredAt: connection.lastDeliveredAt,
            },
          ]),
        ),
      },
    };
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
   * Opens (or replaces) a live delivery connection for one subscriptionKey.
   *
   * A connection is just a pump: it delivers everything after `cursor` in offset
   * order, then parks. There is no catch-up-vs-live distinction — replay and live
   * are the same `getEvents(afterOffset: cursor)` loop. `appendBatch` re-arms the
   * pump via `wake()`; the `draining` guard makes that idempotent and race-free.
   *
   * What actually happens (stream has offsets 1..3, subscribe with `replayAfterOffset: 0`):
   * - open: `cursor = 0`, `wake()` -> pump reads `(>0)` -> delivers `[1, 2, 3]`,
   *   `cursor = 3` → reads `(>3)` → empty → parks.
   * - append offset 4 → `wake()` → pump reads `(>3)` → delivers `[4]`, `cursor = 4`
   *   → empty → parks. One batch per append while the subscriber keeps up.
   *
   * The `draining` guard is what removes the old catch-up/live race. If an append's
   * `wake()` lands while a slow pump is still mid-drain, it early-returns; the
   * in-flight loop's next `getEvents` sees the just-committed rows (commit happens
   * before `wake()`), so the event is delivered exactly once — never dropped, never
   * doubled, no matter the interleaving. A backlog (subscriber fell behind, or first
   * replay of 10k events) drains 100 at a time, yielding between batches so other
   * connections and incoming appends still make progress.
   */
  #openConnection(args: {
    direction: "inbound" | "outbound";
    subscriptionKey: string;
    processEventBatch: ProcessEventBatch;
    replayAfterOffset?: number;
    eventTypes?: readonly string[];
    onClose?: () => void;
  }): { subscriptionKey: string; streamMaxOffset: number; unsubscribe(): void } {
    const subscriptionKey = args.subscriptionKey.trim();
    if (subscriptionKey.length === 0) throw new Error("subscriptionKey must not be blank.");

    // Replacing any existing connection for this key.
    this.#connections.get(subscriptionKey)?.close();

    // Optional event-type filter (processor hosts pass their contract's
    // `consumes`). The cursor still advances past non-matching events — they
    // are skipped, not deferred — so a subscriber's resume offset can sit on a
    // filtered-out event without ever re-delivering it.
    const eventTypeFilter =
      args.eventTypes === undefined || args.eventTypes.includes("*")
        ? undefined
        : new Set(args.eventTypes);

    // Workers RPC disposes parameter stubs when an RPC method returns unless the
    // callee duplicates them. Keep a retained callback because this stream calls
    // it later from the pump, after subscribe() has returned:
    // https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/
    const processEventBatch = retainProcessEventBatch(args.processEventBatch);
    let cursor = args.replayAfterOffset ?? this.#coreProcessorState.maxOffset;
    let draining = false;
    let open = true;

    // The single delivery path: drain committed events to the callback, then park.
    //
    // FUTURE OPTIMIZATION (Proposal B): the live path currently pays one indexed
    // `getEvents` read per batch even when the subscriber has caught up to maxOffset.
    // `appendBatch` already has the freshly-committed events array in memory, so when
    // `cursor === firstNewOffset - 1` it could hand that array straight to the callback and
    // skip the SQL round-trip — a pure fast path that can't desync because `cursor`
    // stays the source of truth (a behind/draining connection just falls back to this
    // loop). Not worth it until a benchmark shows the per-batch read in the hot path;
    // keeping one delivery path is the simpler default.
    const pump = async () => {
      if (draining) return;
      draining = true;
      try {
        while (open) {
          const readEvents = this.getEvents({ afterOffset: cursor, limit: 100 }); // limit hardcoded for now
          const lastOffset = readEvents.at(-1)?.offset;
          if (lastOffset === undefined) return; // caught up; the next append wakes us again
          cursor = lastOffset;
          const events =
            eventTypeFilter === undefined
              ? readEvents
              : readEvents.filter((event) => eventTypeFilter.has(event.type));
          if (events.length === 0) continue; // whole batch filtered out; keep draining
          connection.batchesSent += 1;
          connection.eventsSent += events.length;
          connection.lastDeliveredAt = new Date().toISOString();
          // Batch-first, fire-and-forget: never await the remote result. Both
          // Workers RPC and Cap'n Web return disposable thenables for remote calls;
          // dispose ignored results so we do not retain return capabilities.
          // https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/
          // https://github.com/cloudflare/capnweb#memory-management
          const pendingBatch = processEventBatch({
            namespace: this.#coreProcessorState.namespace,
            path: this.#coreProcessorState.path,
            events,
            streamMaxOffset: this.#coreProcessorState.maxOffset,
          });
          disposeIgnoredRpcResult(pendingBatch);
          await Promise.resolve();
        }
      } finally {
        draining = false;
      }
    };

    const connection: Connection = {
      direction: args.direction,
      startedAt: new Date().toISOString(),
      get cursor() {
        return cursor;
      },
      batchesSent: 0,
      eventsSent: 0,
      wake: () => void pump(),
      close: () => {
        if (!open) return;
        open = false;
        if (this.#connections.get(subscriptionKey) === connection) {
          this.#connections.delete(subscriptionKey);
        }
        processEventBatch[Symbol.dispose]();
        args.onClose?.();
      },
    };

    this.#connections.set(subscriptionKey, connection);
    processEventBatch.onRpcBroken?.(() => {
      connection.close();
      if (args.direction === "outbound") this.#reconcile();
    });
    connection.wake();

    return {
      subscriptionKey,
      streamMaxOffset: this.#coreProcessorState.maxOffset,
      unsubscribe: () => connection.close(),
    };
  }

  /** Fire-and-forget outbound reconciliation; never blocks the append path. */
  #reconcile() {
    try {
      this.#reconcileOutboundConnections();
    } catch (error) {
      console.error("Stream outbound reconciliation failed", error);
    }
  }

  /**
   * Makes runtime outbound connections match the persisted subscription config:
   * closes connections whose config disappeared, dials a runner for each configured
   * subscription that has none. Triggered on boot, on subscription-configured
   * appends, and on outbound connection loss — never per-append.
   *
   * Built-in processors use same-account Workers RPC: the stream wakes the runner
   * DO, and the runner calls back into subscribeOutbound({ processEventBatch }).
   * Cloudflare recommends Worker/DO RPC methods for same-account Worker entrypoints:
   * https://developers.cloudflare.com/workers/runtime-apis/rpc/
   * https://developers.cloudflare.com/durable-objects/best-practices/create-durable-object-stubs-and-send-requests/
   */
  #reconcileOutboundConnections() {
    for (const [subscriptionKey, connection] of this.#connections) {
      if (
        connection.direction === "outbound" &&
        this.#coreProcessorState.subscriptionsByKey[subscriptionKey] === undefined
      ) {
        connection.close();
      }
    }

    for (const [subscriptionKey, configured] of Object.entries(
      this.#coreProcessorState.subscriptionsByKey,
    )) {
      if (this.#connections.has(subscriptionKey) || this.#connecting.has(subscriptionKey)) continue;

      // Reserve the key before any await so a concurrent reconcile can't dial twice.
      this.#connecting.add(subscriptionKey);
      this.ctx.waitUntil(
        this.#connectOutboundConnection({ configured, subscriptionKey })
          .catch((error: unknown) => {
            console.error("Stream outbound connection failed", { error, subscriptionKey });
          })
          .finally(() => {
            this.#connecting.delete(subscriptionKey);
          }),
      );
    }
  }

  /**
   * Dials a configured subscriber by dispatching its Callable descriptor with
   * the subscription handshake. The payload carries a live stream RpcTarget —
   * Callable's workers-rpc dispatch is plain Workers RPC, so the stub survives —
   * and the host is expected to call back `subscribeOutbound` to start
   * receiving batches.
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
        stream: new StreamRpcTarget(this) as unknown as StreamRpc,
        subscriptionKey: args.subscriptionKey,
        streamMaxOffset: this.#coreProcessorState.maxOffset,
        subscriptionConfiguredEvent: args.configured.latestConfiguredEvent,
        streamRuntimeState: { coreProcessorState: this.#coreProcessorState },
      } satisfies StreamSubscriptionHandshake,
    });
  }
}

// Allowlist the RPC surface explicitly. The Stream DO has `protected` helpers
// (readCoreProcessorState/writeCoreProcessorState) that are public at runtime;
// a denylist would leak them onto the unauthenticated PublicStreamRpcTarget,
// where writeCoreProcessorState could inject an attacker-chosen subscription
// callable. `subscribe` is intentionally absent: installSubscribeRpcTargetOverride
// adds its own forwarding implementation below.
const STREAM_RPC_METHODS = [
  "append",
  "appendBatch",
  "getEvent",
  "getEvents",
  "runtimeState",
  "reduce",
  "kill",
  "reset",
] as const satisfies readonly (keyof StreamRpc)[];

export const StreamRpcTarget = makeRpcTargetClass<StreamRpc, StreamRpc>(
  Stream as { prototype: StreamRpc },
  { include: [...STREAM_RPC_METHODS, "subscribeOutbound"] },
);
installSubscribeRpcTargetOverride(StreamRpcTarget);

export const PublicStreamRpcTarget = makeRpcTargetClass<StreamRpc, StreamRpc>(
  Stream as { prototype: StreamRpc },
  { include: STREAM_RPC_METHODS },
);
installSubscribeRpcTargetOverride(PublicStreamRpcTarget);

function installSubscribeRpcTargetOverride(target: RpcTargetClass<StreamRpc, StreamRpc>) {
  Object.defineProperty(target.prototype, "subscribe", {
    async value(this: { source: StreamRpc }, args: Parameters<StreamRpc["subscribe"]>[0]) {
      // The generated target can proxy ordinary methods directly. subscribe() is
      // the only special case because it receives a callback that lives beyond the
      // subscribe RPC return; keep that callback local to this Worker and forward a
      // fire-and-forget callback to the DO so batch delivery produces no client
      // `resolve(undefined)` traffic.
      const clientProcessEventBatch = retainProcessEventBatch(args.processEventBatch);
      let disposed = false;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        clientProcessEventBatch[Symbol.dispose]();
      };
      const processEventBatch: ProcessEventBatch & Disposable = Object.assign(
        (batch: Parameters<ProcessEventBatch>[0]) => {
          const pendingBatch = clientProcessEventBatch(batch);
          disposeIgnoredRpcResult(pendingBatch);
        },
        { [Symbol.dispose]: dispose },
      );

      try {
        const subscription = await this.source.subscribe({
          subscriptionKey: args.subscriptionKey,
          replayAfterOffset: args.replayAfterOffset,
          processEventBatch,
        });

        clientProcessEventBatch.onRpcBroken?.(() => {
          disposeIgnoredRpcResult(subscription.unsubscribe());
          dispose();
        });

        return {
          subscriptionKey: subscription.subscriptionKey,
          streamMaxOffset: subscription.streamMaxOffset,
          unsubscribe() {
            disposeIgnoredRpcResult(subscription.unsubscribe());
            dispose();
          },
        };
      } catch (error) {
        clientProcessEventBatch[Symbol.dispose]();
        throw error;
      }
    },
  });
}

/**
 * Resolves `streamPath` against the current stream's path into a canonical
 * leading-slash path used for the target DO name (`${namespace}:${path}`).
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

/**
 * A live delivery connection from this stream to one subscriber callback. Not persisted;
 * the callback and pump state live in the `#openConnection` closure, so this is just the
 * metrics counters plus the two control verbs the stream calls.
 */
type Connection = {
  readonly direction: "inbound" | "outbound";
  readonly startedAt: string;
  /** Highest offset delivered to the callback; also the pump's resume cursor. */
  readonly cursor: number;
  batchesSent: number;
  eventsSent: number;
  lastDeliveredAt?: string;
  /** Re-arm the delivery pump after events are committed. Idempotent while draining. */
  wake(): void;
  /** Stop the pump, dispose the callback, run teardown, drop from the map. Idempotent. */
  close(): void;
};
