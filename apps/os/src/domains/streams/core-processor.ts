import {
  StreamReceiverUnavailableError,
  type StreamEvent,
  type StreamEventInput,
} from "iterate/processors";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import {
  CoreProcessorContract,
  MAX_SOURCE_STREAMS_PER_RECEIVING_STREAM,
  MAX_SUBSCRIPTIONS_PER_RECEIVING_STREAM,
  parseCommittedCoreEvent as parseCoreEvent,
  subscriptionKeyForConfiguredEvent,
  type CoreProcessorState,
} from "./core-processor-contract.ts";
import { compileEventFilter, compileJsonataExpression } from "./event-filter.ts";
import { isInternalStreamIdempotencyKey } from "./stream-delivery-utils.ts";

export const STREAM_PAUSED_ERROR_PREFIX = "stream paused: ";

/**
 * Core state is checkpointed as one SQLite-backed Durable Object KV value.
 * Keep retained configuration/list growth near half of Cloudflare's documented
 * 2 MB combined key/value limit so structured-clone encoding, growing counters,
 * and small schema additions cannot turn an already-committed event into an
 * unwriteable checkpoint. Mutations that skip the full scan only add bounded
 * cursor/timestamp/counter fields to entries whose substantially larger
 * configuration already passed this limit, so the remaining 1 MiB is also the
 * headroom for that fixed-shape drift.
 */
export const MAX_CORE_PROCESSOR_STATE_BYTES = 1024 * 1024;

const textEncoder = new TextEncoder();

function coreProcessorStateByteLength(state: CoreProcessorState): number {
  return textEncoder.encode(JSON.stringify(state)).byteLength;
}

/**
 * These events can retain caller-controlled strings or add collection entries
 * to core state. Ordinary product events and fixed-shape lifecycle facts only
 * advance bounded bookkeeping, so they must not pay an O(state) JSON scan or
 * fail merely because a counter gained a digit. `subscription-removed` is not a
 * growth event: configuring a cross-post subscription always creates its cross-post-list
 * entry, and an empty-list acknowledgement can delete that entry only after no
 * configured subscription points at the receiver, so removal can refresh but not add a
 * receiver path.
 */
const CHECKPOINT_GROWTH_EVENT_TYPES = new Set<string>([
  "events.iterate.com/stream/created",
  "events.iterate.com/stream/child-stream-created",
  "events.iterate.com/stream/subscription-configured",
  "events.iterate.com/stream/cross-post-list-recorded",
  "events.iterate.com/stream/cross-post-list-confirmed",
  "events.iterate.com/stream/cross-post-list-delivery-blocked",
  "events.iterate.com/stream/subscription-delivery-halted",
  "events.iterate.com/stream/paused",
]);

/**
 * Enforce checkpoint growth once per append batch, after its complete fold and
 * before any event row is inserted. Shrinking and neutral changes remain
 * available as the escape hatch if a future schema makes existing state larger
 * than the current safety limit.
 */
export function assertCoreProcessorCheckpointGrowthFits(args: {
  before: CoreProcessorState;
  events: readonly StreamEvent[];
  next: CoreProcessorState;
}): void {
  if (
    !args.events.some(
      (event) =>
        event.source?.crossPostedFrom === undefined &&
        CHECKPOINT_GROWTH_EVENT_TYPES.has(event.type),
    )
  ) {
    return;
  }

  const byteLength = coreProcessorStateByteLength(args.next);
  if (byteLength <= MAX_CORE_PROCESSOR_STATE_BYTES) return;
  if (byteLength <= coreProcessorStateByteLength(args.before)) return;
  throw new Error(
    `core processor state is ${byteLength} bytes; checkpoint safety limit is ${MAX_CORE_PROCESSOR_STATE_BYTES} bytes`,
  );
}

const CORE_AUTHORED_EVENT_TYPES = new Set<string>([
  "events.iterate.com/stream/created",
  "events.iterate.com/stream/woken",
  "events.iterate.com/stream/child-stream-created",
  "events.iterate.com/stream/cross-post-list-confirmed",
  "events.iterate.com/stream/cross-post-list-delivery-blocked",
  "events.iterate.com/stream/subscription-delivery-halted",
  "events.iterate.com/stream/connection-opened",
  "events.iterate.com/stream/connection-closed",
]);

const CIRCUIT_BREAKER_FREE_CONTROL_EVENT_TYPES = new Set<string>([
  "events.iterate.com/stream/woken",
  "events.iterate.com/stream/paused",
  "events.iterate.com/stream/resumed",
  "events.iterate.com/stream/configured",
]);

type ParsedCoreEventInput = ReturnType<typeof CoreProcessorContract.parseEventInput>;

