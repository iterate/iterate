/**
 * EventStream - single stream with history and replay
 *
 * Boot: reads history → reduces to derived state (current offset)
 * EventStream owns offset management, storage is dumb (just persists Events)
 */
import jsonata from "jsonata";
import { Data, DateTime, Effect, PubSub, Runtime, Schema, Stream } from "effect";
import {
  PUSH_SUBSCRIPTION_CALLBACK_ADDED_TYPE,
  type PushSubscriptionCallbackAddedPayload,
} from "@iterate-com/services-contracts/events";
import WebSocket from "ws";

import { Event, EventInput, Offset, Payload, StreamPath } from "../../domain.ts";
import { StreamStorage } from "../stream-storage/service.ts";
import { fromCurrentSpan } from "../../tracing/helpers.ts";
import {
  isPushSubscriptionAddedEvent,
  parsePushSubscriptionPayload,
  toRetryPolicyWithDefaults,
  toRetrySchedule,
} from "../../push-subscriptions.ts";

// -------------------------------------------------------------------------------------
// State (derived from event history)
// -------------------------------------------------------------------------------------

interface State {
  readonly lastOffset: Offset;
  readonly pushSubscriptions: ReadonlyMap<
    string,
    {
      readonly subscription: PushSubscriptionCallbackAddedPayload;
      readonly lastDeliveredOffset?: Offset;
    }
  >;
}

const initialState: State = { lastOffset: Offset.make("-1"), pushSubscriptions: new Map() };

const reduce = (state: State, event: Event): State => {
  if (!isPushSubscriptionAddedEvent(event)) {
    return {
      lastOffset: event.offset,
      pushSubscriptions: state.pushSubscriptions,
    };
  }

  const payload = parsePushSubscriptionPayload(event.payload);
  if (payload === undefined) {
    return {
      lastOffset: event.offset,
      pushSubscriptions: state.pushSubscriptions,
    };
  }

  const previous = state.pushSubscriptions.get(payload.subscriptionSlug);
  const nextSubscriptions = new Map(state.pushSubscriptions);
  nextSubscriptions.set(payload.subscriptionSlug, {
    subscription: payload,
    ...(previous?.lastDeliveredOffset !== undefined
      ? { lastDeliveredOffset: previous.lastDeliveredOffset }
      : {}),
  });

  return {
    lastOffset: event.offset,
    pushSubscriptions: nextSubscriptions,
  };
};

const applyStoredOffsets = (
  state: State,
  stored: ReadonlyArray<{
    readonly subscription: PushSubscriptionCallbackAddedPayload;
    readonly lastDeliveredOffset?: Offset;
  }>,
): State => {
  if (stored.length === 0) return state;
  const nextSubscriptions = new Map(state.pushSubscriptions);

  for (const entry of stored) {
    nextSubscriptions.set(entry.subscription.subscriptionSlug, {
      subscription: entry.subscription,
      ...(entry.lastDeliveredOffset !== undefined
        ? { lastDeliveredOffset: entry.lastDeliveredOffset }
        : {}),
    });
  }

  return {
    ...state,
    pushSubscriptions: nextSubscriptions,
  };
};

const formatOffset = (n: number): Offset => Offset.make(n.toString().padStart(16, "0"));
const offsetToNumber = (offset: Offset): number => parseInt(offset, 10);
const encodeEvent = Schema.encodeSync(Event);

