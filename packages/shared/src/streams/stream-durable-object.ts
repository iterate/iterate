import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { createDurableObjectClient, type SyncClient } from "sqlfu";
import type { CallableContext } from "@iterate-com/shared/callable/types.ts";
import { withDurableObjectCore } from "@iterate-com/shared/durable-object-utils/mixins/with-durable-object-core";
import { withD1ObjectCatalog } from "@iterate-com/shared/durable-object-utils/mixins/with-d1-object-catalog";
import { withKvInspector } from "@iterate-com/shared/durable-object-utils/mixins/with-kv-inspector";
import { withLifecycleHooks } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import { withOuterbase } from "@iterate-com/shared/durable-object-utils/mixins/with-outerbase";
import { withPublicFetchRoute } from "@iterate-com/shared/durable-object-utils/mixins/with-public-fetch-route";
import {
  ChildStreamCreatedEvent,
  type DestroyStreamResult,
  Event,
  EventInput,
  type ExternalSubscriber,
  STREAM_CHILD_STREAM_CREATED_TYPE,
  STREAM_DURABLE_OBJECT_WOKE_UP_TYPE,
  STREAM_ERROR_OCCURRED_TYPE,
  STREAM_FIRST_INITIALIZED_TYPE,
  StreamNamespace,
  StreamInitializedEvent,
  STREAM_METADATA_UPDATED_TYPE,
  type StreamCursor,
  StreamMetadataUpdatedEvent,
  StreamPath,
  StreamState,
} from "./types.ts";
import { circuitBreakerProcessor } from "./circuit-breaker.ts";
import { migrate } from "./db/migrations/.generated/migrations.ts";
import {
  countIdempotentEvents,
  getEventByIdempotencyKey,
  getReducedState,
  history as selectHistory,
  insertEvent,
  listIdempotencyDuplicateAttemptSources,
  listIdempotencyDuplicateAttempts,
  summarizeIdempotencyDuplicateAttempts,
  upsertIdempotencyDuplicateAttemptSource,
  upsertIdempotencyDuplicateAttempt,
  upsertReducedState,
} from "./db/queries/.generated/index.ts";
import {
  externalSubscriberProcessor,
  publishExternalSubscriberBatch,
  publishExternalSubscribers,
  resetSubscriberSocketsForStream,
  type ExternalSubscriberPublishFailure,
} from "./external-subscriber.ts";
import {
  getInitializedStreamStub,
  StreamOffsetPreconditionError,
  type StreamDurableObjectNamespace,
} from "./helpers.ts";
import { getAncestorStreamPaths } from "./stream-path-ancestors.ts";

export type StreamDurableObjectStructuredName = {
  namespace: string;
  path: StreamPath;
};

type StreamDurableObjectEnv = {
  DO_CATALOG: D1Database;
  STREAM: DurableObjectNamespace<StreamDurableObject>;
} & Record<string, unknown>;

const CALLABLE_SUBSCRIBER_CURSOR_KEY_PREFIX = "stream-do:callable-subscriber-cursor";
const CALLABLE_SUBSCRIBER_ALARM_BATCH_SIZE = 500;
const CALLABLE_SUBSCRIBER_ALARM_MAX_BATCHES = 50;
const CALLABLE_SUBSCRIBER_DIAGNOSTIC_LIMIT = 20;
const APPEND_BATCH_DIAGNOSTIC_LIMIT = 20;
const IMMEDIATE_EXTERNAL_SUBSCRIBERS: ReadonlySet<ExternalSubscriber["type"]> = new Set([
  "webhook",
]);
const ALARM_DELIVERED_EXTERNAL_SUBSCRIBERS: ReadonlySet<ExternalSubscriber["type"]> = new Set([
  "callable",
  "websocket",
]);
const IDEMPOTENCY_DIAGNOSTIC_LIMIT = 50;

type IdempotencyDuplicateDiagnostic = {
  duplicateAttempts: number;
  eventType: string;
  firstDuplicateAtMs: number;
  idempotencyKey: string;
  lastDuplicateAtMs: number;
  sourceLabels: string[];
  streamPath: string;
  targetOffset: number;
};

type CallableSubscriberDeliveryDiagnostic = {
  batchIterations: number;
  completedAtMs: number;
  cursorReadCount: number;
  cursorWriteCount: number;
  deliveredEventCount: number;
  durationMs: number;
  emptyWindowCount: number;
  error?: string;
  failedEventCount: number;
  historyReadCount: number;
  rescheduled: boolean;
  startedAtMs: number;
  subscriberCheckCount: number;
  subscriberDeliveries: CallableSubscriberDeliveryAttemptDiagnostic[];
  targetEventCount: number;
  uniqueHistoryWindowCount: number;
  yielded: boolean;
};

type CallableSubscriberDeliveryAttemptDiagnostic = {
  beforeOffset: number;
  completedAtMs: number;
  cursor: number;
  deliveredEventCount: number;
  dispatchDurationMs: number;
  durationMs: number;
  failedEventCount: number;
  filterDurationMs: number;
  historyEventCount: number;
  subscriberSlug: string;
};