function parseCoreEventInput<const Type extends ParsedCoreEventInput["type"]>(
  event: StreamEventInput,
  expectedType: Type,
): Extract<ParsedCoreEventInput, { type: Type }> {
  if (event.type !== expectedType) {
    throw new Error(`expected core event input "${expectedType}", got "${event.type}"`);
  }
  return CoreProcessorContract.parseEventInput(
    event as StreamEventInput & { type: Type },
  ) as Extract<ParsedCoreEventInput, { type: Type }>;
}

function currentInboundSubscription(
  state: CoreProcessorState,
  coordinate: {
    projectId: string | null;
    path: string;
    streamId: string;
    streamCreatedAt: string;
    subscriptionKey: string;
  },
) {
  const source = state.subscriptions.inbound.bySourcePath[coordinate.path];
  const subscription = source?.byKey[coordinate.subscriptionKey];
  if (
    subscription === undefined ||
    source.source.projectId !== coordinate.projectId ||
    source.source.streamId !== coordinate.streamId ||
    source.source.streamCreatedAt !== coordinate.streamCreatedAt
  ) {
    return undefined;
  }
  return { subscription, source };
}

function currentInboundSubscriptionForHop(
  state: CoreProcessorState,
  hop: NonNullable<NonNullable<StreamEvent["source"]>["crossPostedFrom"]>[number] | undefined,
) {
  return hop === undefined ? undefined : currentInboundSubscription(state, hop);
}

/**
 * A change to one key must refresh every stream that still says it has that
 * key, including an older blocked receiver that is no longer named by the
 * current configuration. Otherwise removing and later recreating the key can
 * leave matching-event sending permanently held by a stale acknowledged list.
 */
function markCrossPostListsPending(args: {
  directlyChangedPaths: Iterable<string>;
  lists: CoreProcessorState["crossPostListDeliveriesByReceivingStream"];
  subscriptionKey: string;
  sourceOffset: number;
}): CoreProcessorState["crossPostListDeliveriesByReceivingStream"] {
  const pathsToRefresh = new Set(args.directlyChangedPaths);
  for (const [receivingStreamPath, list] of Object.entries(args.lists)) {
    if (list.subscriptionKeysRecordedByReceiver.includes(args.subscriptionKey)) {
      pathsToRefresh.add(receivingStreamPath);
    }
  }

  const lists = { ...args.lists };
  for (const receivingStreamPath of pathsToRefresh) {
    lists[receivingStreamPath] = {
      sourceOffset: args.sourceOffset,
      status: "pending",
      subscriptionKeysRecordedByReceiver:
        lists[receivingStreamPath]?.subscriptionKeysRecordedByReceiver ?? [],
    };
  }
  return lists;
}

/**
 * Compare complete lists from one source path across destructive stream
 * recreation. Creation time orders lifetimes, the random stream ID makes a
 * same-millisecond tie deterministic, and offsets order lists within one
 * lifetime. If a clock moves backwards (or the new random ID loses a timestamp
 * tie), the receiver keeps the existing list and the source fails loudly when
 * it cannot confirm its new list instead of silently mixing lifetimes.
 */
export function compareSourceListPosition(
  incoming: { streamId: string; streamCreatedAt: string; sourceOffset: number },
  recorded: {
    source: { streamId: string; streamCreatedAt: string };
    sourceOffset: number;
  },
): number {
  const creationTimeDifference =
    Date.parse(incoming.streamCreatedAt) - Date.parse(recorded.source.streamCreatedAt);
  if (creationTimeDifference !== 0) return creationTimeDifference;
  const streamIdDifference =
    incoming.streamId < recorded.source.streamId
      ? -1
      : incoming.streamId > recorded.source.streamId
        ? 1
        : 0;
  if (streamIdDifference !== 0) return streamIdDifference;
  return incoming.sourceOffset - recorded.sourceOffset;
}

/**
 * The stream's built-in processor. Validation and reduction run inline as
 * part of the append commit turn. Runtime work is deliberately not dispatched
 * from individual event edges: the Durable Object reconciles it from the
 * resulting reduced state after every append and alarm.
 */
export class StreamCoreProcessor {
  readonly #projectId: string | null;

  constructor(args: { projectId: string | null }) {
    this.#projectId = args.projectId;
  }

  /**
   * Parse every core-owned event exactly once before idempotency, validation,
   * persistence, reduction, and hooks see it. Zod transforms (notably stream
   * path canonicalization) and stripped defaults therefore become the durable
   * event body instead of validation-only throwaway work.
   */
  canonicalize(event: StreamEventInput): StreamEventInput {
    // A copied stream control event is product data on this stream, not one of
    // this stream's own commands. Preserve its historical body verbatim: the
    // receiver-side provenance is what makes it inert, even when its payload
    // no longer matches the current first-hand control-event schema.
    if (event.source?.crossPostedFrom !== undefined) return event;
    if (!Object.hasOwn(CoreProcessorContract.events, event.type)) return event;
    return CoreProcessorContract.parseEventInput(event as never) as StreamEventInput;
  }