const WS_ACK_TIMEOUT_MS = 5_000;
const normalizeWebsocketIdleDisconnectMs = (value: number | undefined): number => {
  if (value === undefined) return 30_000;
  if (!Number.isFinite(value) || value < 0) return 30_000;
  return Math.trunc(value);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

class WebhookDeliveryError extends Data.TaggedError("WebhookDeliveryError")<{
  readonly message: string;
}> {}

interface WebSocketConnectionState {
  readonly socket: WebSocket;
  readonly openPromise: Promise<void>;
  idleTimer?: ReturnType<typeof setTimeout>;
}

// -------------------------------------------------------------------------------------
// EventStream interface
// -------------------------------------------------------------------------------------

export interface EventStream {
  /** Subscribe to live events on this path, optionally starting after an offset */
  readonly subscribe: (options?: { from?: Offset }) => Stream.Stream<Event>;

  /** Read historical events on this path, optionally within a range */
  readonly read: (options?: { from?: Offset; to?: Offset }) => Stream.Stream<Event>;

  /** Append an event to this path, returns the stored event with assigned offset */
  readonly append: (event: EventInput) => Effect.Effect<Event>;

  /** Persist/advance acked delivery offset for one push subscription */
  readonly ackOffset: (input: { subscriptionSlug: string; offset: Offset }) => Effect.Effect<void>;
}

export interface EventStreamOptions {
  readonly websocketIdleDisconnectMs?: number;
}

// -------------------------------------------------------------------------------------
// EventStream implementation
// -------------------------------------------------------------------------------------

/**
 * Create an EventStream from a path-scoped StreamStorage.
 *
 * Mirrors the Processor pattern: State class, reduce function, boot from history.
 * Key difference: Processors react to events via their subscribe loop, but
 * EventStream can't subscribe to itself (circular). Instead, EventStream reacts
 * to events in `append` - after storage.write, we update state and publish.
 *
 * The `subscribe` method here is the inverse - it's "respond to a subscriber",
 * not "subscribe to something". Like Cloudflare Workers' `fetch` handler.
 */
export const make = (
  storage: StreamStorage,
  path: StreamPath,
  options: EventStreamOptions = {},
): Effect.Effect<EventStream> =>
  Effect.gen(function* () {
    // Boot: hydrate state from history + stored subscription cursors.
    let state = yield* storage.read().pipe(Stream.runFold(initialState, reduce));
    const storedSubscriptions = yield* storage.listPushSubscriptions();
    state = applyStoredOffsets(state, storedSubscriptions);

    const pubsub = yield* PubSub.unbounded<Event>();
    const runtime = yield* Effect.runtime<never>();
    const runPromise = Runtime.runPromise(runtime);

    const orderedChains = new Map<string, Promise<void>>();
    const wsConnections = new Map<string, WebSocketConnectionState>();
    const websocketIdleDisconnectMs = normalizeWebsocketIdleDisconnectMs(
      options.websocketIdleDisconnectMs,
    );

    const markDelivered = (subscriptionSlug: string, offset: Offset) =>
      Effect.gen(function* () {
        const current = state.pushSubscriptions.get(subscriptionSlug);
        if (current === undefined) return;

        if (
          current.lastDeliveredOffset !== undefined &&
          Offset.gte(current.lastDeliveredOffset, offset)
        ) {
          return;
        }

        const nextSubscriptions = new Map(state.pushSubscriptions);
        nextSubscriptions.set(subscriptionSlug, {
          subscription: current.subscription,
          lastDeliveredOffset: offset,
        });
        state = { ...state, pushSubscriptions: nextSubscriptions };

        yield* storage.setPushSubscriptionOffset({ subscriptionSlug, offset });
      });

    const closeWebSocketConnection = (subscriptionSlug: string) => {
      const current = wsConnections.get(subscriptionSlug);
      if (current === undefined) return;
      if (current.idleTimer !== undefined) {
        clearTimeout(current.idleTimer);
      }
      wsConnections.delete(subscriptionSlug);
      try {
        current.socket.close();
      } catch {
        // ignore close errors
      }
    };

    const resetWebSocketIdleTimer = (subscriptionSlug: string) => {
      if (websocketIdleDisconnectMs < 0) return;

      const current = wsConnections.get(subscriptionSlug);
      if (current === undefined) return;

      if (current.idleTimer !== undefined) {
        clearTimeout(current.idleTimer);
      }

      current.idleTimer = setTimeout(() => {
        const latest = wsConnections.get(subscriptionSlug);
        if (latest?.socket === current.socket) {
          closeWebSocketConnection(subscriptionSlug);
        }
      }, websocketIdleDisconnectMs);
    };

    const waitForExternalAck = (
      subscriptionSlug: string,
      offset: Offset,
    ): Effect.Effect<void, WebhookDeliveryError> =>
      Effect.async<void, WebhookDeliveryError>((resume) => {
        let timer: ReturnType<typeof setTimeout> | undefined;

        const poll = () => {
          const current = state.pushSubscriptions.get(subscriptionSlug);
          const lastDelivered = current?.lastDeliveredOffset;
          if (lastDelivered !== undefined && Offset.gte(lastDelivered, offset)) {
            resume(Effect.void);
            return;
          }

          if (Date.now() >= startedAt + WS_ACK_TIMEOUT_MS) {
            resume(
              Effect.fail(
                new WebhookDeliveryError({
                  message: `Timed out waiting for ack subscription=${subscriptionSlug} offset=${offset}`,
                }),
              ),
            );
            return;
          }

          timer = setTimeout(poll, 10);
        };

        const startedAt = Date.now();
        poll();

        return Effect.sync(() => {
          if (timer !== undefined) clearTimeout(timer);
        });
      });

    const ensureWebSocket = (
      subscription: PushSubscriptionCallbackAddedPayload,
    ): Effect.Effect<WebSocket, WebhookDeliveryError> =>
      Effect.tryPromise({
        try: async () => {
          const existing = wsConnections.get(subscription.subscriptionSlug);
          if (existing !== undefined) {
            if (existing.socket.readyState === WebSocket.OPEN) {
              return existing.socket;
            }
            if (existing.socket.readyState === WebSocket.CONNECTING) {
              await existing.openPromise;
              return existing.socket;
            }
            closeWebSocketConnection(subscription.subscriptionSlug);
          }

          const socket = new WebSocket(subscription.URL, {
            ...(subscription.httpRequestHeaders !== undefined
              ? { headers: subscription.httpRequestHeaders }
              : {}),
          });

          const openPromise = new Promise<void>((resolve, reject) => {
            const onOpen = () => {
              cleanup();
              resolve();
            };
            const onError = (error: Error) => {
              cleanup();
              reject(error);
            };
            const cleanup = () => {
              socket.off("open", onOpen);
              socket.off("error", onError);
            };
            socket.once("open", onOpen);
            socket.once("error", onError);
          });

          wsConnections.set(subscription.subscriptionSlug, { socket, openPromise });
          socket.on("close", () => {
            const latest = wsConnections.get(subscription.subscriptionSlug);
            if (latest?.socket === socket) {
              if (latest.idleTimer !== undefined) {
                clearTimeout(latest.idleTimer);
              }
              wsConnections.delete(subscription.subscriptionSlug);
            }
          });

          await openPromise;
          return socket;
        },
        catch: (error) =>
          new WebhookDeliveryError({
            message: error instanceof Error ? error.message : String(error),
          }),
      });

    const sendOverWebSocket = (
      subscription: PushSubscriptionCallbackAddedPayload,
      event: Event,
    ): Effect.Effect<void, WebhookDeliveryError> =>
      Effect.gen(function* () {
        const socket = yield* ensureWebSocket(subscription);

        yield* Effect.tryPromise({
          try: () =>
            new Promise<void>((resolve, reject) => {
              socket.send(JSON.stringify(encodeEvent(event)), (error) => {
                if (error) {
                  reject(error);
                } else {
                  resolve();
                }
              });
            }),
          catch: (error) => {
            closeWebSocketConnection(subscription.subscriptionSlug);
            return new WebhookDeliveryError({
              message: error instanceof Error ? error.message : String(error),
            });
          },
        });
      });

    const toDeliverableEvent = (
      subscription: PushSubscriptionCallbackAddedPayload,
      event: Event,
    ): Effect.Effect<Event | undefined, WebhookDeliveryError> =>
      Effect.tryPromise({
        try: async () => {
          if (subscription.jsonataFilter !== undefined) {
            const filter = jsonata(subscription.jsonataFilter);
            const matched = await filter.evaluate(encodeEvent(event));
            if (!matched) {
              return undefined;
            }
          }

          if (subscription.jsonataTransform === undefined) {
            return event;
          }

          const transform = jsonata(subscription.jsonataTransform);
          const transformedPayload = await transform.evaluate(event.payload);
          if (!isRecord(transformedPayload)) {
            throw new Error("jsonataTransform must evaluate to an object payload");
          }

          return Event.make({
            ...event,
            payload: transformedPayload as Payload,
          });
        },
        catch: (error) =>
          new WebhookDeliveryError({
            message: error instanceof Error ? error.message : String(error),
          }),
      });

    const postWebhook = (
      subscription: PushSubscriptionCallbackAddedPayload,
      event: Event,
    ): Effect.Effect<void, WebhookDeliveryError> => {
      const policy = toRetryPolicyWithDefaults(subscription.retryPolicy);
      const retryOptions = {
        ...(policy.times !== undefined ? { times: policy.times } : {}),
        ...(policy.schedule !== undefined ? { schedule: toRetrySchedule(policy.schedule) } : {}),
      };

      return Effect.tryPromise({
        try: () =>
          fetch(subscription.URL, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(subscription.httpRequestHeaders ?? {}),
            },
            body: JSON.stringify(encodeEvent(event)),
          }),
        catch: (error) =>
          new WebhookDeliveryError({
            message: error instanceof Error ? error.message : String(error),
          }),
      }).pipe(
        Effect.flatMap((response) =>
          response.ok
            ? Effect.void
            : Effect.fail(
                new WebhookDeliveryError({
                  message: `${PUSH_SUBSCRIPTION_CALLBACK_ADDED_TYPE} failed: ${response.status} ${response.statusText}`,
                }),
              ),
        ),
        Effect.retry(retryOptions),
      );
    };

    const enqueueOrdered = (
      subscriptionSlug: string,
      delivery: Effect.Effect<void, WebhookDeliveryError>,
    ): Effect.Effect<void> => {
      const previous = orderedChains.get(subscriptionSlug) ?? Promise.resolve();
      const next = previous.then(() => runPromise(delivery));
      orderedChains.set(subscriptionSlug, next);
      void next.catch(() => {});
      return Effect.void;
    };

    const deliverWebhook = (
      subscription: PushSubscriptionCallbackAddedPayload,
      event: Event,
      withAck: boolean,
    ): Effect.Effect<void> => {
      const delivery = postWebhook(subscription, event).pipe(
        Effect.flatMap(() => markDelivered(subscription.subscriptionSlug, event.offset)),
      );

      if (withAck) {
        return enqueueOrdered(subscription.subscriptionSlug, delivery);
      }

      return delivery.pipe(Effect.catchAll(() => Effect.void));
    };

    const deliverWebSocket = (
      subscription: PushSubscriptionCallbackAddedPayload,
      event: Event,
      withAck: boolean,
    ): Effect.Effect<void> => {
      const baseSend = sendOverWebSocket(subscription, event);

      const delivery = withAck
        ? baseSend.pipe(
            Effect.flatMap(() => waitForExternalAck(subscription.subscriptionSlug, event.offset)),
            Effect.tap(() =>
              Effect.sync(() => resetWebSocketIdleTimer(subscription.subscriptionSlug)),
            ),
          )
        : baseSend.pipe(
            Effect.flatMap(() => markDelivered(subscription.subscriptionSlug, event.offset)),
            Effect.tap(() =>
              Effect.sync(() => resetWebSocketIdleTimer(subscription.subscriptionSlug)),
            ),
          );

      return enqueueOrdered(subscription.subscriptionSlug, delivery);
    };

    const shouldSkipDirectDeliveryForSubscriptionAddedEvent = (
      subscription: PushSubscriptionCallbackAddedPayload,
      event: Event,
    ): boolean => {
      if (!isPushSubscriptionAddedEvent(event)) return false;
      const payload = parsePushSubscriptionPayload(event.payload);
      if (payload === undefined) return false;
      return (
        payload.subscriptionSlug === subscription.subscriptionSlug &&
        payload.sendHistoricEventsFromOffset !== undefined
      );
    };

    const deliverToSubscription = (
      entry: {
        readonly subscription: PushSubscriptionCallbackAddedPayload;
        readonly lastDeliveredOffset?: Offset;
      },
      event: Event,
      options?: {
        readonly skipSelfAddedEvent?: boolean;
      },
    ): Effect.Effect<void> => {
      if (
        entry.lastDeliveredOffset !== undefined &&
        Offset.lte(event.offset, entry.lastDeliveredOffset)
      ) {
        return Effect.void;
      }

      if (
        options?.skipSelfAddedEvent === true &&
        shouldSkipDirectDeliveryForSubscriptionAddedEvent(entry.subscription, event)
      ) {
        return Effect.void;
      }

      return toDeliverableEvent(entry.subscription, event).pipe(
        Effect.flatMap((deliverableEvent) => {
          if (deliverableEvent === undefined) return Effect.void;

          if (entry.subscription.type === "webhook") {
            return deliverWebhook(entry.subscription, deliverableEvent, false);
          }

          if (entry.subscription.type === "webhook-with-ack") {
            return deliverWebhook(entry.subscription, deliverableEvent, true);
          }

          if (entry.subscription.type === "websocket") {
            return deliverWebSocket(entry.subscription, deliverableEvent, false);
          }

          return deliverWebSocket(entry.subscription, deliverableEvent, true);
        }),
        Effect.catchAll(() => Effect.void),
      );
    };

    const deliverToPushSubscriptions = (event: Event): Effect.Effect<void> => {
      const activeSubscriptions = Array.from(state.pushSubscriptions.values());
      return Effect.forEach(
        activeSubscriptions,
        (entry) =>
          deliverToSubscription(entry, event, {
            skipSelfAddedEvent: true,
          }),
        {
          concurrency: "unbounded",
          discard: true,
        },
      );
    };

    const replayHistoricEventsIfRequested = (event: Event): Effect.Effect<void> => {
      if (!isPushSubscriptionAddedEvent(event)) return Effect.void;

      const payload = parsePushSubscriptionPayload(event.payload);
      if (payload === undefined || payload.sendHistoricEventsFromOffset === undefined) {
        return Effect.void;
      }

      const startOffset = Offset.make(payload.sendHistoricEventsFromOffset);
      return storage.read().pipe(
        Stream.filter((historicalEvent) => Offset.gte(historicalEvent.offset, startOffset)),
        Stream.runForEach((historicalEvent) => {
          const current = state.pushSubscriptions.get(payload.subscriptionSlug);
          if (current === undefined) return Effect.void;
          return deliverToSubscription(current, historicalEvent);
        }),
      );
    };

    const append = (eventInput: EventInput) =>
      Effect.gen(function* () {
        const nextOffset = formatOffset(offsetToNumber(state.lastOffset) + 1);
        const createdAt = yield* DateTime.now;
        const trace = yield* fromCurrentSpan;
        const event = Event.make({ ...eventInput, path, offset: nextOffset, createdAt, trace });

        yield* storage.append(event);
        state = reduce(state, event);

        yield* Effect.all([
          deliverToPushSubscriptions(event),
          replayHistoricEventsIfRequested(event),
        ]).pipe(Effect.forkDaemon, Effect.asVoid);

        yield* PubSub.publish(pubsub, event);
        return event;
      });

    // Handle subscription requests by combining historical + live events.
    //
    // Race condition we're avoiding: while reading historical events, new events
    // may be appended and published to pubsub. Without dedup, subscriber would
    // see duplicates (once from historical read, once from pubsub).
    //
    // Solution: subscribe to pubsub FIRST (so we don't miss anything), read
    // historical while tracking the last offset seen, then dropWhile on live
    // to skip any events we already emitted from historical.
    const beSubscribedTo = (options?: { from?: Offset }) =>
      Stream.unwrapScoped(
        Effect.gen(function* () {
          let lastOffset = options?.from ?? Offset.make("-1");

          const queue = yield* PubSub.subscribe(pubsub);
          const liveStream = Stream.fromQueue(queue);

          const trackedHistorical = storage
            .read({ from: lastOffset })
            .pipe(
              Stream.tap((streamEvent) => Effect.sync(() => (lastOffset = streamEvent.offset))),
            );

          const dedupedLive = liveStream.pipe(
            Stream.dropWhile((streamEvent) => Offset.lte(streamEvent.offset, lastOffset)),
          );

          return Stream.concat(trackedHistorical, dedupedLive);
        }),
      ).pipe(Stream.catchAllCause(() => Stream.empty));

    const read = (options?: { from?: Offset; to?: Offset }) =>
      storage.read(options).pipe(Stream.catchAllCause(() => Stream.empty));

    const ackOffset = ({
      subscriptionSlug,
      offset,
    }: {
      subscriptionSlug: string;
      offset: Offset;
    }) => markDelivered(subscriptionSlug, offset);

    return { append, subscribe: beSubscribedTo, read, ackOffset };
  });
