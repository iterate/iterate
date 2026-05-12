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
  getEventByIdempotencyKey,
  getReducedState,
  history as selectHistory,
  insertEvent,
  upsertReducedState,
} from "./db/queries/.generated/index.ts";
import {
  externalSubscriberProcessor,
  hasExternalSubscribersOfType,
  publishExternalSubscriber,
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

const LEGACY_CALLABLE_SUBSCRIBER_ALARM_QUEUE_KEY = "stream-do:callable-subscriber-alarm-queue";
const CALLABLE_SUBSCRIBER_DELIVERY_QUEUE_KEY = "stream-do:callable-subscriber-delivery-queue-v2";
const NON_CALLABLE_SUBSCRIBERS = new Set(["webhook", "websocket"] as const);

type CallableSubscriberDeliveryQueue = Record<string, number[]>;

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
  private callableSubscriberQueueMutation: Promise<void> = Promise.resolve();
  private readonly client: SyncClient;
  private readonly activeCallableSubscriberDeliveries = new Set<string>();
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
        return existingEvent;
      }
    }

    const nextOffset = this.beforeAppend(input, this.state);

    const event = {
      streamPath: this.state.path,
      ...input,
      offset: nextOffset,
      createdAt: new Date().toISOString(),
    };

    const nextState = this.reduce(this.state, event);

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

  async appendBatch(inputEvents: EventInput[]): Promise<Event[]> {
    const inputs = inputEvents.map((inputEvent) => EventInput.parse(inputEvent));
    const events: Event[] = [];
    const newEvents: Event[] = [];
    const newEventsByIdempotencyKey = new Map<string, Event>();

    this.ensureInitializedStreamStorage();
    let nextState = this.state;

    for (const input of inputs) {
      if (input.idempotencyKey != null) {
        const existingEvent =
          newEventsByIdempotencyKey.get(input.idempotencyKey) ??
          this.getEventByIdempotencyKey(input.idempotencyKey);
        if (existingEvent != null) {
          events.push(existingEvent);
          continue;
        }
      }

      const nextOffset = this.beforeAppend(input, nextState);
      const event = {
        streamPath: nextState.path,
        ...input,
        offset: nextOffset,
        createdAt: new Date().toISOString(),
      };

      nextState = this.reduce(nextState, event);
      events.push(event);
      newEvents.push(event);
      if (event.idempotencyKey != null) {
        newEventsByIdempotencyKey.set(event.idempotencyKey, event);
      }
    }

    if (newEvents.length === 0) return events;

    this.client.transaction((tx) => {
      for (const event of newEvents) {
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
    this._state = nextState;

    for (const event of newEvents) {
      this.afterAppend(event);
    }

    return events;
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
  private beforeAppend(input: EventInput, state: StreamState): number {
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
  private reduce(state: StreamState, event: Event): StreamState {
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
      subscriberTypes: NON_CALLABLE_SUBSCRIBERS,
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
      void this.enqueueCallableSubscriberDelivery(event.offset).catch((error) => {
        console.error("[stream-do] failed to enqueue callable subscriber delivery", {
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
    if (this._state == null && !this.hydratePersistedStreamState({ appendWakeEvent: false })) {
      return;
    }

    await this.startCallableSubscriberDeliveries();
    await this.ensureCallableSubscriberAlarmIfQueued();
  }

  // ---------------------------------------------------------------------------
  // State & lifecycle
  // ---------------------------------------------------------------------------

  getState(): StreamState {
    this.ensureInitializedStreamStorage();
    return this.state;
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

  private getEventByOffset(offset: number) {
    return (
      selectHistory(this.client, {
        afterOffset: offset - 1,
        beforeOffset: offset + 1,
      })
        .map((row) => this.parseEventRow(row))
        .find((event) => event?.offset === offset) ?? null
    );
  }

  private shouldQueueCallableSubscriberDelivery(event: Event) {
    if (isInternalExternalSubscriberErrorEvent(event)) {
      return false;
    }

    return hasExternalSubscribersOfType(this.state.processors["external-subscriber"], "callable");
  }

  private async enqueueCallableSubscriberDelivery(offset: number) {
    await this.mutateCallableSubscriberDeliveryQueue((queue) => {
      for (const subscriber of this.callableSubscribers()) {
        const offsets = queue[subscriber.slug] ?? [];
        if (!offsets.includes(offset)) {
          queue[subscriber.slug] = [...offsets, offset];
        }
      }
      return queue;
    });

    await this.ctx.storage.setAlarm(Date.now());
  }

  private async startCallableSubscriberDeliveries() {
    while (true) {
      const queue = await this.readCallableSubscriberDeliveryQueue();
      const delivery = this.nextCallableSubscriberDelivery(queue);
      if (delivery == null) {
        return;
      }

      const event = this.getEventByOffset(delivery.offset);
      if (event == null) {
        this.appendProcessorErrorEvent({
          event: null,
          idempotencyKey: `stream-do:callable-subscriber-missing-event:${delivery.subscriberSlug}:${delivery.offset}`,
          message: `Callable subscriber "${delivery.subscriberSlug}" delivery could not find event at offset ${delivery.offset}.`,
          metadata: {
            source: "stream-do",
            processor: "external-subscriber",
            stage: "deliver-callable-subscriber",
            missingEventOffset: delivery.offset,
            subscriberSlug: delivery.subscriberSlug,
          },
        });
        await this.removeCallableSubscriberDelivery(delivery);
        continue;
      }

      const subscriber =
        this.state.processors["external-subscriber"].subscribersBySlug[delivery.subscriberSlug];
      if (subscriber?.type !== "callable") {
        await this.removeCallableSubscriberDelivery(delivery);
        continue;
      }

      this.activeCallableSubscriberDeliveries.add(delivery.subscriberSlug);
      const deliveryPromise = publishExternalSubscriber({
        append: (nextEvent) => Promise.resolve(this.append(nextEvent)),
        callableContext: {
          env: this.env as Record<string, unknown>,
        },
        event,
        onError: (failure) => {
          this.appendExternalSubscriberDeliveryError(failure);
        },
        subscriber,
      });
      void deliveryPromise.then(
        () => this.finishCallableSubscriberDelivery(delivery),
        () => this.finishCallableSubscriberDelivery(delivery),
      );
    }
  }

  private async finishCallableSubscriberDelivery(delivery: {
    offset: number;
    subscriberSlug: string;
  }) {
    this.activeCallableSubscriberDeliveries.delete(delivery.subscriberSlug);
    try {
      await this.removeCallableSubscriberDelivery(delivery);
      await this.ensureCallableSubscriberAlarmIfQueued();
    } catch (error) {
      console.error("[stream-do] failed to finish callable subscriber delivery", {
        path: this.state.path,
        offset: delivery.offset,
        subscriberSlug: delivery.subscriberSlug,
        error,
      });
    }
  }

  private async ensureCallableSubscriberAlarmIfQueued() {
    const queue = await this.readCallableSubscriberDeliveryQueue();
    if (this.hasInactiveCallableSubscriberDelivery(queue)) {
      await this.ctx.storage.setAlarm(Date.now());
    }
  }

  private async readCallableSubscriberDeliveryQueue() {
    const queue =
      (await this.ctx.storage.get<CallableSubscriberDeliveryQueue>(
        CALLABLE_SUBSCRIBER_DELIVERY_QUEUE_KEY,
      )) ?? {};
    const legacyOffsets =
      (await this.ctx.storage.get<number[]>(LEGACY_CALLABLE_SUBSCRIBER_ALARM_QUEUE_KEY)) ?? [];
    if (legacyOffsets.length === 0) {
      return queue;
    }

    const migratedQueue = { ...queue };
    for (const subscriber of this.callableSubscribers()) {
      const offsets = migratedQueue[subscriber.slug] ?? [];
      migratedQueue[subscriber.slug] = Array.from(new Set([...offsets, ...legacyOffsets])).sort(
        (left, right) => left - right,
      );
    }
    await this.writeCallableSubscriberDeliveryQueue(migratedQueue);
    await this.ctx.storage.delete(LEGACY_CALLABLE_SUBSCRIBER_ALARM_QUEUE_KEY);
    return migratedQueue;
  }

  private async writeCallableSubscriberDeliveryQueue(queue: CallableSubscriberDeliveryQueue) {
    const compacted = Object.fromEntries(
      Object.entries(queue).filter(([, offsets]) => offsets.length > 0),
    );
    await this.ctx.storage.put(CALLABLE_SUBSCRIBER_DELIVERY_QUEUE_KEY, compacted);
  }

  private async removeCallableSubscriberDelivery(delivery: {
    offset: number;
    subscriberSlug: string;
  }) {
    await this.mutateCallableSubscriberDeliveryQueue((queue) => {
      const offsets = queue[delivery.subscriberSlug] ?? [];
      const index = offsets.indexOf(delivery.offset);
      if (index >= 0) {
        queue[delivery.subscriberSlug] = [...offsets.slice(0, index), ...offsets.slice(index + 1)];
      }
      return queue;
    });
  }

  private async mutateCallableSubscriberDeliveryQueue(
    mutate: (queue: CallableSubscriberDeliveryQueue) => CallableSubscriberDeliveryQueue,
  ) {
    const nextMutation = this.callableSubscriberQueueMutation.then(async () => {
      const queue = await this.readCallableSubscriberDeliveryQueue();
      await this.writeCallableSubscriberDeliveryQueue(mutate(queue));
    });
    this.callableSubscriberQueueMutation = nextMutation.then(
      () => undefined,
      () => undefined,
    );
    return await nextMutation;
  }

  private nextCallableSubscriberDelivery(queue: CallableSubscriberDeliveryQueue) {
    for (const [subscriberSlug, offsets] of Object.entries(queue).sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      if (this.activeCallableSubscriberDeliveries.has(subscriberSlug)) continue;
      const offset = offsets[0];
      if (offset == null) continue;
      return { offset, subscriberSlug };
    }

    return null;
  }

  private hasInactiveCallableSubscriberDelivery(queue: CallableSubscriberDeliveryQueue) {
    return this.nextCallableSubscriberDelivery(queue) != null;
  }

  private callableSubscribers() {
    return Object.values(this.state.processors["external-subscriber"].subscribersBySlug).filter(
      (subscriber) => subscriber.type === "callable",
    );
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