  validate(args: {
    event: StreamEventInput;
    state: CoreProcessorState;
    authority: "public" | "core-event" | "cross-post-list" | "cross-post";
  }): void {
    if (args.event.ephemeral && args.event.type.startsWith("events.iterate.com/stream/")) {
      throw new Error("stream control events cannot be ephemeral");
    }

    if (args.authority === "public" && isInternalStreamIdempotencyKey(args.event.idempotencyKey)) {
      throw new Error("iterate-internal idempotency keys are platform-authored");
    }

    const isFirstHand = args.event.source?.crossPostedFrom === undefined;
    if (!isFirstHand && args.authority !== "cross-post") {
      throw new Error("cross-post source information is platform-authored");
    }
    if (
      !isFirstHand &&
      currentInboundSubscriptionForHop(args.state, args.event.source?.crossPostedFrom?.at(-1)) ===
        undefined
    ) {
      const hop = args.event.source?.crossPostedFrom?.at(-1);
      throw new Error(
        hop === undefined
          ? "received event has no source hop"
          : `received event does not match the current subscription "${hop.subscriptionKey}" from "${hop.path}"`,
      );
    }
    if (
      isFirstHand &&
      args.event.type === "events.iterate.com/stream/cross-post-list-recorded" &&
      args.authority !== "cross-post-list"
    ) {
      throw new Error("cross-post lists from source streams are platform-authored");
    }
    if (
      isFirstHand &&
      args.event.type === "events.iterate.com/stream/cross-posted-events-dropped" &&
      args.authority !== "cross-post"
    ) {
      throw new Error("cross-post drop records are platform-authored");
    }
    if (
      isFirstHand &&
      args.event.type === "events.iterate.com/stream/cross-posted-events-dropped" &&
      args.authority === "cross-post"
    ) {
      const event = parseCoreEventInput(
        args.event,
        "events.iterate.com/stream/cross-posted-events-dropped",
      );
      if (
        currentInboundSubscription(args.state, {
          ...event.payload.source,
          subscriptionKey: event.payload.subscriptionKey,
        }) === undefined
      ) {
        throw new Error(
          `dropped events do not match the current subscription "${event.payload.subscriptionKey}" from "${event.payload.source.path}"`,
        );
      }
    }

    if (isFirstHand && args.event.type === "events.iterate.com/stream/cross-post-list-recorded") {
      const event = parseCoreEventInput(
        args.event,
        "events.iterate.com/stream/cross-post-list-recorded",
      );
      const existing = args.state.subscriptions.inbound.bySourcePath[event.payload.source.path];
      if (
        existing === undefined &&
        Object.keys(event.payload.subscriptionsByKey).length > 0 &&
        Object.keys(args.state.subscriptions.inbound.bySourcePath).length >=
          MAX_SOURCE_STREAMS_PER_RECEIVING_STREAM
      ) {
        throw new Error(
          `a receiving stream may record subscriptions from at most ${MAX_SOURCE_STREAMS_PER_RECEIVING_STREAM} source streams`,
        );
      }
      if (event.payload.source.projectId !== this.#projectId) {
        throw new Error("a receiving stream can only record subscriptions from its own project");
      }
      if (event.payload.source.path === args.state.path) {
        throw new Error("a stream cannot record itself as a subscription source");
      }
      for (const [subscriptionKey, record] of Object.entries(event.payload.subscriptionsByKey)) {
        if (record.configuredAtSourceOffset > event.payload.sourceOffset) {
          throw new Error(
            `subscription "${subscriptionKey}" was configured after this cross-post list's source offset`,
          );
        }
        compileEventFilter(record.configuration.filter);
        if (record.configuration.transform !== undefined) {
          compileJsonataExpression(record.configuration.transform);
        }
      }
    }
    if (
      isFirstHand &&
      CORE_AUTHORED_EVENT_TYPES.has(args.event.type) &&
      args.authority !== "core-event"
    ) {
      throw new Error(`stream event "${args.event.type}" is platform-authored`);
    }

    if (isFirstHand && args.event.type === "events.iterate.com/stream/subscription-configured") {
      const event = parseCoreEventInput(
        args.event,
        "events.iterate.com/stream/subscription-configured",
      );
      const requestedSubscriptionKey = event.payload.subscriptionKey;
      if (
        requestedSubscriptionKey?.startsWith("subscription:") === true &&
        args.state.subscriptions.outbound.byKey[requestedSubscriptionKey]
          ?.subscriptionKeyWasGenerated !== true
      ) {
        throw new Error(
          `subscription key "${requestedSubscriptionKey}" uses the generated-key namespace but does not name an existing generated subscription`,
        );
      }
      if (event.payload.receiver.action === "webhook-post" && this.#projectId === null) {
        throw new Error("webhook subscriptions require a project-scoped stream");
      }
      if (
        event.payload.receiver.action !== "processor-wake" &&
        typeof event.payload.receiver.delivery.start === "object" &&
        event.payload.receiver.delivery.start.afterOffset > args.state.maxOffset
      ) {
        throw new Error(
          `subscription afterOffset ${event.payload.receiver.delivery.start.afterOffset} is beyond this stream's current maximum offset ${args.state.maxOffset}`,
        );
      }
      if (
        event.payload.receiver.action === "cross-post" &&
        event.payload.receiver.receivingStreamPath === args.state.path
      ) {
        throw new Error("a stream cannot receive events from itself");
      }
      compileEventFilter(event.payload.filter);
      if (
        event.payload.receiver.action === "cross-post" &&
        event.payload.receiver.transform !== undefined
      ) {
        compileJsonataExpression(event.payload.receiver.transform);
      }
      if (event.payload.receiver.action === "cross-post") {
        const receivingStreamPath = event.payload.receiver.receivingStreamPath;
        const existingSubscriptionsForReceiver = Object.entries(
          args.state.subscriptions.outbound.byKey,
        ).filter(
          ([subscriptionKey, configured]) =>
            (event.payload.subscriptionKey === undefined ||
              subscriptionKey !== event.payload.subscriptionKey) &&
            configured.configuration.receiver.action === "cross-post" &&
            configured.configuration.receiver.receivingStreamPath === receivingStreamPath,
        ).length;
        if (existingSubscriptionsForReceiver >= MAX_SUBSCRIPTIONS_PER_RECEIVING_STREAM) {
          throw new Error(
            `a source may configure at most ${MAX_SUBSCRIPTIONS_PER_RECEIVING_STREAM} subscriptions for one receiving stream`,
          );
        }
        DurableObjectNameCodec.stringify(
          { projectId: this.#projectId, path: receivingStreamPath },
          { allowNullProjectId: true },
        );
      }
    }

    if (isFirstHand && args.event.type === "events.iterate.com/stream/subscription-cursor-set") {
      const event = parseCoreEventInput(
        args.event,
        "events.iterate.com/stream/subscription-cursor-set",
      );
      const configured = args.state.subscriptions.outbound.byKey[event.payload.subscriptionKey];
      if (configured === undefined) {
        throw new Error(`subscription "${event.payload.subscriptionKey}" does not exist`);
      }
      if (configured.configuration.receiver.action === "processor-wake") {
        throw new Error(
          "hosted processors own their checkpoint; their subscription cursor cannot be set",
        );
      }
      if (event.payload.afterOffset > args.state.maxOffset) {
        throw new Error(
          `subscription afterOffset ${event.payload.afterOffset} is beyond this stream's current maximum offset ${args.state.maxOffset}`,
        );
      }
    }

    if (
      isFirstHand &&
      args.event.type === "events.iterate.com/stream/subscription-delivery-resumed"
    ) {
      const event = parseCoreEventInput(
        args.event,
        "events.iterate.com/stream/subscription-delivery-resumed",
      );
      const configured = args.state.subscriptions.outbound.byKey[event.payload.subscriptionKey];
      if (configured === undefined) {
        throw new Error(`subscription "${event.payload.subscriptionKey}" does not exist`);
      }
      if (configured.deliveryHalted === undefined) {
        throw new Error(`subscription "${event.payload.subscriptionKey}" is not halted`);
      }
    }

    if (isFirstHand && args.event.type === "events.iterate.com/stream/subscription-removed") {
      const event = parseCoreEventInput(
        args.event,
        "events.iterate.com/stream/subscription-removed",
      );
      const expectedAuthority =
        event.payload.reason === "requested" ? "public" : ("core-event" as const);
      if (args.authority !== expectedAuthority) {
        throw new Error(
          event.payload.reason === "requested"
            ? "requested subscription removals must come from a public command"
            : `${event.payload.reason} subscription removals are platform-authored after the configured end condition is reached`,
        );
      }
      if (args.state.subscriptions.outbound.byKey[event.payload.subscriptionKey] === undefined) {
        throw new Error(`subscription "${event.payload.subscriptionKey}" does not exist`);
      }
    }

    if (
      isFirstHand &&
      args.event.type === "events.iterate.com/stream/cross-post-list-resend-requested"
    ) {
      const event = parseCoreEventInput(
        args.event,
        "events.iterate.com/stream/cross-post-list-resend-requested",
      );
      const receiver =
        args.state.crossPostListDeliveriesByReceivingStream[event.payload.receivingStreamPath];
      if (receiver?.status !== "blocked") {
        throw new Error(
          `receiving stream "${event.payload.receivingStreamPath}" has no blocked cross-post list to resend`,
        );
      }
    }

    if (!args.state.paused) return;
    switch (args.event.type) {
      case "events.iterate.com/stream/resumed":
      case "events.iterate.com/stream/error-occurred":
      case "events.iterate.com/stream/woken":
      case "events.iterate.com/stream/connection-opened":
      case "events.iterate.com/stream/connection-closed":
      case "events.iterate.com/stream/cross-post-list-recorded":
      case "events.iterate.com/stream/subscription-removed":
      case "events.iterate.com/stream/subscription-delivery-halted":
      case "events.iterate.com/stream/cross-post-list-delivery-blocked":
      case "events.iterate.com/stream/cross-post-list-confirmed":
      case "events.iterate.com/stream/cross-post-list-resend-requested":
      case "events.iterate.com/stream/cross-posted-events-dropped":
        return;
      default:
        throw new StreamReceiverUnavailableError(
          `${STREAM_PAUSED_ERROR_PREFIX}${args.state.pauseReason ?? "unknown reason"}`,
        );
    }
  }

  reduce(args: { event: StreamEvent; state: CoreProcessorState }): CoreProcessorState {
    const state = this.#reduceState(args);
    return args.event.source?.crossPostedFrom === undefined &&
      CIRCUIT_BREAKER_FREE_CONTROL_EVENT_TYPES.has(args.event.type)
      ? state
      : this.#reduceCircuitBreaker({ event: args.event, state });
  }

  #reduceState(args: { event: StreamEvent; state: CoreProcessorState }): CoreProcessorState {
    let next: CoreProcessorState = {
      ...args.state,
      eventCount: args.state.eventCount + 1,
      maxOffset: args.event.offset,
    };

    const crossPostedFrom = args.event.source?.crossPostedFrom?.at(-1);
    const receivedSubscription = currentInboundSubscriptionForHop(next, crossPostedFrom);
    if (crossPostedFrom !== undefined && receivedSubscription !== undefined) {
      const { subscription, source } = receivedSubscription;
      next = {
        ...next,
        subscriptions: {
          ...next.subscriptions,
          inbound: {
            ...next.subscriptions.inbound,
            bySourcePath: {
              ...next.subscriptions.inbound.bySourcePath,
              [crossPostedFrom.path]: {
                ...source,
                byKey: {
                  ...source.byKey,
                  [crossPostedFrom.subscriptionKey]: {
                    ...subscription,
                    numEventsReceived: subscription.numEventsReceived + 1,
                    lastEventReceivedAt: args.event.createdAt,
                  },
                },
              },
            },
          },
        },
      };
    }

    if (
      args.event.type.startsWith("events.iterate.com/stream/") &&
      args.event.source?.crossPostedFrom !== undefined
    ) {
      return next;
    }

    switch (args.event.type) {
      case "events.iterate.com/stream/created": {
        const event = parseCoreEvent(args.event, "events.iterate.com/stream/created");
        if (event.offset !== 1) {
          throw new Error(
            "events.iterate.com/stream/created must be the first event and have offset 1",
          );
        }
        return {
          ...next,
          projectId: event.payload.projectId,
          path: event.payload.path,
          streamId: event.payload.streamId,
          createdAt: event.createdAt,
        };
      }
      case "events.iterate.com/stream/woken": {
        const event = parseCoreEvent(args.event, "events.iterate.com/stream/woken");
        return { ...next, incarnationId: event.payload.incarnationId };
      }
      case "events.iterate.com/stream/paused": {
        const event = parseCoreEvent(args.event, "events.iterate.com/stream/paused");
        return {
          ...next,
          paused: true,
          pauseReason: event.payload.reason ?? null,
          circuitBreaker: resetCircuitBreaker(next.circuitBreaker, event.createdAt),
        };
      }
      case "events.iterate.com/stream/resumed": {
        const event = parseCoreEvent(args.event, "events.iterate.com/stream/resumed");
        return {
          ...next,
          paused: false,
          pauseReason: null,
          circuitBreaker: resetCircuitBreaker(next.circuitBreaker, event.createdAt),
        };
      }
      case "events.iterate.com/stream/configured": {
        const event = parseCoreEvent(args.event, "events.iterate.com/stream/configured");
        const circuitBreaker = event.payload.config.circuitBreaker;
        if (circuitBreaker === undefined) return next;
        return {
          ...next,
          circuitBreaker: {
            availableTokens: circuitBreaker.burstCapacity,
            lastRefillAtMs: Date.parse(event.createdAt),
            burstCapacity: circuitBreaker.burstCapacity,
            refillRatePerMinute: circuitBreaker.refillRatePerMinute,
            trippedAtOffset: null,
          },
        };
      }
      case "events.iterate.com/stream/connection-opened": {
        const event = parseCoreEvent(args.event, "events.iterate.com/stream/connection-opened");
        void event;
        return next;
      }
      case "events.iterate.com/stream/connection-closed": {
        parseCoreEvent(args.event, "events.iterate.com/stream/connection-closed");
        return next;
      }
      case "events.iterate.com/stream/subscription-configured": {
        const event = parseCoreEvent(
          args.event,
          "events.iterate.com/stream/subscription-configured",
        );
        const subscriptionKey = subscriptionKeyForConfiguredEvent(event);
        const existing = next.subscriptions.outbound.byKey[subscriptionKey];
        const subscriptionKeyWasGenerated =
          event.payload.subscriptionKey === undefined ||
          existing?.subscriptionKeyWasGenerated === true;
        const changedPaths = new Set<string>();
        if (existing?.configuration.receiver.action === "cross-post") {
          changedPaths.add(existing.configuration.receiver.receivingStreamPath);
        }
        if (event.payload.receiver.action === "cross-post") {
          changedPaths.add(event.payload.receiver.receivingStreamPath);
        }
        const crossPostListDeliveriesByReceivingStream = markCrossPostListsPending({
          lists: next.crossPostListDeliveriesByReceivingStream,
          subscriptionKey,
          sourceOffset: event.offset,
          directlyChangedPaths: changedPaths,
        });
        return {
          ...next,
          subscriptions: {
            ...next.subscriptions,
            outbound: {
              ...next.subscriptions.outbound,
              byKey: {
                ...next.subscriptions.outbound.byKey,
                [subscriptionKey]: {
                  configuration: { ...event.payload, subscriptionKey },
                  configuredAtOffset: event.offset,
                  configuredAt: event.createdAt,
                  ...(subscriptionKeyWasGenerated ? { subscriptionKeyWasGenerated: true } : {}),
                },
              },
            },
          },
          crossPostListDeliveriesByReceivingStream,
        };
      }
      case "events.iterate.com/stream/cross-post-list-recorded": {
        const event = parseCoreEvent(
          args.event,
          "events.iterate.com/stream/cross-post-list-recorded",
        );
        const sourcePath = event.payload.source.path;
        const existing = next.subscriptions.inbound.bySourcePath[sourcePath];
        // This state check orders lists while a non-empty record exists.
        // Recording an empty list removes that record, so
        // recordCrossPostListFromSource also compares against the latest matching
        // journal event before appending. That log check is authoritative
        // across an empty-list removal.
        if (
          existing !== undefined &&
          compareSourceListPosition(
            {
              streamId: event.payload.source.streamId,
              streamCreatedAt: event.payload.source.streamCreatedAt,
              sourceOffset: event.payload.sourceOffset,
            },
            existing,
          ) <= 0
        ) {
          return next;
        }
        const subscriptionsByKey = Object.fromEntries(
          Object.entries(event.payload.subscriptionsByKey).map(([subscriptionKey, received]) => {
            const previous = existing?.byKey[subscriptionKey];
            const keepCounts =
              previous !== undefined &&
              existing?.source.streamId === event.payload.source.streamId &&
              existing?.source.streamCreatedAt === event.payload.source.streamCreatedAt &&
              previous.configuredAtSourceOffset === received.configuredAtSourceOffset;
            return [
              subscriptionKey,
              {
                ...received,
                numEventsReceived: keepCounts ? previous.numEventsReceived : 0,
                numEventsDropped: keepCounts ? previous.numEventsDropped : 0,
                ...(keepCounts && previous.lastEventReceivedAt !== undefined
                  ? { lastEventReceivedAt: previous.lastEventReceivedAt }
                  : {}),
              },
            ];
          }),
        );
        const bySourcePath = { ...next.subscriptions.inbound.bySourcePath };
        if (Object.keys(subscriptionsByKey).length === 0) {
          delete bySourcePath[sourcePath];
        } else {
          bySourcePath[sourcePath] = {
            source: event.payload.source,
            sourceOffset: event.payload.sourceOffset,
            byKey: subscriptionsByKey,
          };
        }
        return {
          ...next,
          subscriptions: {
            ...next.subscriptions,
            inbound: {
              ...next.subscriptions.inbound,
              bySourcePath,
            },
          },
        };
      }
      case "events.iterate.com/stream/subscription-removed": {
        const event = parseCoreEvent(args.event, "events.iterate.com/stream/subscription-removed");
        const existing = next.subscriptions.outbound.byKey[event.payload.subscriptionKey];
        const { [event.payload.subscriptionKey]: _removed, ...byKey } =
          next.subscriptions.outbound.byKey;
        const changedPaths = new Set<string>();
        if (existing?.configuration.receiver.action === "cross-post") {
          changedPaths.add(existing.configuration.receiver.receivingStreamPath);
        }
        const crossPostListDeliveriesByReceivingStream = markCrossPostListsPending({
          lists: next.crossPostListDeliveriesByReceivingStream,
          subscriptionKey: event.payload.subscriptionKey,
          sourceOffset: event.offset,
          directlyChangedPaths: changedPaths,
        });
        return {
          ...next,
          subscriptions: {
            ...next.subscriptions,
            outbound: {
              ...next.subscriptions.outbound,
              byKey,
            },
          },
          crossPostListDeliveriesByReceivingStream,
        };
      }
      case "events.iterate.com/stream/cross-post-list-confirmed": {
        const event = parseCoreEvent(
          args.event,
          "events.iterate.com/stream/cross-post-list-confirmed",
        );
        const current =
          next.crossPostListDeliveriesByReceivingStream[event.payload.receivingStreamPath];
        if (current?.sourceOffset !== event.payload.sourceOffset) {
          return next;
        }
        // The receiver event is the acknowledged complete list. The source DO
        // verifies it byte-for-byte before authoring this event, so reduce the
        // recorded keys from that durable receipt instead of relying on the
        // separate invariant that every intervening key change bumps the path.
        const receivingStreamEvent = parseCoreEvent(
          event.payload.receivingStreamEvent,
          "events.iterate.com/stream/cross-post-list-recorded",
        );
        const currentSubscriptionKeys = Object.keys(
          receivingStreamEvent.payload.subscriptionsByKey,
        ).sort();
        const hasCurrentSubscriptions = currentSubscriptionKeys.length > 0;
        const crossPostListDeliveriesByReceivingStream = {
          ...next.crossPostListDeliveriesByReceivingStream,
        };
        if (hasCurrentSubscriptions) {
          crossPostListDeliveriesByReceivingStream[event.payload.receivingStreamPath] = {
            sourceOffset: current.sourceOffset,
            status: "confirmed",
            subscriptionKeysRecordedByReceiver: currentSubscriptionKeys,
          };
        } else {
          delete crossPostListDeliveriesByReceivingStream[event.payload.receivingStreamPath];
        }
        return {
          ...next,
          crossPostListDeliveriesByReceivingStream,
        };
      }
      case "events.iterate.com/stream/cross-post-list-delivery-blocked": {
        const event = parseCoreEvent(
          args.event,
          "events.iterate.com/stream/cross-post-list-delivery-blocked",
        );
        const current =
          next.crossPostListDeliveriesByReceivingStream[event.payload.receivingStreamPath];
        if (current?.sourceOffset !== event.payload.sourceOffset || current.status !== "pending") {
          return next;
        }
        return {
          ...next,
          crossPostListDeliveriesByReceivingStream: {
            ...next.crossPostListDeliveriesByReceivingStream,
            [event.payload.receivingStreamPath]: {
              sourceOffset: event.payload.sourceOffset,
              status: "blocked",
              attempts: event.payload.attempts,
              error: event.payload.error,
              blockedAt: event.createdAt,
              subscriptionKeysRecordedByReceiver: current.subscriptionKeysRecordedByReceiver,
            },
          },
        };
      }
      case "events.iterate.com/stream/cross-posted-events-dropped": {
        const event = parseCoreEvent(
          args.event,
          "events.iterate.com/stream/cross-posted-events-dropped",
        );
        const current = currentInboundSubscription(next, {
          ...event.payload.source,
          subscriptionKey: event.payload.subscriptionKey,
        });
        if (current === undefined) return next;
        const { subscription, source } = current;
        return {
          ...next,
          subscriptions: {
            ...next.subscriptions,
            inbound: {
              ...next.subscriptions.inbound,
              bySourcePath: {
                ...next.subscriptions.inbound.bySourcePath,
                [event.payload.source.path]: {
                  ...source,
                  byKey: {
                    ...source.byKey,
                    [event.payload.subscriptionKey]: {
                      ...subscription,
                      numEventsDropped: subscription.numEventsDropped + event.payload.count,
                    },
                  },
                },
              },
            },
          },
        };
      }
      case "events.iterate.com/stream/subscription-delivery-halted": {
        const event = parseCoreEvent(
          args.event,
          "events.iterate.com/stream/subscription-delivery-halted",
        );
        const existing = next.subscriptions.outbound.byKey[event.payload.subscriptionKey];
        if (existing === undefined) {
          return next;
        }
        return {
          ...next,
          subscriptions: {
            ...next.subscriptions,
            outbound: {
              ...next.subscriptions.outbound,
              byKey: {
                ...next.subscriptions.outbound.byKey,
                [event.payload.subscriptionKey]: {
                  ...existing,
                  deliveryHalted: {
                    reason: event.payload.reason,
                    afterOffset: event.payload.afterOffset,
                    attempts: event.payload.attempts,
                    ...(event.payload.error === undefined ? {} : { error: event.payload.error }),
                  },
                },
              },
            },
          },
        };
      }
      case "events.iterate.com/stream/subscription-delivery-resumed": {
        const event = parseCoreEvent(
          args.event,
          "events.iterate.com/stream/subscription-delivery-resumed",
        );
        const existing = next.subscriptions.outbound.byKey[event.payload.subscriptionKey];
        if (existing === undefined) {
          return next;
        }
        const { deliveryHalted: _cleared, ...resumed } = existing;
        return {
          ...next,
          subscriptions: {
            ...next.subscriptions,
            outbound: {
              ...next.subscriptions.outbound,
              byKey: {
                ...next.subscriptions.outbound.byKey,
                [event.payload.subscriptionKey]: resumed,
              },
            },
          },
        };
      }
      case "events.iterate.com/stream/subscription-cursor-set": {
        const event = parseCoreEvent(
          args.event,
          "events.iterate.com/stream/subscription-cursor-set",
        );
        const existing = next.subscriptions.outbound.byKey[event.payload.subscriptionKey];
        if (existing === undefined) {
          return next;
        }
        return {
          ...next,
          subscriptions: {
            ...next.subscriptions,
            outbound: {
              ...next.subscriptions.outbound,
              byKey: {
                ...next.subscriptions.outbound.byKey,
                [event.payload.subscriptionKey]: {
                  ...existing,
                  cursorSet: {
                    afterOffset: event.payload.afterOffset,
                    setAtSourceOffset: event.offset,
                  },
                },
              },
            },
          },
        };
      }
      case "events.iterate.com/stream/cross-post-list-resend-requested": {
        const event = parseCoreEvent(
          args.event,
          "events.iterate.com/stream/cross-post-list-resend-requested",
        );
        const current =
          next.crossPostListDeliveriesByReceivingStream[event.payload.receivingStreamPath];
        return {
          ...next,
          crossPostListDeliveriesByReceivingStream:
            current === undefined
              ? next.crossPostListDeliveriesByReceivingStream
              : {
                  ...next.crossPostListDeliveriesByReceivingStream,
                  [event.payload.receivingStreamPath]: {
                    sourceOffset: event.offset,
                    status: "pending",
                    subscriptionKeysRecordedByReceiver: current.subscriptionKeysRecordedByReceiver,
                  },
                },
        };
      }
      case "events.iterate.com/stream/child-stream-created": {
        const event = parseCoreEvent(args.event, "events.iterate.com/stream/child-stream-created");
        if (next.path === undefined) {
          return next;
        }
        const childPath = immediateChildPath(next.path, event.payload.childPath);
        if (childPath === null || next.childPaths.includes(childPath)) {
          return next;
        }
        return { ...next, childPaths: [...next.childPaths, childPath] };
      }
      case "events.iterate.com/stream/error-occurred":
        parseCoreEvent(args.event, "events.iterate.com/stream/error-occurred");
        return next;
      default:
        return next;
    }
  }

