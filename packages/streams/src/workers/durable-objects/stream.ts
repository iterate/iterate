import { DurableObject } from "cloudflare:workers";
import {
  StreamEvent as StreamEventSchema,
  StreamEventInput as StreamEventInputSchema,
  type StreamEvent,
  type StreamEventInput,
} from "../../shared/event.ts";
import { getInitialProcessorState, runProcessorReduce } from "../../shared/stream-processors.ts";
import type { ProcessEventBatch, StreamCoreProcessorState } from "../../types.ts";
import type { ProcessorStream } from "../../processor-runner.ts";
import {
  getAncestorStreamPaths,
  catchUpCoreProcessorState,
  coreProcessor,
  reduceCoreProcessorStateFromEvents,
} from "../../processors/core/implementation.ts";
import { coreProcessorContract, type CoreProcessorState } from "../../processors/core/contract.ts";
import type { StreamRpc } from "../../types.ts";
import { makeRpcTargetClass } from "../../shared/rpc-target.ts";
import { disposeIgnoredRpcResult, retainProcessEventBatch } from "../rpc-lifecycle.ts";

export class Stream extends DurableObject<Env> implements StreamRpc {
  #coreProcessorState: StreamCoreProcessorState;
  #coreProcessor = coreProcessor.build({
    propagateChildStreamCreated: (state) => this.#propagateChildStreamCreated(state),
  });

  // Live delivery connections, keyed by subscriptionKey. Runtime-only: outbound
  // connections are recreated from reduced state, inbound from a fresh subscribe().
  #connections = new Map<string, Connection>();
  // subscriptionKeys with an outbound handshake in flight, so concurrent
  // reconciliation runs never dial the same runner twice.
  #connecting = new Set<string>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      -- Stream-owned append log. This is the same replay source that external
      -- StreamProcessorRunner DOs consume over subscribe().
      create table if not exists events (
        offset integer primary key autoincrement,
        type text not null,
        created_at text not null,
        idempotency_key text unique,
        raw_json text not null
      );
    `);

    this.#coreProcessorState = this.readCoreProcessorState();

    // When the durable object boots up the _first time_, we add a
    // events.iterate.com/stream/created event to the stream.
    //
    // And every time it's woken up for any reason (inbound fetch, rpc or alarm),
    // we append a "woken" event to the stream.
    if (this.#coreProcessorState.eventCount === 0) {
      // stream durable objects have names like "namespace:/some/stream/path"
      if (!ctx.id.name) throw new Error("ctx.id.name is falsey - this should never happen");
      const [namespace, path] = ctx.id.name.split(":");
      this.append({
        event: {
          type: "events.iterate.com/stream/created",
          payload: { namespace, path },
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

    // Restore outbound connections this stream should have. Without this, a stream
    // that wakes with configured subscriptions but no new appends never reconnects.
    this.#reconcile();
  }

  protected readCoreProcessorState(): StreamCoreProcessorState {
    const stored = this.ctx.storage.kv.get<unknown>("state");
    const storedState =
      stored === undefined
        ? this.#recoverCoreProcessorStateFromEventLog()
        : coreProcessorContract.stateSchema.parse(stored);
    if (storedState === undefined) return getInitialProcessorState(coreProcessorContract);

    const state = this.#catchUpCoreProcessorState(storedState);

    if (state.maxOffset !== storedState.maxOffset) {
      this.writeCoreProcessorState(state);
    }
    return state;
  }

  protected writeCoreProcessorState(state: StreamCoreProcessorState): void {
    this.ctx.storage.kv.put("state", state);
  }

  #catchUpCoreProcessorState(state: StreamCoreProcessorState): StreamCoreProcessorState {
    const highestOffset = this.#readHighestEventOffset();
    if (highestOffset <= state.maxOffset) return state;

    return catchUpCoreProcessorState({
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
      this.ctx.storage.sql.exec(
        `
          insert into events (offset, type, created_at, idempotency_key, raw_json)
          values (?, ?, ?, ?, ?)
        `,
        event.offset,
        event.type,
        event.createdAt,
        event.idempotencyKey ?? null,
        JSON.stringify(event),
      );
    }
  }

  #readEventByOffset(offset: number): StreamEvent | undefined {
    const row = this.ctx.storage.sql
      .exec<{ rawJson: string }>(
        `
          select raw_json as rawJson
          from events
          where offset = ?
          limit 1
        `,
        offset,
      )
      .toArray()[0];
    return row === undefined ? undefined : StreamEventSchema.parse(JSON.parse(row.rawJson));
  }

  #readEventByIdempotencyKey(idempotencyKey: string): StreamEvent | undefined {
    const row = this.ctx.storage.sql
      .exec<{ rawJson: string }>(
        `
          select raw_json as rawJson
          from events
          where idempotency_key = ?
          limit 1
        `,
        idempotencyKey,
      )
      .toArray()[0];
    return row === undefined ? undefined : StreamEventSchema.parse(JSON.parse(row.rawJson));
  }

  #readEventsInRange(args: {
    afterOffset: number;
    beforeOffset: number;
    limit: number;
  }): StreamEvent[] {
    return this.ctx.storage.sql
      .exec<{ rawJson: string }>(
        `
          select raw_json as rawJson
          from events
          where offset > ?
            and offset < ?
          order by offset asc
          limit ?
        `,
        args.afterOffset,
        args.beforeOffset,
        args.limit,
      )
      .toArray()
      .map((row) => StreamEventSchema.parse(JSON.parse(row.rawJson)));
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
    return reduceCoreProcessorStateFromEvents(events);
  }

  #resolveStream(streamPath: string): Pick<StreamRpc, "append" | "appendBatch"> {
    const resolvedPath = resolveStreamPath(this.#coreProcessorState.path, streamPath);
    if (resolvedPath === resolveStreamPath(this.#coreProcessorState.path, ".")) return this;
    return this.env.STREAM.getByName(`${this.#coreProcessorState.namespace}:${resolvedPath}`);
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
    let workingCoreProcessorState = this.#coreProcessorState;
    const events: StreamEvent[] = [];
    const newEvents: StreamEvent[] = [];
    const idempotencyHitsInBatch = new Map<string, StreamEvent>();
    const appendStream: ProcessorStream = {
      append: (appendArgs) => this.append(appendArgs),
      appendBatch: (appendArgs) => this.appendBatch(appendArgs),
    };

    // 1. Prepare events and reduced state.
    for (const eventInput of args.events) {
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

      this.#coreProcessor.beforeAppend?.({
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

      const previousCoreState = workingCoreProcessorState;

      const coreReduction = runProcessorReduce({
        processor: { contract: coreProcessorContract },
        event: committed,
        state: previousCoreState,
      });
      if (coreReduction === undefined) {
        throw new Error(`core processor cannot reduce event type "${committed.type}"`);
      }

      workingCoreProcessorState = coreProcessorContract.stateSchema.parse(coreReduction.state);

      this.#coreProcessor.afterAppend?.({
        event: coreReduction.event,
        previousState: previousCoreState,
        state: workingCoreProcessorState,
        streamMaxOffset: committed.offset,
        stream: appendStream,
        shouldApplySideEffects: () => true,
        blockProcessorUntil: (work) => void work(),
        keepAlive: (work) => void work,
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

    // 3. Wake live delivery; reconcile only when subscription topology changed.
    // Append success is already decided above — this is pure post-commit fan-out.
    for (const connection of this.#connections.values()) connection.wake();
    if (
      newEvents.some((event) => event.type === "events.iterate.com/stream/subscription-configured")
    ) {
      this.#reconcile();
    }

    return events;
  }

  #propagateChildStreamCreated(state: CoreProcessorState) {
    for (const ancestorPath of getAncestorStreamPaths(state.path)) {
      const stream = this.env.STREAM.getByName(`${state.namespace}:${ancestorPath}`);
      Promise.resolve(
        stream.append({
          event: {
            type: "events.iterate.com/stream/child-stream-created",
            idempotencyKey: `child-stream-created:${ancestorPath}:${state.path}`,
            payload: { childPath: state.path },
          },
        }),
      ).catch((error: unknown) => {
        console.error("failed to propagate child stream event", error);
      });
    }
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

    const coreReduction = runProcessorReduce({
      processor: { contract: coreProcessorContract },
      event: args.event,
      state: base,
    });
    if (coreReduction === undefined) {
      throw new Error(`core processor cannot reduce event type "${args.event.type}"`);
    }

    return coreProcessorContract.stateSchema.parse(coreReduction.state);
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
  }): { subscriptionKey: string; streamMaxOffset: number; unsubscribe(): void } {
    // Type-filtered subscriptions belong here later. For now every subscription
    // observes the stream's full ordered event log after its offset boundary.
    const subscriptionKey = args.subscriptionKey?.trim() || crypto.randomUUID();
    return this.#openConnection({ ...args, subscriptionKey, direction: "inbound" });
  }

  subscribeOutbound(args: {
    subscriptionKey: string;
    processEventBatch: ProcessEventBatch;
    replayAfterOffset?: number;
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
    onClose?: () => void;
  }): { subscriptionKey: string; streamMaxOffset: number; unsubscribe(): void } {
    const subscriptionKey = args.subscriptionKey.trim();
    if (subscriptionKey.length === 0) throw new Error("subscriptionKey must not be blank.");

    // Replacing any existing connection for this key.
    this.#connections.get(subscriptionKey)?.close();

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
          const events = this.getEvents({ afterOffset: cursor, limit: 100 }); // limit hardcoded for now
          const lastOffset = events.at(-1)?.offset;
          if (lastOffset === undefined) return; // caught up; the next append wakes us again
          cursor = lastOffset;
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
    processEventBatch.onRpcBroken?.(() => connection.close());
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

  async #connectOutboundConnection(args: {
    configured: CoreProcessorState["subscriptionsByKey"][string];
    subscriptionKey: string;
  }) {
    const streamName = `${this.#coreProcessorState.namespace}:${this.#coreProcessorState.path}`;
    await this.env.STREAM_PROCESSOR_RUNNER.getByName(
      `${streamName}:${args.subscriptionKey}`,
    ).requestSubscription({
      stream: new StreamRpcTarget(this) as unknown as StreamRpc,
      subscriptionKey: args.subscriptionKey,
      streamMaxOffset: this.#coreProcessorState.maxOffset,
      subscriptionConfiguredEvent: args.configured.latestConfiguredEvent,
      streamRuntimeState: { coreProcessorState: this.#coreProcessorState },
    });
  }
}

// Wraps the Stream Durable Object in an RpcTarget that can be passed across
// Workers RPC boundaries without attempting to structured-clone the DO itself.
export const StreamRpcTarget = makeRpcTargetClass(Stream);

/**
 * Resolves `streamPath` against the current stream's path into a canonical
 * leading-slash path used for the target DO name (`${namespace}:${path}`).
 *
 * Stream identity uses leading-slash paths everywhere — DO names, ancestor names
 * (getAncestorStreamPaths) and runner names all keep it — so resolution preserves
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
