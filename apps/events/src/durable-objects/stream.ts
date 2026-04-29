import { DurableObject } from "cloudflare:workers";
import {
  type ChildStreamCreatedEvent,
  type DestroyStreamResult,
  Event,
  EventInput,
  type ProjectSlug,
  STREAM_CHILD_STREAM_CREATED_TYPE,
  STREAM_DURABLE_OBJECT_WOKE_UP_TYPE,
  STREAM_FIRST_INITIALIZED_TYPE,
  STREAM_METADATA_UPDATED_TYPE,
  type StreamCursor,
  type StreamMetadataUpdatedEvent,
  StreamPath,
  StreamState,
} from "@iterate-com/events-contract";
import { createDurableObjectClient, type SyncClient } from "sqlfu";
import { circuitBreakerProcessor } from "./circuit-breaker.ts";
import { migrate } from "./db/migrations/.generated/migrations.ts";
import {
  getEventByIdempotencyKey,
  getReducedState,
  history as selectHistory,
  insertEvent,
  upsertReducedState,
} from "./db/queries/.generated/index.ts";
import { createDynamicWorkerManager, dynamicWorkerProcessor } from "./dynamic-processor.ts";
import {
  externalSubscriberProcessor,
  resetSubscriberSocketsForStream,
} from "./external-subscriber.ts";
import { jsonataTransformerProcessor } from "./jsonata-transformer.ts";
import { getAncestorStreamPaths } from "~/lib/stream-path-ancestors.ts";
import { getInitializedStreamStub, StreamOffsetPreconditionError } from "~/lib/stream-helpers.ts";

/**
 * One Stream durable object owns one append-only SQLite event log, its reduced
 * state, and lightweight newline-delimited live readers.
 *
 * Append lifecycle:
 * parse -> idempotency -> beforeAppend -> reduce -> commit -> afterAppend.
 *
 * `beforeAppend` is why builtin processors exist: only code running inside this
 * DO can reject an append before commit. Ordinary stream processors should run
 * outside this file as StreamProcessorRunners and coordinate through events.
 *
 * Durable Object rules:
 * https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
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
    // Dynamic workers are an event-service-owned processor deployment. Their
    // reduced state is handled by `dynamicWorkerProcessor` like any other
    // builtin processor; this manager reconciles that reduced state into live
    // Cloudflare Dynamic Worker instances.
    //
    // First-party references:
    // - https://developers.cloudflare.com/dynamic-workers/
    // - https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/
    this.dynamicWorkerManager = createDynamicWorkerManager({
      append: (event) => this.append(event),
      history: (args) => this.history(args),
      stream: (args) => this.stream(args),
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

      // Deliberately not crashing — throwing from the DO constructor makes the
      // object permanently unaddressable and much harder to debug. This is not
      // full recovery: initialize() cannot safely rebuild an existing stream
      // from events yet. See apps/events/tasks/rebuild-stream-state-on-parse-error.md.
      console.error(
        "[stream-do] persisted reduced_state failed validation, leaving _state null until explicit recovery is implemented",
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
   * 4. Dynamic worker runtime reconciliation: the `dynamic-worker` processor
   *    has already reduced configuration state; the manager turns that state
   *    into live Dynamic Worker instances.
   *
   * These are currently `waitUntil` tasks, so they are best-effort relative to
   * the committed source event. Correctness-critical derived work should move
   * behind a durable event/outbox cursor before we rely on it operationally.
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
    if (this._state == null) {
      this.closeSubscribers();
      await this.dynamicWorkerManager.dispose();
      await this.ctx.storage.deleteAll();
      return {
        destroyedStreamCount: 0,
        finalStateByPath: {},
      };
    }

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

    this.closeSubscribers();
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
        if (subscriber != null) {
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

  private closeSubscribers() {
    for (const subscriber of this.subscribers) {
      try {
        subscriber.close();
      } catch {}
    }

    this.subscribers.clear();
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

function createInitialStreamState(args: {
  projectSlug: ProjectSlug;
  path: StreamPath;
}): StreamState {
  return {
    projectSlug: args.projectSlug,
    path: args.path,
    eventCount: 0,
    childPaths: [],
    metadata: {},
    processors: createInitialBuiltinProcessorState(),
  };
}

/**
 * Builtin processors run inside the Stream durable object. Keep this list
 * small: `circuit-breaker` is genuinely privileged because it rejects appends
 * before commit; the others are in-process deployment choices until ordinary
 * StreamProcessorRunner deployments are ready for event-service-owned processors.
 */
const builtinProcessors = [
  circuitBreakerProcessor,
  externalSubscriberProcessor,
  dynamicWorkerProcessor,
  jsonataTransformerProcessor,
] as readonly unknown[] as readonly StreamBuiltinProcessor[];

function createInitialBuiltinProcessorState(): StreamState["processors"] {
  return Object.fromEntries(
    builtinProcessors.map((processor) => [processor.slug, structuredClone(processor.initialState)]),
  ) as StreamState["processors"];
}