type AppendBatchDiagnostic = {
  afterAppendDurationMs: number;
  buildReduceDurationMs: number;
  commitDurationMs: number;
  committedEventCount: number;
  completedAtMs: number;
  duplicateEventCount: number;
  error?: string;
  firstCommittedOffset: number | null;
  inputEventCount: number;
  lastCommittedOffset: number | null;
  parseDurationMs: number;
  totalDurationMs: number;
};

type CallableSubscriberAlarmDiagnostic = {
  coalescedWhileActiveCount: number;
  coalescedWhileScheduledCount: number;
  setAlarmCount: number;
  setAlarmErrorCount: number;
  scheduleRequestCount: number;
};

const StreamDurableObjectLifecycleBase = withD1ObjectCatalog<
  StreamDurableObjectStructuredName,
  Pick<StreamDurableObjectEnv, "DO_CATALOG">
>({
  className: "StreamDurableObject",
  getDatabase: (env) => env.DO_CATALOG,
  indexes: {
    namespace: (params) => params.namespace,
    path: (params) => params.path,
  },
})(
  withLifecycleHooks({
    nameSchema: z.object({
      namespace: z.string(),
      path: StreamPath,
    }),
  })(withDurableObjectCore(DurableObject)),
);

const StreamDurableObjectInspectorBase = withKvInspector({
  unsafe: "I_UNDERSTAND_THIS_EXPOSES_KV",
})(
  withOuterbase({
    unsafe: "I_UNDERSTAND_THIS_EXPOSES_SQL",
  })(StreamDurableObjectLifecycleBase) as typeof StreamDurableObjectLifecycleBase,
);

const StreamDurableObjectBase = withPublicFetchRoute({
  namespaceSlug: "stream",
  defaultAddressing: "by-structured-name",
})(StreamDurableObjectInspectorBase as never) as typeof StreamDurableObjectLifecycleBase;

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
export class StreamDurableObject extends StreamDurableObjectBase<StreamDurableObjectEnv> {
  private _state: StreamState | null = null;
  private callableSubscriberDeliveryAlarmScheduled = false;
  private readonly client: SyncClient;
  private readonly appendBatchDiagnostics: AppendBatchDiagnostic[] = [];
  private readonly callableSubscriberAlarmDiagnostic: CallableSubscriberAlarmDiagnostic = {
    coalescedWhileActiveCount: 0,
    coalescedWhileScheduledCount: 0,
    setAlarmCount: 0,
    setAlarmErrorCount: 0,
    scheduleRequestCount: 0,
  };
  private readonly callableSubscriberDeliveries: CallableSubscriberDeliveryDiagnostic[] = [];
  private readonly idempotencyDuplicates = new Map<string, IdempotencyDuplicateDiagnostic>();
  private readonly subscribers = new Set<ReadableStreamDefaultController<Uint8Array>>();

  private get state(): StreamState {
    if (this._state == null) {
      throw new Error(
        "Stream durable object state was accessed before initialize({ name }) completed. Callers must use getInitializedStreamStub().",
      );
    }

    return this._state;
  }

  // ---------------------------------------------------------------------------
  // Construction & initialization
  // ---------------------------------------------------------------------------

  constructor(ctx: DurableObjectState, env: StreamDurableObjectEnv) {
    super(ctx, env);
    this.client = createDurableObjectClient(ctx.storage);

    this.registerOnFirstInitialize((params) => {
      this.initializeFirstStream(params);
    });

    this.registerOnInstanceWake(() => {
      if (this._state == null) {
        this.hydratePersistedStreamState({ appendWakeEvent: true });
      }
    });
  }

  private initializeFirstStream(params: StreamDurableObjectStructuredName) {
    migrate(this.client);

    if (this.hydratePersistedStreamState({ appendWakeEvent: false })) {
      return;
    }

    const namespace = StreamNamespace.parse(params.namespace);
    const path = StreamPath.parse(params.path);
    this._state = createInitialStreamState({
      namespace,
      path,
    });

    try {
      this.append({
        type: STREAM_FIRST_INITIALIZED_TYPE,
        payload: { namespace, path },
      });
    } catch (error) {
      this._state = null;
      throw error;
    }
  }

