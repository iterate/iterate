import {
  StreamReceiverUnavailableError,
  type StreamEvent,
  type StreamEventInput,
} from "iterate/processors";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import {
  CoreProcessorContract,
  MAX_SUBSCRIPTIONS_PER_RECEIVING_STREAM,
  parseCommittedCoreEvent as parseCoreEvent,
  subscriptionNameForConfiguredEvent,
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
 * unwriteable checkpoint. Mutations that skip the full scan either add bounded
 * cursor/timestamp/counter fields to entries that already passed this limit,
 * or are copied events updating an EXISTING inbound record's fixed-shape
 * fields; a copied event whose stamp names a new (source path, subscription
 * name) pair creates a fresh entry with strings no limit has seen, so it runs
 * the scan, and {@link MAX_INBOUND_SOURCE_RECORDS} bounds how many such
 * entries can accumulate at all. The remaining 1 MiB is the headroom for the
 * fixed-shape drift.
 */
export const MAX_CORE_PROCESSOR_STATE_BYTES = 1024 * 1024;

/**
 * Hard cap on passive inbound records, counted across every source path. A
 * copied event's stamp may name a never-before-seen (source path,
 * subscription name) pair, so without a cap ever-new sources would grow this
 * single-KV-value checkpoint until it could never be flushed — and a staged
 * rebuild of it would throw during boot — forever. Evicting is SAFE by
 * design: an evicted record merely degrades the fence to first-contact-accept
 * for that source, exactly as if its first copy had not arrived yet.
 */
export const MAX_INBOUND_SOURCE_RECORDS = 1_000;

const textEncoder = new TextEncoder();

function coreProcessorStateByteLength(state: CoreProcessorState): number {
  return textEncoder.encode(JSON.stringify(state)).byteLength;
}

/**
 * These events can retain caller-controlled strings or add collection entries
 * to core state. Ordinary product events and fixed-shape lifecycle facts only
 * advance bounded bookkeeping, so they must not pay an O(state) JSON scan or
 * fail merely because a counter gained a digit. `subscription-removed` is not a
 * growth event: it can only delete an outbound entry. Copied events are gated
 * separately below: only one creating a first-contact inbound record grows
 * retained state.
 */
const CHECKPOINT_GROWTH_EVENT_TYPES = new Set<string>([
  "events.iterate.com/stream/created",
  "events.iterate.com/stream/child-stream-created",
  "events.iterate.com/stream/subscription-configured",
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
  const batchGrowsRetainedState = args.events.some((event) => {
    const hop = event.source?.copiedFrom?.at(-1);
    if (!hop) return CHECKPOINT_GROWTH_EVENT_TYPES.has(event.type);
    // A copied event's only reducer mutation is its passive inbound record.
    // Updating an existing record touches bounded fields; creating one
    // retains the stamp's path and subscription-name strings, which no other
    // limit has measured yet.
    return !args.before.subscriptions.inbound.bySourcePath[hop.path]?.[hop.name];
  });
  if (!batchGrowsRetainedState) {
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

/**
 * Order two source delivery stamps for one (source path, subscription name):
 * creation time orders stream lifetimes, the random stream ID makes a
 * same-millisecond tie deterministic, and the configure/cursor-set offset
 * orders config generations within one lifetime. The receiver's inbound fence
 * rejects a stamp strictly older than its recorded coordinate, so a batch
 * from a destroyed source lifetime or a superseded config generation cannot
 * land after its replacement started delivering.
 */
export function compareSourceStamp(
  incoming: { streamId: string; streamCreatedAt: string; cursorChangedAtSourceOffset: number },
  recorded: { streamId: string; streamCreatedAt: string; cursorChangedAtSourceOffset: number },
): number {
  const creationTimeDifference =
    Date.parse(incoming.streamCreatedAt) - Date.parse(recorded.streamCreatedAt);
  if (creationTimeDifference !== 0) return creationTimeDifference;
  if (incoming.streamId !== recorded.streamId) {
    return incoming.streamId < recorded.streamId ? -1 : 1;
  }
  return incoming.cursorChangedAtSourceOffset - recorded.cursorChangedAtSourceOffset;
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
    if (event.source?.copiedFrom) return event;
    if (!Object.hasOwn(CoreProcessorContract.events, event.type)) return event;
    return CoreProcessorContract.parseEventInput(event as never) as StreamEventInput;
  }

  validate(args: {
    event: StreamEventInput;
    state: CoreProcessorState;
    authority: "public" | "core-event" | "copy";
  }): void {
    if (args.event.ephemeral && args.event.type.startsWith("events.iterate.com/stream/")) {
      throw new Error("stream control events cannot be ephemeral");
    }

    if (args.authority === "public" && isInternalStreamIdempotencyKey(args.event.idempotencyKey)) {
      throw new Error("iterate-internal idempotency keys are platform-authored");
    }

    const isFirstHand = !args.event.source?.copiedFrom;
    if (!isFirstHand && args.authority !== "copy") {
      throw new Error("copy source information is platform-authored");
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
      const requestedName = event.payload.name;
      // Only the platform's omitted-name fallback may mint `subscription:…`
      // names; a caller may still address one that already exists (generated
      // names are first-class, so replacing by the generated name works).
      if (
        requestedName?.startsWith("subscription:") === true &&
        !args.state.subscriptions.outbound.byName[requestedName]
      ) {
        throw new Error(
          `subscription name "${requestedName}" uses the generated-name namespace but does not name an existing subscription`,
        );
      }
      if (event.payload.receiver.action === "webhook-post" && !this.#projectId) {
        throw new Error("webhook subscriptions require a project-scoped stream");
      }
      if (
        event.payload.receiver.action === "copy-to-stream" &&
        event.payload.receiver.receivingStreamPath === args.state.path
      ) {
        throw new Error("a stream cannot receive events from itself");
      }
      compileEventFilter(event.payload.filter);
      // Every push receiver may carry a jsonataTransform; the processor
      // actions (facet-processor / wake-processor) never do (their schema has
      // no such field — wake delivery must feed the processor its committed log
      // verbatim).
      if (
        event.payload.receiver.action !== "facet-processor" &&
        event.payload.receiver.action !== "wake-processor" &&
        event.payload.receiver.jsonataTransform
      ) {
        compileJsonataExpression(event.payload.receiver.jsonataTransform);
      }
      if (event.payload.receiver.action === "copy-to-stream") {
        const receivingStreamPath = event.payload.receiver.receivingStreamPath;
        const existingSubscriptionsForReceiver = Object.entries(
          args.state.subscriptions.outbound.byName,
        ).filter(
          ([name, configured]) =>
            (!event.payload.name || name !== event.payload.name) &&
            configured.configuration.receiver.action === "copy-to-stream" &&
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
      const configured = args.state.subscriptions.outbound.byName[event.payload.name];
      if (!configured) {
        throw new Error(`subscription "${event.payload.name}" does not exist`);
      }
      if (
        configured.configuration.receiver.action === "facet-processor" ||
        configured.configuration.receiver.action === "wake-processor"
      ) {
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
      const configured = args.state.subscriptions.outbound.byName[event.payload.name];
      if (!configured) {
        throw new Error(`subscription "${event.payload.name}" does not exist`);
      }
      if (!configured.deliveryHalted) {
        throw new Error(`subscription "${event.payload.name}" is not halted`);
      }
    }

    if (isFirstHand && args.event.type === "events.iterate.com/stream/subscription-removed") {
      const event = parseCoreEventInput(
        args.event,
        "events.iterate.com/stream/subscription-removed",
      );
      if (args.authority !== "public") {
        throw new Error("requested subscription removals must come from a public command");
      }
      const configured = args.state.subscriptions.outbound.byName[event.payload.name];
      if (!configured) {
        throw new Error(`subscription "${event.payload.name}" does not exist`);
      }
      // A hosted processor's subscription is part of its birth contract. Its
      // configured event is idempotency-keyed, so removing the row would make
      // a later create retry dedupe without restoring the processor. Push
      // subscriptions remain removable through their owning domain doors.
      if (
        configured.configuration.receiver.action === "facet-processor" ||
        configured.configuration.receiver.action === "wake-processor"
      ) {
        throw new Error("hosted processor subscriptions cannot be removed");
      }
    }

    if (!args.state.paused) return;
    switch (args.event.type) {
      case "events.iterate.com/stream/resumed":
      case "events.iterate.com/stream/error-occurred":
      case "events.iterate.com/stream/woken":
      case "events.iterate.com/stream/connection-opened":
      case "events.iterate.com/stream/connection-closed":
      case "events.iterate.com/stream/subscription-removed":
      case "events.iterate.com/stream/subscription-delivery-halted":
        return;
      default:
        throw new StreamReceiverUnavailableError(
          `${STREAM_PAUSED_ERROR_PREFIX}${args.state.pauseReason ?? "unknown reason"}`,
        );
    }
  }

  reduce(args: { event: StreamEvent; state: CoreProcessorState }): CoreProcessorState {
    // Ephemeral events participate in the stream's one offset sequence, but
    // none of their other effects may enter the durable core checkpoint. If
    // they did, rebuilding from the durable log after an incarnation ended
    // would produce different state.
    if (args.event.ephemeral === true) {
      return { ...args.state, maxOffset: args.event.offset };
    }

    const state = this.#reduceState(args);
    return !args.event.source?.copiedFrom &&
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

    // Passive inbound records: every committed copied event carries its
    // delivery stamp on the last `source.copiedFrom` hop, so replaying the
    // log reconstructs the fence coordinates and counters identically.
    const hop = args.event.source?.copiedFrom?.at(-1);
    if (hop) {
      const byKey = next.subscriptions.inbound.bySourcePath[hop.path] ?? {};
      const recorded = byKey[hop.name];
      const sameLifetime =
        !!recorded &&
        recorded.streamId === hop.streamId &&
        recorded.streamCreatedAt === hop.streamCreatedAt;
      // Append-time validation rejects strictly-older stamps, so a replayed
      // log never regresses a record; skip defensively if one somehow would.
      if (!recorded || compareSourceStamp(hop, recorded) >= 0) {
        const bySourcePath = {
          ...next.subscriptions.inbound.bySourcePath,
          [hop.path]: {
            ...byKey,
            [hop.name]: {
              streamId: hop.streamId,
              streamCreatedAt: hop.streamCreatedAt,
              cursorChangedAtSourceOffset: hop.cursorChangedAtSourceOffset,
              numEventsReceived: sameLifetime ? recorded.numEventsReceived + 1 : 1,
              lastEventReceivedAt: args.event.createdAt,
            },
          },
        };
        next = {
          ...next,
          subscriptions: {
            ...next.subscriptions,
            inbound: {
              ...next.subscriptions.inbound,
              // Only a NEW record can push the registry over its cap.
              bySourcePath: recorded ? bySourcePath : evictInboundRecordsOverCap(bySourcePath),
            },
          },
        };
      }
    }

    if (args.event.type.startsWith("events.iterate.com/stream/") && args.event.source?.copiedFrom) {
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
        if (!circuitBreaker) return next;
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
        const name = subscriptionNameForConfiguredEvent(event);
        return {
          ...next,
          subscriptions: {
            ...next.subscriptions,
            outbound: {
              ...next.subscriptions.outbound,
              byName: {
                ...next.subscriptions.outbound.byName,
                [name]: {
                  configuration: { ...event.payload, name },
                  configuredAtOffset: event.offset,
                  configuredAt: event.createdAt,
                },
              },
            },
          },
        };
      }
      case "events.iterate.com/stream/subscription-removed": {
        const event = parseCoreEvent(args.event, "events.iterate.com/stream/subscription-removed");
        const { [event.payload.name]: _removed, ...byName } = next.subscriptions.outbound.byName;
        return {
          ...next,
          subscriptions: {
            ...next.subscriptions,
            outbound: {
              ...next.subscriptions.outbound,
              byName,
            },
          },
        };
      }
      case "events.iterate.com/stream/subscription-delivery-halted": {
        const event = parseCoreEvent(
          args.event,
          "events.iterate.com/stream/subscription-delivery-halted",
        );
        const existing = next.subscriptions.outbound.byName[event.payload.name];
        if (!existing) {
          return next;
        }
        return {
          ...next,
          subscriptions: {
            ...next.subscriptions,
            outbound: {
              ...next.subscriptions.outbound,
              byName: {
                ...next.subscriptions.outbound.byName,
                [event.payload.name]: {
                  ...existing,
                  deliveryHalted: {
                    reason: event.payload.reason,
                    afterOffset: event.payload.afterOffset,
                    attempts: event.payload.attempts,
                    ...(event.payload.error && { error: event.payload.error }),
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
        const existing = next.subscriptions.outbound.byName[event.payload.name];
        if (!existing) {
          return next;
        }
        const { deliveryHalted: _cleared, ...resumed } = existing;
        return {
          ...next,
          subscriptions: {
            ...next.subscriptions,
            outbound: {
              ...next.subscriptions.outbound,
              byName: {
                ...next.subscriptions.outbound.byName,
                [event.payload.name]: resumed,
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
        const existing = next.subscriptions.outbound.byName[event.payload.name];
        if (!existing) {
          return next;
        }
        return {
          ...next,
          subscriptions: {
            ...next.subscriptions,
            outbound: {
              ...next.subscriptions.outbound,
              byName: {
                ...next.subscriptions.outbound.byName,
                [event.payload.name]: {
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
      case "events.iterate.com/stream/child-stream-created": {
        const event = parseCoreEvent(args.event, "events.iterate.com/stream/child-stream-created");
        if (!next.path) {
          return next;
        }
        const childPath = immediateChildPath(next.path, event.payload.childPath);
        if (!childPath || next.childPaths.includes(childPath)) {
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
    const elapsedMs = Number.isFinite(args.state.circuitBreaker.lastRefillAtMs)
      ? Math.max(0, timestampMs - args.state.circuitBreaker.lastRefillAtMs)
      : 0;
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
          tokens < 0 &&
          !args.state.paused &&
          !Number.isFinite(args.state.circuitBreaker.trippedAtOffset)
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

/**
 * Enforce {@link MAX_INBOUND_SOURCE_RECORDS} after a new inbound record lands.
 * Eviction runs inside the fold, so its order must be a pure function of
 * committed-event-derived data for replay/rebuild to produce identical state:
 * oldest `lastEventReceivedAt` first (every value is a committed event's
 * `createdAt`, so plain string order is time order), ties broken by (source
 * path, subscription name) — always via this explicit sort, never object-key
 * enumeration order. Evicting is SAFE by design: the fence merely degrades to
 * first-contact-accept for that source. Deleting a source path's last record
 * deletes the source path entry.
 */
function evictInboundRecordsOverCap(
  bySourcePath: CoreProcessorState["subscriptions"]["inbound"]["bySourcePath"],
): CoreProcessorState["subscriptions"]["inbound"]["bySourcePath"] {
  const records: [sourcePath: string, name: string, lastEventReceivedAt: string][] = [];
  for (const [sourcePath, byKey] of Object.entries(bySourcePath)) {
    for (const [name, record] of Object.entries(byKey)) {
      records.push([sourcePath, name, record.lastEventReceivedAt ?? ""]);
    }
  }
  if (records.length <= MAX_INBOUND_SOURCE_RECORDS) return bySourcePath;
  records.sort(
    ([leftPath, leftKey, leftReceivedAt], [rightPath, rightKey, rightReceivedAt]) =>
      compareStrings(leftReceivedAt, rightReceivedAt) ||
      compareStrings(leftPath, rightPath) ||
      compareStrings(leftKey, rightKey),
  );
  let remaining = bySourcePath;
  for (const [sourcePath, name] of records.slice(0, records.length - MAX_INBOUND_SOURCE_RECORDS)) {
    const { [name]: _evicted, ...keptRecords } = remaining[sourcePath]!;
    if (!Object.keys(keptRecords).length) {
      const { [sourcePath]: _emptied, ...keptSourcePaths } = remaining;
      remaining = keptSourcePaths;
    } else {
      remaining = { ...remaining, [sourcePath]: keptRecords };
    }
  }
  return remaining;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function immediateChildPath(parentPath: string, announcedPath: string): string | null {
  if (announcedPath === parentPath) return null;
  const parentPrefix = parentPath === "/" ? "/" : `${parentPath}/`;
  if (!announcedPath.startsWith(parentPrefix)) return null;
  const [firstSegment] = announcedPath.slice(parentPrefix.length).split("/").filter(Boolean);
  if (!firstSegment) return null;
  return parentPath === "/" ? `/${firstSegment}` : `${parentPath}/${firstSegment}`;
}
