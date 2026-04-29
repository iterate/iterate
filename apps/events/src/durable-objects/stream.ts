import { DurableObject } from "cloudflare:workers";
import {
  type DestroyStreamResult,
  Event,
  EventInput,
  type ProjectSlug,
  STREAM_DURABLE_OBJECT_WOKE_UP_TYPE,
  STREAM_FIRST_INITIALIZED_TYPE,
  type StreamCursor,
  StreamPath,
  StreamState,
} from "@iterate-com/events-contract";
import { createDurableObjectClient, type SyncClient } from "sqlfu";
import { migrate } from "./db/migrations/.generated/migrations.ts";
import {
  getEventByIdempotencyKey,
  getReducedState,
  history as selectHistory,
  insertEvent,
  upsertReducedState,
} from "./db/queries/.generated/index.ts";
import {
  reduceBuiltinProcessors,
  runBuiltinAfterAppend,
  runBuiltinBeforeAppend,
} from "./builtin-processors.ts";
import { resetSubscriberSocketsForStream } from "./external-subscriber.ts";
import { createDynamicWorkerManager } from "./dynamic-processor.ts";
import { createInitialStreamState, reduceStreamCore } from "./stream-core-reducer.ts";
import { propagateInitializedStreamToAncestors } from "./stream-tree-propagation.ts";
import { getInitializedStreamStub, StreamOffsetPreconditionError } from "~/lib/stream-helpers.ts";