  #reduceCircuitBreaker(args: {
    event: StreamEvent;
    state: CoreProcessorState;
  }): CoreProcessorState {
    const timestampMs = Date.parse(args.event.createdAt);
    if (!Number.isFinite(timestampMs)) return args.state;
    const elapsedMs =
      args.state.circuitBreaker.lastRefillAtMs === null
        ? 0
        : Math.max(0, timestampMs - args.state.circuitBreaker.lastRefillAtMs);
    const tokens =
      Math.min(
        args.state.circuitBreaker.burstCapacity,
        args.state.circuitBreaker.availableTokens +
          elapsedMs * (args.state.circuitBreaker.refillRatePerMinute / 60_000),
      ) - 1;
    return {
      ...args.state,
      circuitBreaker: {
        ...args.state.circuitBreaker,
        availableTokens: tokens,
        lastRefillAtMs: timestampMs,
        trippedAtOffset:
          tokens < 0 && !args.state.paused && args.state.circuitBreaker.trippedAtOffset === null
            ? args.event.offset
            : args.state.circuitBreaker.trippedAtOffset,
      },
    };
  }
}

function resetCircuitBreaker(
  circuitBreaker: CoreProcessorState["circuitBreaker"],
  createdAt: string,
): CoreProcessorState["circuitBreaker"] {
  const createdAtMs = Date.parse(createdAt);
  return {
    ...circuitBreaker,
    availableTokens: circuitBreaker.burstCapacity,
    lastRefillAtMs: Number.isFinite(createdAtMs) ? createdAtMs : circuitBreaker.lastRefillAtMs,
    trippedAtOffset: null,
  };
}

function immediateChildPath(parentPath: string, announcedPath: string): string | null {
  if (announcedPath === parentPath) return null;
  const parentPrefix = parentPath === "/" ? "/" : `${parentPath}/`;
  if (!announcedPath.startsWith(parentPrefix)) return null;
  const [firstSegment] = announcedPath.slice(parentPrefix.length).split("/").filter(Boolean);
  if (firstSegment === undefined) return null;
  return parentPath === "/" ? `/${firstSegment}` : `${parentPath}/${firstSegment}`;
}