  /**
   * Hydrates in-memory state from persisted SQLite and ensures the schema
   * exists. This is infrastructure-level bootstrapping: processors depend on a
   * fully initialized stream to operate on.
   */
  private hydratePersistedStreamState(args: { appendWakeEvent: boolean }) {
    migrate(this.client);

    const persistedStateRow = getReducedState(this.client);
    if (persistedStateRow == null) {
      return false;
    }

    const rawState = JSON.parse(persistedStateRow.json);
    const parsed = StreamState.safeParse(rawState);
    if (!parsed.success) {
      // Deliberately not crashing — throwing during startup makes the object
      // much harder to debug. This is not full recovery: initialize() cannot
      // safely rebuild an existing stream from events yet.
      console.error(
        "[stream-do] persisted reduced_state failed validation, leaving _state null until explicit recovery is implemented",
        { error: parsed.error, raw: persistedStateRow.json },
      );
      return false;
    }

    this._state = parsed.data;
    if (!args.appendWakeEvent) {
      return true;
    }

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

    return true;
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
    this.ensureInitializedStreamStorage();

    if (input.idempotencyKey != null) {
      const existingEvent = this.getEventByIdempotencyKey(input.idempotencyKey);
      if (existingEvent != null) {
        this.recordIdempotencyDuplicate({
          attemptedEvent: input,
          existingEvent,
          idempotencyKey: input.idempotencyKey,
        });
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

  appendBatch(inputEvents: EventInput[]): Event[] {
    const startedAt = performance.now();
    let afterAppendDurationMs = 0;
    let buildReduceDurationMs = 0;
    let commitDurationMs = 0;
    let parseDurationMs = 0;
    let inputs: EventInput[] = [];
    const results: Event[] = [];
    const committedEvents: { event: Event; stateAfterEvent: StreamState }[] = [];
    let errorMessage: string | undefined;

    try {
      const parseStartedAt = performance.now();
      inputs = inputEvents.map((inputEvent) => EventInput.parse(inputEvent));
      parseDurationMs = roundDiagnosticDurationMs(performance.now() - parseStartedAt);
      this.ensureInitializedStreamStorage();

      let nextState = this.state;
      const pendingEventsByIdempotencyKey = new Map<string, Event>();

      const buildReduceStartedAt = performance.now();
      for (const input of inputs) {
        if (input.idempotencyKey != null) {
          const existingEvent =
            pendingEventsByIdempotencyKey.get(input.idempotencyKey) ??
            this.getEventByIdempotencyKey(input.idempotencyKey);
          if (existingEvent != null) {
            this.recordIdempotencyDuplicate({
              attemptedEvent: input,
              existingEvent,
              idempotencyKey: input.idempotencyKey,
            });
            results.push(existingEvent);
            continue;
          }
        }

        const nextOffset = this.beforeAppend(input, nextState);
        const event = Event.parse({
          streamPath: nextState.path,
          ...input,
          offset: nextOffset,
          createdAt: new Date().toISOString(),
        });
        nextState = this.reduce(event, nextState);
        if (event.idempotencyKey != null) {
          pendingEventsByIdempotencyKey.set(event.idempotencyKey, event);
        }
        results.push(event);
        committedEvents.push({ event, stateAfterEvent: nextState });
      }
      buildReduceDurationMs = roundDiagnosticDurationMs(performance.now() - buildReduceStartedAt);

      if (committedEvents.length === 0) {
        return results;
      }

      const commitStartedAt = performance.now();
      this.client.transaction((tx) => {
        for (const { event } of committedEvents) {
          insertEvent(tx, {
            offset: event.offset,
            type: event.type,
            payload: JSON.stringify(event.payload),
            metadata: event.metadata === undefined ? null : JSON.stringify(event.metadata),
            idempotencyKey: event.idempotencyKey ?? null,
            createdAt: event.createdAt,
          });
        }
        upsertReducedState(tx, { json: JSON.stringify(nextState) });
      });
      commitDurationMs = roundDiagnosticDurationMs(performance.now() - commitStartedAt);

      const afterAppendStartedAt = performance.now();
      for (const { event, stateAfterEvent } of committedEvents) {
        this._state = stateAfterEvent;
        this.afterAppend(event);
      }
      this._state = nextState;
      afterAppendDurationMs = roundDiagnosticDurationMs(performance.now() - afterAppendStartedAt);

      return results;
    } catch (error) {
      errorMessage = formatErrorMessage(error);
      throw error;
    } finally {
      this.recordAppendBatchDiagnostic({
        afterAppendDurationMs,
        buildReduceDurationMs,
        commitDurationMs,
        committedEventCount: committedEvents.length,
        completedAtMs: Date.now(),
        duplicateEventCount: results.length - committedEvents.length,
        ...(errorMessage == null ? {} : { error: errorMessage }),
        firstCommittedOffset: committedEvents[0]?.event.offset ?? null,
        inputEventCount: inputEvents.length,
        lastCommittedOffset: committedEvents.at(-1)?.event.offset ?? null,
        parseDurationMs,
        totalDurationMs: roundDiagnosticDurationMs(performance.now() - startedAt),
      });
    }
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
  private beforeAppend(input: EventInput, state = this.state): number {
    if (input.type === STREAM_FIRST_INITIALIZED_TYPE && state.eventCount > 0) {
      throw new Error("stream-initialized may only be appended once");
    }

    const nextOffset = state.eventCount + 1;

    if (input.offset != null && input.offset !== nextOffset) {
      throw new StreamOffsetPreconditionError(
        `Client-supplied offset ${input.offset} does not match next generated offset ${nextOffset}.`,
      );
    }

    assertValidCoreEventInput({
      input,
      nextOffset,
      streamPath: state.path,
    });

    runBuiltinBeforeAppend({
      event: input,
      processors: state.processors,
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
  private reduce(event: Event, state = this.state): StreamState {
    if (state.path !== event.streamPath) {
      throw new Error(
        `This should never happen. Somebody is trying to append an event to the wrong stream. Stream has path ${state.path}, but the event has path ${event.streamPath}.`,
      );
    }

    let nextState = reduceStreamCore({
      state,
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
   * We deliberately do not use ctx.waitUntil() here. Cloudflare documents that
   * it has no effect in Durable Objects; pending I/O keeps the object alive.
   * https://developers.cloudflare.com/durable-objects/api/state/#waituntil
   *
   * Correctness-critical derived work still needs a durable event/outbox cursor
   * before we rely on it operationally.
   */
  private afterAppend(event: Event) {
    this.publish(event);

    if (event.type === STREAM_FIRST_INITIALIZED_TYPE) {
      void propagateInitializedStreamToAncestors({
        childInitializedEvent: event,
        namespace: this.env.STREAM,
        streamNamespace: this.structuredName.namespace,
      }).catch((error) => {
        console.error("[stream-do] failed to propagate initialized stream to ancestors", {
          path: event.streamPath,
          error,
        });
      });
    }

    runBuiltinAfterAppend({
      append: (nextEvent) => this.append(nextEvent),
      // Stored processor state can name Callable targets, but it must not
      // store live Worker capabilities. The DO supplies those capabilities
      // only at dispatch time.
      callableContext: {
        env: this.env as Record<string, unknown>,
      },
      event,
      processors: this.state.processors,
      subscriberTypes: IMMEDIATE_EXTERNAL_SUBSCRIBERS,
      onExternalSubscriberError: (failure) => {
        this.appendExternalSubscriberDeliveryError(failure);
      },
      onError: ({ error, event, processorSlug }) => {
        console.error("[stream-do] processor afterAppend failed", {
          path: this.state.path,
          processor: processorSlug,
          eventType: event.type,
          error,
        });
      },
    });

    if (this.shouldQueueCallableSubscriberDelivery(event)) {
      void this.scheduleCallableSubscriberDelivery().catch((error) => {
        console.error("[stream-do] failed to schedule callable subscriber delivery", {
          path: this.state.path,
          offset: event.offset,
          eventType: event.type,
          error,
        });
        this.appendProcessorErrorEvent({
          event,
          idempotencyKey: `stream-do:callable-subscriber-enqueue-error:${event.offset}`,
          message: `Failed to enqueue callable subscriber delivery for ${event.type} at offset ${event.offset}: ${formatErrorMessage(error)}`,
          metadata: {
            source: "stream-do",
            processor: "external-subscriber",
            stage: "enqueue-callable-subscriber-delivery",
            failedEventOffset: event.offset,
            failedEventType: event.type,
          },
        });
      });
    }
  }

  async alarm() {
    this.callableSubscriberDeliveryAlarmScheduled = false;
    if (this._state == null && !this.hydratePersistedStreamState({ appendWakeEvent: false })) {
      return;
    }

    await this.drainCallableSubscriberDelivery();
  }

  // ---------------------------------------------------------------------------
  // State & lifecycle
  // ---------------------------------------------------------------------------

  getState(): StreamState {
    this.ensureInitializedStreamStorage();
    return this.state;
  }

  async getDiagnostics() {
    const idempotentEventSummary = countIdempotentEvents(this.client) ?? {
      committed_idempotent_event_count: 0,
    };
    const duplicateSummary = summarizeIdempotencyDuplicateAttempts(this.client) ?? {
      duplicate_attempt_count: 0,
      duplicate_key_count: 0,
    };
    const alarmDeliveredSubscribers = Object.values(
      this.state.processors["external-subscriber"].subscribersBySlug,
    ).filter((subscriber) => ALARM_DELIVERED_EXTERNAL_SUBSCRIBERS.has(subscriber.type));

    return {
      callableSubscriberCursors: await Promise.all(
        alarmDeliveredSubscribers.map(async (subscriber) => ({
          cursor: await this.readCallableSubscriberCursor(subscriber.slug),
          subscriberSlug: subscriber.slug,
        })),
      ),
      idempotencyDuplicateAttemptCount: duplicateSummary.duplicate_attempt_count,
      idempotencyDuplicateKeyCount: duplicateSummary.duplicate_key_count,
      idempotencyCommittedEventCount: idempotentEventSummary.committed_idempotent_event_count,
      idempotencyLogicalAppendAttemptCount:
        idempotentEventSummary.committed_idempotent_event_count +
        duplicateSummary.duplicate_attempt_count,
      idempotencyDuplicateTopKeys: listIdempotencyDuplicateAttempts(this.client, {
        limit: IDEMPOTENCY_DIAGNOSTIC_LIMIT,
      }).map((row) => ({
        duplicateAttempts: row.duplicate_attempts,
        eventType: row.event_type,
        firstDuplicateAtMs: row.first_duplicate_at_ms,
        idempotencyKey: row.idempotency_key,
        lastDuplicateAtMs: row.last_duplicate_at_ms,
        streamPath: row.stream_path,
        targetOffset: row.target_offset,
      })),
      idempotencyDuplicateTopSources: listIdempotencyDuplicateAttemptSources(this.client, {
        limit: IDEMPOTENCY_DIAGNOSTIC_LIMIT,
      }).map((row) => ({
        duplicateAttempts: row.duplicate_attempts,
        firstDuplicateAtMs: row.first_duplicate_at_ms,
        idempotencyKey: row.idempotency_key,
        lastDuplicateAtMs: row.last_duplicate_at_ms,
        sourceLabel: row.source_label,
      })),
      idempotencyDuplicates: [...this.idempotencyDuplicates.values()].sort(
        (left, right) => right.lastDuplicateAtMs - left.lastDuplicateAtMs,
      ),
      appendBatchDiagnostics: this.appendBatchDiagnostics.toReversed(),
      callableSubscriberAlarmDiagnostic: this.callableSubscriberAlarmDiagnostic,
      callableSubscriberDeliveries: this.callableSubscriberDeliveries.toReversed(),
    };
  }

  async destroy(args: { destroyChildren?: boolean } = {}): Promise<DestroyStreamResult> {
    if (this._state == null) {
      this.closeSubscribers();
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
              durableObjectNamespace: this.env.STREAM as unknown as StreamDurableObjectNamespace,
              namespace: this.structuredName.namespace,
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
    this.ensureInitializedStreamStorage();
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

  private ensureInitializedStreamStorage() {
    if (this._state != null || this.hydratePersistedStreamState({ appendWakeEvent: false })) {
      return;
    }

    // `destroy()` intentionally deletes the stream's SQLite storage, but the
    // lifecycle mixin may keep the same JavaScript DO instance marked as started.
    // Rebuild the stream from its immutable structured name so the next initialized
    // call observes the same "untouched stream initializes itself" contract as a
    // fresh object.
    this.initializeFirstStream(this.structuredName);
  }

  private shouldQueueCallableSubscriberDelivery(event: Event) {
    if (isInternalExternalSubscriberErrorEvent(event)) {
      return false;
    }

    return Object.values(this.state.processors["external-subscriber"].subscribersBySlug).some(
      (subscriber) => ALARM_DELIVERED_EXTERNAL_SUBSCRIBERS.has(subscriber.type),
    );
  }

  private recordIdempotencyDuplicate(args: {
    attemptedEvent: EventInput;
    existingEvent: Event;
    idempotencyKey: string;
  }) {
    const now = Date.now();
    const sourceLabel = resolveAppendSourceLabel(args.attemptedEvent);
    upsertIdempotencyDuplicateAttempt(this.client, {
      eventType: args.attemptedEvent.type,
      firstDuplicateAtMs: now,
      idempotencyKey: args.idempotencyKey,
      lastDuplicateAtMs: now,
      streamPath: args.existingEvent.streamPath,
      targetOffset: args.existingEvent.offset,
    });
    if (sourceLabel != null) {
      upsertIdempotencyDuplicateAttemptSource(this.client, {
        firstDuplicateAtMs: now,
        idempotencyKey: args.idempotencyKey,
        lastDuplicateAtMs: now,
        sourceLabel,
      });
    }

    const existing = this.idempotencyDuplicates.get(args.idempotencyKey);
    const sourceLabels = new Set(existing?.sourceLabels ?? []);
    if (sourceLabel != null) {
      sourceLabels.add(sourceLabel);
    }
    this.idempotencyDuplicates.set(args.idempotencyKey, {
      duplicateAttempts: (existing?.duplicateAttempts ?? 0) + 1,
      eventType: args.attemptedEvent.type,
      firstDuplicateAtMs: existing?.firstDuplicateAtMs ?? now,
      idempotencyKey: args.idempotencyKey,
      lastDuplicateAtMs: now,
      sourceLabels: [...sourceLabels].sort(),
      streamPath: args.existingEvent.streamPath,
      targetOffset: args.existingEvent.offset,
    });

    if (this.idempotencyDuplicates.size <= IDEMPOTENCY_DIAGNOSTIC_LIMIT) {
      return;
    }

    const oldest = [...this.idempotencyDuplicates.values()].sort(
      (left, right) => left.lastDuplicateAtMs - right.lastDuplicateAtMs,
    )[0];
    if (oldest != null) {
      this.idempotencyDuplicates.delete(oldest.idempotencyKey);
    }
  }

  private async scheduleCallableSubscriberDelivery() {
    this.callableSubscriberAlarmDiagnostic.scheduleRequestCount += 1;

    if (this.callableSubscriberDeliveryAlarmScheduled) {
      this.callableSubscriberAlarmDiagnostic.coalescedWhileScheduledCount += 1;
      return;
    }

    this.callableSubscriberDeliveryAlarmScheduled = true;
    try {
      await this.ctx.storage.setAlarm(Date.now());
      this.callableSubscriberAlarmDiagnostic.setAlarmCount += 1;
    } catch (error) {
      this.callableSubscriberDeliveryAlarmScheduled = false;
      this.callableSubscriberAlarmDiagnostic.setAlarmErrorCount += 1;
      throw error;
    }
  }

  private async drainCallableSubscriberDelivery() {
    const targetEventCount = this.state.eventCount;
    const startedAt = performance.now();
    const diagnostic: Omit<CallableSubscriberDeliveryDiagnostic, "completedAtMs" | "durationMs"> = {
      batchIterations: 0,
      cursorReadCount: 0,
      cursorWriteCount: 0,
      deliveredEventCount: 0,
      emptyWindowCount: 0,
      failedEventCount: 0,
      historyReadCount: 0,
      rescheduled: false,
      startedAtMs: Date.now(),
      subscriberCheckCount: 0,
      subscriberDeliveries: [],
      targetEventCount,
      uniqueHistoryWindowCount: 0,
      yielded: false,
    };
    let finished = false;
    const finish = (updates?: Partial<typeof diagnostic>) => {
      if (finished) return;
      finished = true;
      Object.assign(diagnostic, updates);
      this.recordCallableSubscriberDeliveryDiagnostic({
        ...diagnostic,
        completedAtMs: Date.now(),
        durationMs: Math.round(performance.now() - startedAt),
      });
    };

    try {
      for (
        let batchIndex = 0;
        batchIndex < CALLABLE_SUBSCRIBER_ALARM_MAX_BATCHES;
        batchIndex += 1
      ) {
        diagnostic.batchIterations += 1;
        const subscribers = Object.values(
          this.state.processors["external-subscriber"].subscribersBySlug,
        ).filter((subscriber) => ALARM_DELIVERED_EXTERNAL_SUBSCRIBERS.has(subscriber.type));
        diagnostic.subscriberCheckCount += subscribers.length;
        if (subscribers.length === 0) {
          finish();
          return;
        }

        const cursorEntries = await Promise.all(
          subscribers.map(async (subscriber) => ({
            cursor: await this.readCallableSubscriberCursor(subscriber.slug),
            subscriber,
          })),
        );
        diagnostic.cursorReadCount += cursorEntries.length;
        const eventWindows = new Map<string, readonly Event[]>();

        const results = await Promise.all(
          cursorEntries.map(async ({ cursor, subscriber }) => {
            if (cursor >= targetEventCount) {
              return { hasRemainingWork: false, shouldYield: false };
            }

            const before = Math.min(
              cursor + CALLABLE_SUBSCRIBER_ALARM_BATCH_SIZE + 1,
              targetEventCount + 1,
            );
            const windowKey = `${cursor}:${before}`;
            let events = eventWindows.get(windowKey);
            if (events == null) {
              events = this.history({ after: cursor, before });
              eventWindows.set(windowKey, events);
              diagnostic.historyReadCount += 1;
              diagnostic.uniqueHistoryWindowCount += 1;
            }
            if (events.length === 0) {
              diagnostic.emptyWindowCount += 1;
              diagnostic.subscriberDeliveries.push({
                beforeOffset: before,
                completedAtMs: Date.now(),
                cursor,
                deliveredEventCount: 0,
                dispatchDurationMs: 0,
                durationMs: 0,
                failedEventCount: 0,
                filterDurationMs: 0,
                historyEventCount: 0,
                subscriberSlug: subscriber.slug,
              });
              this.appendProcessorErrorEvent({
                event: null,
                idempotencyKey: `stream-do:callable-subscriber-empty-batch:${subscriber.slug}:${cursor}:${this.state.eventCount}`,
                message: `Callable subscriber "${subscriber.slug}" had cursor ${cursor} behind stream event count ${this.state.eventCount}, but no events were found to deliver.`,
                metadata: {
                  source: "stream-do",
                  processor: "external-subscriber",
                  stage: "deliver-callable-subscriber",
                  subscriberSlug: subscriber.slug,
                  cursor,
                  eventCount: this.state.eventCount,
                },
              });
              return { hasRemainingWork: false, shouldYield: false };
            }

            const subscriberDeliveryStartedAt = performance.now();
            const result = await publishExternalSubscriberBatch({
              append: (nextEvent) => Promise.resolve(this.append(nextEvent)),
              callableContext: {
                env: this.env as Record<string, unknown>,
              },
              events,
              onError: (failure) => {
                this.appendExternalSubscriberDeliveryError(failure);
              },
              subscriber,
            });
            diagnostic.subscriberDeliveries.push({
              beforeOffset: before,
              completedAtMs: Date.now(),
              cursor,
              deliveredEventCount: result.deliveredEventCount,
              dispatchDurationMs: result.dispatchDurationMs,
              durationMs: Math.round(performance.now() - subscriberDeliveryStartedAt),
              failedEventCount: result.failedEventCount,
              filterDurationMs: result.filterDurationMs,
              historyEventCount: events.length,
              subscriberSlug: subscriber.slug,
            });
            diagnostic.deliveredEventCount += result.deliveredEventCount;
            diagnostic.failedEventCount += result.failedEventCount;

            if (result.failedEventCount > 0 && result.deliveredEventCount === 0) {
              return { hasRemainingWork: true, shouldYield: true };
            }

            await this.writeCallableSubscriberCursor(
              subscriber.slug,
              events.at(-1)?.offset ?? cursor,
            );
            diagnostic.cursorWriteCount += 1;
            return {
              hasRemainingWork: events.at(-1)!.offset < targetEventCount,
              shouldYield: false,
            };
          }),
        );

        if (results.some((result) => result.shouldYield)) {
          diagnostic.rescheduled = true;
          diagnostic.yielded = true;
          await this.scheduleCallableSubscriberDelivery();
          finish();
          return;
        }

        if (!results.some((result) => result.hasRemainingWork)) {
          if (this.state.eventCount > targetEventCount) {
            diagnostic.rescheduled = true;
            await this.scheduleCallableSubscriberDelivery();
          }
          finish();
          return;
        }
      }

      diagnostic.rescheduled = true;
      await this.scheduleCallableSubscriberDelivery();
      finish();
    } catch (error) {
      finish({ error: formatErrorMessage(error) });
      throw error;
    }
  }

  private recordCallableSubscriberDeliveryDiagnostic(
    diagnostic: CallableSubscriberDeliveryDiagnostic,
  ) {
    this.callableSubscriberDeliveries.push(diagnostic);
    if (this.callableSubscriberDeliveries.length <= CALLABLE_SUBSCRIBER_DIAGNOSTIC_LIMIT) {
      return;
    }
    this.callableSubscriberDeliveries.splice(
      0,
      this.callableSubscriberDeliveries.length - CALLABLE_SUBSCRIBER_DIAGNOSTIC_LIMIT,
    );
  }

  private recordAppendBatchDiagnostic(diagnostic: AppendBatchDiagnostic) {
    this.appendBatchDiagnostics.push(diagnostic);
    if (this.appendBatchDiagnostics.length <= APPEND_BATCH_DIAGNOSTIC_LIMIT) {
      return;
    }
    this.appendBatchDiagnostics.splice(
      0,
      this.appendBatchDiagnostics.length - APPEND_BATCH_DIAGNOSTIC_LIMIT,
    );
  }

  private async readCallableSubscriberCursor(slug: string) {
    return (await this.ctx.storage.get<number>(callableSubscriberCursorKey(slug))) ?? 0;
  }

  private async writeCallableSubscriberCursor(slug: string, offset: number) {
    await this.ctx.storage.put(callableSubscriberCursorKey(slug), offset);
  }

  private appendExternalSubscriberDeliveryError(failure: ExternalSubscriberPublishFailure) {
    if (isInternalExternalSubscriberErrorEvent(failure.event)) {
      return;
    }

    this.appendProcessorErrorEvent({
      event: failure.event,
      idempotencyKey: `stream-do:external-subscriber-error:${failure.event.offset}:${failure.subscriber.slug}`,
      message: `External subscriber "${failure.subscriber.slug}" failed while handling ${failure.event.type} at offset ${failure.event.offset}: ${formatErrorMessage(failure.error)}`,
      metadata: {
        source: "stream-do",
        processor: "external-subscriber",
        subscriberSlug: failure.subscriber.slug,
        subscriberType: failure.subscriber.type,
        failedEventOffset: failure.event.offset,
        failedEventType: failure.event.type,
      },
    });
  }

  private appendProcessorErrorEvent(args: {
    event: Event | null;
    idempotencyKey: string;
    message: string;
    metadata: Record<string, string | number>;
  }) {
    try {
      this.append({
        type: STREAM_ERROR_OCCURRED_TYPE,
        idempotencyKey: args.idempotencyKey,
        payload: {
          message: args.message,
        },
        metadata: args.metadata,
      });
    } catch (error) {
      console.error("[stream-do] failed to append processor error event", {
        path: this.state.path,
        eventOffset: args.event?.offset,
        eventType: args.event?.type,
        reportError: error,
        originalMessage: args.message,
      });
    }
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

function assertValidCoreEventInput(args: {
  input: EventInput;
  nextOffset: number;
  streamPath: StreamPath;
}) {
  const candidateEvent = {
    streamPath: args.streamPath,
    ...args.input,
    offset: args.nextOffset,
    createdAt: new Date().toISOString(),
  };

  const result =
    args.input.type === STREAM_FIRST_INITIALIZED_TYPE
      ? StreamInitializedEvent.safeParse(candidateEvent)
      : args.input.type === STREAM_CHILD_STREAM_CREATED_TYPE
        ? ChildStreamCreatedEvent.safeParse(candidateEvent)
        : args.input.type === STREAM_METADATA_UPDATED_TYPE
          ? StreamMetadataUpdatedEvent.safeParse(candidateEvent)
          : null;

  if (result == null || result.success) {
    return;
  }

  throw new Error(
    `Invalid core event payload for ${args.input.type}: ${result.error.issues
      .map((issue) => issue.message)
      .join("; ")}`,
  );
}

function createInitialStreamState(args: {
  namespace: StreamNamespace;
  path: StreamPath;
}): StreamState {
  return {
    namespace: args.namespace,
    path: args.path,
    eventCount: 0,
    childPaths: [],
    metadata: {},
    processors: createInitialBuiltinProcessorState(),
  };
}

function createInitialBuiltinProcessorState(): StreamState["processors"] {
  return {
    "circuit-breaker": structuredClone(circuitBreakerProcessor.initialState),
    "external-subscriber": structuredClone(externalSubscriberProcessor.initialState),
  };
}

function callableSubscriberCursorKey(slug: string) {
  return `${CALLABLE_SUBSCRIBER_CURSOR_KEY_PREFIX}:${slug}`;
}

function resolveAppendSourceLabel(event: EventInput): string | null {
  const metadata = event.metadata;
  if (metadata == null) return null;

  const provenance =
    typeof metadata.provenance === "object" &&
    metadata.provenance !== null &&
    !Array.isArray(metadata.provenance)
      ? metadata.provenance
      : null;
  const processor =
    provenance != null &&
    "processor" in provenance &&
    typeof provenance.processor === "object" &&
    provenance.processor !== null &&
    !Array.isArray(provenance.processor)
      ? provenance.processor
      : null;
  if (processor != null && "slug" in processor && typeof processor.slug === "string") {
    return `processor:${processor.slug}`;
  }

  const benchmark =
    typeof metadata.benchmark === "object" &&
    metadata.benchmark !== null &&
    !Array.isArray(metadata.benchmark)
      ? metadata.benchmark
      : null;
  if (benchmark != null && "id" in benchmark && typeof benchmark.id === "string") {
    return "benchmark-publisher";
  }

  if (typeof metadata.source === "string" && metadata.source.trim()) {
    return metadata.source.trim();
  }

  return null;
}

function roundDiagnosticDurationMs(durationMs: number) {
  return Math.round(durationMs * 1000) / 1000;
}

function runBuiltinBeforeAppend(args: {
  event: EventInput;
  processors: StreamState["processors"];
}) {
  // Circuit breaker is the only current privileged pre-commit gate. Keep this
  // explicit so adding another beforeAppend hook is a conscious stream-core
  // decision, not a side effect of appending to an array above.
  circuitBreakerProcessor.beforeAppend?.({
    event: args.event,
    state: args.processors["circuit-breaker"],
  });
}

function reduceBuiltinProcessors(args: {
  event: Event;
  processors: StreamState["processors"];
}): StreamState["processors"] {
  return {
    "circuit-breaker": circuitBreakerProcessor.reduce!({
      event: args.event,
      state: args.processors["circuit-breaker"],
    }),
    "external-subscriber": externalSubscriberProcessor.reduce!({
      event: args.event,
      state: args.processors["external-subscriber"],
    }),
  };
}

function runBuiltinAfterAppend(args: {
  append: (event: EventInput) => Event;
  callableContext: CallableContext;
  event: Event;
  onExternalSubscriberError?(failure: ExternalSubscriberPublishFailure): void | Promise<void>;
  processors: StreamState["processors"];
  onError(args: { error: unknown; event: Event; processorSlug: string }): void;
  subscriberTypes?: ReadonlySet<"callable" | "webhook" | "websocket">;
}) {
  const circuitBreakerPromise = circuitBreakerProcessor.afterAppend?.({
    append: args.append,
    callableContext: args.callableContext,
    event: args.event,
    state: args.processors["circuit-breaker"],
  });
  if (circuitBreakerPromise != null) {
    void circuitBreakerPromise.catch((error) => {
      args.onError({
        error,
        event: args.event,
        processorSlug: circuitBreakerProcessor.slug,
      });
    });
  }

  const externalSubscriberPromise = publishExternalSubscribers({
    append: (event) => Promise.resolve(args.append(event)),
    callableContext: args.callableContext,
    event: args.event,
    onError: args.onExternalSubscriberError,
    state: args.processors["external-subscriber"],
    subscriberTypes: args.subscriberTypes,
  });
  void externalSubscriberPromise.catch((error) => {
    args.onError({
      error,
      event: args.event,
      processorSlug: externalSubscriberProcessor.slug,
    });
  });
}

function isInternalExternalSubscriberErrorEvent(event: Event) {
  return (
    event.type === STREAM_ERROR_OCCURRED_TYPE &&
    event.metadata?.source === "stream-do" &&
    event.metadata.processor === "external-subscriber"
  );
}

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
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
  namespace: StreamDurableObjectEnv["STREAM"];
  streamNamespace: string;
}) {
  const childPath = StreamPath.parse(args.childInitializedEvent.streamPath);
  const ancestorPaths = getAncestorStreamPaths(childPath);

  await Promise.all(
    ancestorPaths.map(async (path) => {
      const stream = await getInitializedStreamStub({
        durableObjectNamespace: args.namespace as unknown as StreamDurableObjectNamespace,
        namespace: args.streamNamespace,
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