/**
 * One stream per Durable Object: an append-only event log persisted in SQLite,
 * with a reduced in-memory projection and newline-delimited fanout for live
 * readers.
 *
 * ## Append lifecycle
 *
 * Every event passes through three phases that intentionally mirror the hooks
 * on `Processor` / `BuiltinProcessor` in `@iterate-com/events-contract/sdk`:
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
  private readonly client: SyncClient;
  private readonly subscribers = new Set<ReadableStreamDefaultController<Uint8Array>>();
  private readonly dynamicWorkerManager: ReturnType<typeof createDynamicWorkerManager>;

  private get state(): StreamState {
    if (this._state == null) {
      throw new Error(
        "Stream durable object state was accessed before initialize({ projectSlug, path }) completed. Callers must use getInitializedStreamStub().",
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
    this.client = createDurableObjectClient(ctx.storage);
    // Dynamic workers are intentionally not "frameworkized" as a generic
    // processor runtime. This experimental feature owns its own manager in
    // `dynamic-processor.ts`, and `stream.ts` only provides the minimal stream
    // capabilities it needs: append/history/live-stream plus the dynamic worker
    // loader and the loopback egress binding.
    //
    // First-party references:
    // - Dynamic Workers overview: https://developers.cloudflare.com/dynamic-workers/
    // - RPC lifecycle / targets: https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/
    this.dynamicWorkerManager = createDynamicWorkerManager({
      append: (event) => this.append(event),
      history: (args) =>
        this.history({
          after: args?.after,
          before: args?.before,
        }),
      stream: (args) =>
        this.stream({
          after: args?.after,
          before: args?.before,
        }),
      createLoopbackBinding: ({ exportName }) => {
        if (exportName !== "DynamicWorkerEgressGateway") {
          throw new Error(`Unsupported loopback binding export: ${exportName}`);
        }

        return this.env.DYNAMIC_WORKER_EGRESS_GATEWAY as unknown as Fetcher;
      },
      getPath: () => this.state.path,
      getProjectSlug: () => this.state.projectSlug,
      loader: this.env.LOADER,
      waitUntil: (promise) => this.ctx.waitUntil(promise),
    });

    void this.ctx.blockConcurrencyWhile(async () => {
      migrate(this.client);

      const persistedStateRow = getReducedState(this.client);

      if (persistedStateRow == null) {
        return;
      }

      const rawState = JSON.parse(persistedStateRow.json);
      const parsed = StreamState.safeParse(rawState);
      if (parsed.success) {
        this._state = parsed.data;
        // Reconnect any previously configured dynamic workers before normal
        // traffic resumes. The manager restores one runtime per slug from the
        // reduced processor state, and then we append an explicit lifecycle
        // event so processor code can observe that this DO instance woke up.
        await this.dynamicWorkerManager.sync(parsed.data.processors["dynamic-worker"]);

        try {
          this.append({
            type: STREAM_DURABLE_OBJECT_WOKE_UP_TYPE,
            payload: {},
          });
        } catch (error) {
          console.error("[stream-do] failed to append durable-object-woke-up after rehydration", {
            path: parsed.data.path,
            error,
          });
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
   * { projectSlug, path } and set the initial state.
   *
   * All external callers go through `getInitializedStreamStub()` in
   * `~/lib/stream-helpers.ts`, which calls this before returning the stub.
   */
  initialize(args: { projectSlug: ProjectSlug; path: StreamPath }) {
    if (this._state != null) {
      return;
    }

    migrate(this.client);

    this._state = createInitialStreamState({
      projectSlug: args.projectSlug,
      path: args.path,
    });

    try {
      this.append({
        type: STREAM_FIRST_INITIALIZED_TYPE,
        payload: { projectSlug: args.projectSlug, path: args.path },
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
  // mirror the hook structure on BuiltinProcessor in `@iterate-com/events-contract/sdk`.
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
      if (existingEvent != null) {
        return existingEvent;
      }
    }

    const nextOffset = this.beforeAppend(input);

    const event = {
      streamPath: this.state.path,
      ...input,
      offset: nextOffset,
      createdAt: new Date().toISOString(),
    };

    const nextState = this.reduce(event);

    this.client.transaction((tx) => {
      insertEvent(tx, {
        offset: event.offset,
        type: event.type,
        payload: JSON.stringify(event.payload),
        metadata: event.metadata === undefined ? null : JSON.stringify(event.metadata),
        idempotencyKey: event.idempotencyKey ?? null,
        createdAt: event.createdAt,
      });
      upsertReducedState(tx, { json: JSON.stringify(nextState) });
    });
    this._state = nextState;

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
    if (input.type === STREAM_FIRST_INITIALIZED_TYPE && this.state.eventCount > 0) {
      throw new Error("stream-initialized may only be appended once");
    }

    const nextOffset = this.state.eventCount + 1;

    if (input.offset != null && input.offset !== nextOffset) {
      throw new StreamOffsetPreconditionError(
        `Client-supplied offset ${input.offset} does not match next generated offset ${nextOffset}.`,
      );
    }

    runBuiltinBeforeAppend({
      event: input,
      processors: this.state.processors,
    });

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

    let nextState = reduceStreamCore({
      state: this.state,
      event,
    });

    nextState = {
      ...nextState,
      processors: reduceBuiltinProcessors({
        event,
        processors: nextState.processors,
      }),
    };

    return nextState;
  }

  /**
   * Post-commit side effects, in order:
   *
   * 1. Subscriber fanout: push the committed event to all live pull-subscription
   *    readers connected via `stream()`.
   *
   * 2. Core propagation: after `stream-initialized`, notify every ancestor
   *    stream with `child-stream-created` in parallel. This is a structural
   *    concern of the stream tree, not something a pluggable processor should own.
   *
   * 3. Builtin processor afterAppend hooks: each processor may inspect the
   *    committed event and its own state slice, then optionally append derived
   *    events back into this stream.
   *
   */
  private afterAppend(event: Event) {
    this.publish(event);

    if (event.type === STREAM_FIRST_INITIALIZED_TYPE) {
      this.ctx.waitUntil(
        propagateInitializedStreamToAncestors({
          childInitializedEvent: event,
          projectSlug: this.state.projectSlug,
        }).catch((error) => {
          console.error("[stream-do] failed to propagate initialized stream to ancestors", {
            path: event.streamPath,
            error,
          });
        }),
      );
    }

    runBuiltinAfterAppend({
      append: (nextEvent) => this.append(nextEvent),
      event,
      processors: this.state.processors,
      waitUntil: (promise) => this.ctx.waitUntil(promise),
      onError: ({ error, event, processorSlug }) => {
        console.error("[stream-do] processor afterAppend failed", {
          path: this.state.path,
          processor: processorSlug,
          eventType: event.type,
          error,
        });
      },
    });

    this.ctx.waitUntil(
      this.dynamicWorkerManager
        .afterAppend({
          event,
          state: this.state.processors["dynamic-worker"],
        })
        .catch((error) => {
          console.error("[stream-do] dynamic worker manager afterAppend failed", {
            path: this.state.path,
            eventType: event.type,
            error,
          });
        }),
    );
  }

  // ---------------------------------------------------------------------------
  // State & lifecycle
  // ---------------------------------------------------------------------------

  getState(): StreamState {
    return this.state;
  }

  async destroy(args: { destroyChildren?: boolean } = {}): Promise<DestroyStreamResult> {
    const childEntries: DestroyStreamResult["finalStateByPath"] = args.destroyChildren
      ? await Promise.all(
          [...this.state.childPaths].sort().map(async (path) => {
            const stub = await getInitializedStreamStub({
              projectSlug: this.state.projectSlug,
              path,
            });
            return stub.destroy({ destroyChildren: true });
          }),
        ).then((results) =>
          results.reduce<DestroyStreamResult["finalStateByPath"]>(
            (acc, { finalStateByPath }) => ({ ...acc, ...finalStateByPath }),
            {},
          ),
        )
      : {};
    const stateBeforeDelete = structuredClone(this._state);
    const path = stateBeforeDelete?.path;

    for (const subscriber of this.subscribers) {
      try {
        subscriber.close();
      } catch {}
    }
    this.subscribers.clear();
    if (path != null) {
      resetSubscriberSocketsForStream(path);
    }

    await this.dynamicWorkerManager.dispose();

    await this.ctx.storage.deleteAll();

    this._state = null;

    const finalStateByPath: DestroyStreamResult["finalStateByPath"] = {
      ...childEntries,
      ...(path == null ? {} : { [path]: { finalState: stateBeforeDelete } }),
    };

    return {
      destroyedStreamCount: Object.keys(finalStateByPath).length,
      finalStateByPath,
    };
  }

  // ---------------------------------------------------------------------------
  // Pull subscriptions
  // ---------------------------------------------------------------------------

  history(args: { after?: StreamCursor; before?: StreamCursor } = {}): Event[] {
    const range = resolveStreamRange({
      after: args.after,
      before: args.before ?? "end",
      endOffset: this.state.eventCount,
    });

    return selectHistory(this.client, {
      afterOffset: range.afterOffset,
      beforeOffset: range.beforeOffset,
    }).flatMap((row) => {
      const event = this.parseEventRow(row);
      return event ? [event] : [];
    });
  }

  historyIfInitialized(args: { after?: StreamCursor; before?: StreamCursor } = {}): Event[] {
    if (this._state == null) {
      return [];
    }

    return this.history(args);
  }

  stream(args: { after?: StreamCursor; before?: StreamCursor } = {}): ReadableStream<Uint8Array> {
    const backlog = this.history({
      after: args.after,
      before: args.before ?? "end",
    });
    let subscriber: ReadableStreamDefaultController<Uint8Array> | undefined;

    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        for (const event of backlog) {
          controller.enqueue(encodeEventLine(event));
        }

        if (args.before != null) {
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

  private getEventByIdempotencyKey(idempotencyKey: string) {
    const row = getEventByIdempotencyKey(this.client, { idempotencyKey });
    return this.parseEventRow(row);
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

function resolveStreamRange(args: {
  after?: StreamCursor;
  before?: StreamCursor;
  endOffset: number;
}) {
  return {
    afterOffset: resolveAfterCursor(args.after, args.endOffset),
    beforeOffset: resolveBeforeCursor(args.before, args.endOffset),
  };
}

function resolveAfterCursor(cursor: StreamCursor | undefined, endOffset: number) {
  if (cursor == null || cursor === "start") {
    return 0;
  }

  if (cursor === "end") {
    return endOffset;
  }

  return cursor;
}

function resolveBeforeCursor(cursor: StreamCursor | undefined, endOffset: number) {
  if (cursor == null || cursor === "end") {
    return endOffset + 1;
  }

  if (cursor === "start") {
    return 1;
  }

  return cursor;
}

const textEncoder = new TextEncoder();

function encodeEventLine(event: Event) {
  return textEncoder.encode(`${JSON.stringify(event)}\n`);
}

// Shape parseEventRow accepts. The generated query Result types from
// db/queries/.generated use `string | undefined` for nullable columns,
// so this type is permissive enough to accept any of them.
type SqliteEventRow = {
  offset: number;
  type: string;
  payload: string;
  metadata?: string | null;
  idempotency_key?: string | null;
  created_at: string;
};