function runBuiltinBeforeAppend(args: {
  event: EventInput;
  processors: StreamState["processors"];
}) {
  for (const processor of builtinProcessors) {
    processor.beforeAppend?.({
      event: args.event,
      state: getProcessorState(args.processors, processor.slug),
    });
  }
}

function reduceBuiltinProcessors(args: {
  event: Event;
  processors: StreamState["processors"];
}): StreamState["processors"] {
  let processors = args.processors;

  for (const processor of builtinProcessors) {
    if (processor.reduce == null) {
      continue;
    }

    processors = {
      ...processors,
      [processor.slug]: processor.reduce({
        event: args.event,
        state: getProcessorState(processors, processor.slug),
      }),
    };
  }

  return processors;
}

function runBuiltinAfterAppend(args: {
  append: (event: EventInput) => Event;
  event: Event;
  processors: StreamState["processors"];
  waitUntil: (promise: Promise<unknown>) => void;
  onError(args: { error: unknown; event: Event; processorSlug: string }): void;
}) {
  for (const processor of builtinProcessors) {
    const promise = processor.afterAppend?.({
      append: args.append,
      event: args.event,
      state: getProcessorState(args.processors, processor.slug),
    });

    if (promise == null) {
      continue;
    }

    args.waitUntil(
      promise.catch((error) => {
        args.onError({
          error,
          event: args.event,
          processorSlug: processor.slug,
        });
      }),
    );
  }
}

function getProcessorState(processors: StreamState["processors"], slug: string): unknown {
  return processors[slug as ProcessorSlugKey];
}

function reduceStreamCore(args: { state: StreamState; event: Event }): StreamState {
  let nextState: StreamState = {
    ...structuredClone(args.state),
    eventCount: args.state.eventCount + 1,
  };

  switch (args.event.type) {
    case STREAM_METADATA_UPDATED_TYPE: {
      const metadataUpdatedEvent = args.event as StreamMetadataUpdatedEvent;
      nextState = { ...nextState, metadata: metadataUpdatedEvent.payload.metadata };
      break;
    }
    case STREAM_CHILD_STREAM_CREATED_TYPE: {
      const childPath = getImmediateChildPath({
        parentPath: args.state.path,
        childPath: (args.event as ChildStreamCreatedEvent).payload.childPath,
      });
      if (childPath != null && !nextState.childPaths.includes(childPath)) {
        nextState = { ...nextState, childPaths: [...nextState.childPaths, childPath] };
      }
      break;
    }
  }

  return nextState;
}

function getImmediateChildPath(args: {
  parentPath: StreamPath;
  childPath: StreamPath;
}): StreamPath | null {
  if (args.childPath === args.parentPath) {
    return null;
  }

  if (args.parentPath === "/") {
    const [firstSegment] = args.childPath.split("/").filter(Boolean);
    return firstSegment == null ? null : StreamPath.parse(`/${firstSegment}`);
  }

  const parentPrefix = `${args.parentPath}/`;
  if (!args.childPath.startsWith(parentPrefix)) {
    return null;
  }

  const remainingPath = args.childPath.slice(parentPrefix.length);
  const [firstSegment] = remainingPath.split("/");
  return firstSegment == null ? null : StreamPath.parse(`${args.parentPath}/${firstSegment}`);
}

/**
 * Propagates a newly initialized stream to every ancestor as a
 * `child-stream-created` event.
 *
 * Each append uses a deterministic idempotency key so retries cannot create
 * duplicate topology events for the same parent/child pair.
 */
async function propagateInitializedStreamToAncestors(args: {
  childInitializedEvent: Event;
  projectSlug: ProjectSlug;
}) {
  const childPath = StreamPath.parse(args.childInitializedEvent.streamPath);
  const ancestorPaths = getAncestorStreamPaths(childPath);

  await Promise.all(
    ancestorPaths.map(async (path) => {
      const stream = await getInitializedStreamStub({
        projectSlug: args.projectSlug,
        path,
      });
      await stream.append({
        type: STREAM_CHILD_STREAM_CREATED_TYPE,
        payload: { childPath },
        metadata: args.childInitializedEvent.metadata,
        idempotencyKey: `child-stream-created:${path}:${childPath}`,
      });
    }),
  );
}

/**
 * Converts public stream cursors into the half-open SQLite offset range used
 * by the generated `history` query: offset > afterOffset and offset < beforeOffset.
 */
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

type ProcessorSlugKey = keyof StreamState["processors"];
type StreamBuiltinProcessor = {
  slug: string;
  initialState: unknown;
  beforeAppend?(args: { event: EventInput; state: unknown }): void;
  reduce?(args: { event: Event; state: unknown }): unknown;
  afterAppend?(args: {
    append: (event: EventInput) => Event;
    event: Event;
    state: unknown;
  }): Promise<void>;
};

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
