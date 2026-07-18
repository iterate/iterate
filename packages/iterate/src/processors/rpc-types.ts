/**
 * The stream + processor RPC surface: the durable subscription handles, the
 * processor state-push contract, and the batch envelope the pump delivers.
 * These are hand-authored shapes (generics preserved) that both the public itx
 * contract and the server-side host/subscriber machinery build against.
 */
import type { LiveUpdate } from "../itx/live-state/protocol.ts";
import type { StreamEvent } from "./schemas.ts";

/** Stable identity for one stream subscription connection. */
export type SubscriptionKey = string;

/** The read window accepted by `Stream.getEvents` / `Stream.readEvents`. */
export type StreamEventReadInput = {
  /** Exclusive lower bound. Defaults to 0. */
  afterOffset?: number;
  /** Exclusive upper bound. Omit/null to read through the current tail. */
  beforeOffset?: number | null;
  /** Event types to include. Omit or include "*" for all; [] matches none. */
  eventTypes?: readonly string[];
  /** Page size, 1-500. Defaults to 500. */
  limit?: number;
  /**
   * Include ephemeral events (default false). Ephemeral rows are second-class:
   * excluded from every range read unless explicitly requested, and the stream
   * may evict them later — never derive durable state from one.
   */
  includeEphemeral?: boolean;
};

/** One consistent read of a processor (what `snapshot()` returns): the folded
 * state pinned to the offset of the last event folded into it. */
export type ProcessorSnapshot<State> = {
  offset: number;
  state: State;
};

/**
 * A processor node that is also its HOST's wake-mode delivery door. This is
 * what the domain surfaces expose (`itx.agents.get(path).processor`,
 * `itx.repos.get(path).processor`, `itx.processor`, …) and what wake-mode
 * stream subscriptions persist as their delivery expression:
 * `["agents", ["get", path], "processor", "wakeStreamSubscriber"]`.
 *
 * `wakeStreamSubscriber` is dialed by stream delivery spines only
 * (trusted-internal): the handshake's sink drives the host's durable
 * checkpoint, so an ordinary session poking it could feed fabricated batches
 * and fast-forward the checkpoint past real events. Multi-processor hosts (an
 * agent Durable Object hosts agent + slack-agent + more) resolve WHICH
 * processor wakes from the request's `processorSlug`. Each public domain
 * surface selects that same named processor for inspection, so
 * `agent.processor`, `agent.slack.processor`, and other siblings expose their
 * own snapshots and checkpoints.
 */
export type WakeableStreamProcessorRpc<State = unknown> = StreamProcessorRpc<State> & {
  wakeStreamSubscriber(request: StreamSubscriberWakeRequest): Promise<StreamSubscriberWakeResponse>;
};

/**
 * The read-side RPC surface every stream processor node exposes: inspect
 * runtime state (snapshot plus a processor-specific runtime bag), take an
 * offset-pinned `snapshot()` of the folded state, and `waitUntilProcessed` to
 * block until the processor has durably folded through a given offset.
 */
export interface StreamProcessorRpc<State = unknown> {
  getRuntimeState(): Promise<ProcessorRuntimeState<State>>;
  snapshot(): Promise<ProcessorSnapshot<State>>;
  waitUntilProcessed(input: { offset: number; timeoutMs?: number }): Promise<void>;
}

/**
 * Live handle for one live-state subscription. `ping()` reports liveness (and
 * the call rejects when the hosting incarnation is gone); `unsubscribe()` closes it.
 */
export type LiveStateSubscriptionHandle = Disposable & {
  ping(): boolean | Promise<boolean>;
  unsubscribe(): void;
};

/**
 * A node's live state — a source-agnostic reactive value. `get()` reads it once;
 * `subscribe()` opens a channel that pushes a full snapshot then minimal diffs
 * (see `lib/live-state`), which the React `useLiveState` hook reassembles so
 * components pick only the slice they render. ANY RpcTarget can expose one: a
 * Durable Object over its folded state, or a stateless worker over state it
 * computes or fetches.
 *
 * Deliberately READ-ONLY over the wire: the server DERIVES this state (a DO
 * reassembles it from its fold), so writes go through the node's own verbs —
 * events appended, mutations called — never a generic `set`. A wire-level
 * `set`/`assign` would let any principal that can reach the node broadcast
 * fabricated state to every subscriber.
 */
export interface LiveStateRpc<State = unknown> {
  get(): Promise<State>;
  subscribe(onUpdate: (update: LiveUpdate<State>) => unknown): Promise<LiveStateSubscriptionHandle>;
}

/**
 * Batch delivered to stream processors and live subscribers.
 *
 * Kept named because callback retention, processor hosts, and tests all depend
 * on the same cross-RPC batch envelope.
 */
export type StreamEventBatch = {
  projectId: string | null;
  path: string;
  events: StreamEvent[];
  /** Exclusive raw-log cursor from which this delivery scan began. */
  scannedAfterOffset: number;
  /** Inclusive raw-log cursor through which this delivery scan completed. */
  scannedThroughOffset: number;
  streamMaxOffset: number;
  state: unknown;
};

/**
 * Callback invoked by the stream pump for each delivered batch.
 *
 * It stays as a named type because Workers RPC callback lifecycle helpers need
 * to duplicate, retain, and dispose exactly this callback shape.
 */
export type ProcessEventBatch = (batch: StreamEventBatch) => unknown;

/**
 * The batch a PUSH subscription's receiver is invoked with: the delivery
 * coordinates and events, plus the fields an at-least-once stateless receiver
 * needs to dedupe and self-configure. Deliberately NOT the live lanes'
 * {@link StreamEventBatch}: push receivers include userspace project workers
 * and sibling streams, and the folded core state — other subscriptions'
 * delivery expressions, park errors, the presence roster — is internal to the
 * deployment (the webhook envelope strips it for the same reason). Live sinks
 * (ephemeral subscribers, wake-mode processors) still get state-carrying
 * batches: they are the lanes that paint from state.
 */
export type StreamPushEventBatch = {
  projectId: string | null;
  path: string;
  events: StreamEvent[];
  streamMaxOffset: number;
  subscriptionKey: SubscriptionKey;
  /**
   * Stable across retries of the same batch (`${subscriptionKey}:${firstOffset}-${lastOffset}`),
   * so receivers can dedupe redeliveries even without per-event bookkeeping.
   * (`${event.path}@${event.offset}` remains the per-event idempotency idiom.)
   */
  deliveryId: string;
  /** 1-based consecutive attempt count for this batch. */
  attempt: number;
  /**
   * The committed trigger fact this delivery serves. This is normally the
   * `subscription-configured` event, so a receiver can self-configure from
   * committed stream state; platform-derived obligations may instead name the
   * existing fact they derive from. Narrowed to the fields the fold stores;
   * an honest shape instead of a `StreamEvent` cast that pretends
   * metadata/source survived.
   */
  configuredEvent: Pick<StreamEvent, "type" | "offset" | "createdAt" | "path" | "payload">;
};

/**
 * A push receiver's declaration that it cannot accept ANY batch right now —
 * part of the delivery contract, not an implementation detail. The spine
 * treats a rejection carrying this name as "the receiver is down/not ready"
 * and routes it to the backoff/park lane even under `onPoison: "skip"`,
 * because poison confirmation is a verdict about ONE event and an unavailable
 * receiver fails every event: skip-confirming during an outage window steps
 * over healthy events forever (the bootstrap incarnation: the project-worker
 * feed dialed before the config repo seeded, and permanently skipped the
 * events that raced the seed).
 *
 * Matched by NAME, not instanceof: the rejection crosses Workers RPC hops
 * (loopback itx roots, DO bindings), which preserve `error.name` but not
 * class identity.
 */
export class StreamReceiverUnavailableError extends Error {
  static readonly NAME = "StreamReceiverUnavailableError";
  override readonly name = StreamReceiverUnavailableError.NAME;
}

/** A compare-and-append assertion lost to another committed stream event. */
export class StreamOffsetConflictError extends Error {
  static readonly NAME = "StreamOffsetConflictError";
  override readonly name = StreamOffsetConflictError.NAME;
}

/** Canonical compare-and-append conflict text, including across RPC hops that
 * normalize the custom error name to `Error`. */
export function streamOffsetConflictMessage(expectedOffset: number, actualOffset: number): string {
  return `expected next offset ${expectedOffset}, found ${actualOffset}`;
}

const STREAM_OFFSET_CONFLICT_MESSAGE = /^expected next offset \d+, found \d+$/;

/**
 * Match by name because Durable Object RPC preserves names, not prototypes.
 * CapnWeb's public itx boundary currently normalizes custom error names to
 * `Error`, so retain an exact message fallback for that hop. Keep this
 * deliberately narrow: callers use the result to retry a compare-and-append.
 */
export function isStreamOffsetConflictError(error: unknown): boolean {
  const candidate = error as { message?: unknown; name?: unknown } | null;
  return (
    candidate?.name === StreamOffsetConflictError.NAME ||
    (candidate?.name === "Error" &&
      typeof candidate.message === "string" &&
      STREAM_OFFSET_CONFLICT_MESSAGE.test(candidate.message))
  );
}

export function isStreamReceiverUnavailableError(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === StreamReceiverUnavailableError.NAME;
}

/**
 * One webhook delivery: a single committed event POSTed as JSON to the
 * subscription's URL. Deliberately per-EVENT (external webhook consumers
 * expect individual events, and per-event acking gives mid-batch
 * resumability) and deliberately WITHOUT the `state` other lanes carry — core
 * reduced state is internal and has no business leaving the deployment.
 */
export type StreamWebhookDelivery = {
  /** Never null: webhooks require a project-scoped stream (egress attribution). */
  projectId: string;
  path: string;
  event: StreamEvent;
  subscriptionKey: SubscriptionKey;
  /** Stable across retries of this event (`${subscriptionKey}:${offset}-${offset}`). */
  deliveryId: string;
  /** 1-based consecutive attempt count for this event. */
  attempt: number;
  /** The committed trigger fact this delivery serves (see {@link StreamPushEventBatch}). */
  configuredEvent: Pick<StreamEvent, "type" | "offset" | "createdAt" | "path" | "payload">;
};

/**
 * What the stream sends when poking a durable wake-mode subscriber
 * (`wakeStreamSubscriber`): serializable coordinates only.
 */
export type StreamSubscriberWakeRequest = {
  stream: {
    projectId: string | null;
    path: string;
    streamMaxOffset: number;
  };
  subscriptionKey: SubscriptionKey;
  /** Which hosted processor the poke is for (multi-processor hosts resolve on it). */
  processorSlug?: string;
};

/**
 * What the poked subscriber hands back — the entire handshake in one return
 * value. The stream retains `sink` (ownership of a returned stub transfers to
 * the caller) and streams one-way batches into it from `checkpointOffset + 1`;
 * there is no subscribe-back call and therefore no handshake race to fence.
 */
export type StreamSubscriberWakeResponse = {
  /** The processor's durable checkpoint offset — replay resumes after it. */
  checkpointOffset: number;
  /** The live delivery callback the stream retains and invokes per batch. */
  sink: ProcessEventBatch;
  /**
   * Serializable subscriber identity (validated against
   * `StreamSubscriberDescriptor` by the stream) appended as the
   * subscriber-connected presence fact; carries the processor's contract
   * announcement for the stream's `processorsBySlug` registry.
   */
  subscriber?: unknown;
  /** Live runtime-state capability, retained for the connection lifetime. */
  getRuntimeState?: GetProcessorRuntimeState;
  /** Optional ping capability, retained for the connection lifetime (see {@link StreamSubscriberPing}). */
  ping?: StreamSubscriberPing;
};

/**
 * The mutual ping's request half (NTP-style, for real latency measurement
 * between a stream and its subscribers): the requester stamps `t0` on its own
 * clock and observes `t3` when the reply lands.
 */
export type StreamPingInput = { t0: number };

/**
 * The mutual ping's reply half: the responder echoes `t0` and reports when it
 * received the request (`t1`) and sent the reply (`t2`) on ITS clock.
 * `rtt = (t3 - t0) - (t2 - t1)` excludes responder processing time, and
 * `((t1 - t0) + (t2 - t3)) / 2` estimates the responder−requester clock
 * offset (see stream-runtime-metrics.pingRoundTrip). Purely observational:
 * ping failures drop the sample and never affect delivery or liveness.
 */
export type StreamPingReply = { t0: number; t1: number; t2: number };

/**
 * Optional ping capability a subscriber hands the stream (ephemeral
 * `subscribe()` argument or wake-handshake field). Absent on older
 * subscribers — the stream then simply has no RTT samples for them.
 */
export type StreamSubscriberPing = (
  input: StreamPingInput,
) => StreamPingReply | Promise<StreamPingReply>;

/** Serializable snapshot plus optional live runtime debug state for a processor. */
export type ProcessorRuntimeState<State = unknown> = {
  snapshot: { offset: number; state: State };
  runtime?: Record<string, unknown>;
};

/**
 * Optional runtime-state callback exposed by a hosted processor.
 *
 * It accepts sync or async implementations because local processors can return
 * immediately, while RPC-backed processors may need an async round trip.
 */
export type GetProcessorRuntimeState = () => ProcessorRuntimeState | Promise<ProcessorRuntimeState>;

/**
 * Live subscription handle returned by `Stream.subscribe`.
 *
 * `ping()` reports liveness: `true` while
 * the connection is still open on the live stream, `false` after it closed
 * (replaced, delivery failure, unsubscribe); it rejects when the stream's
 * Durable Object incarnation is gone. Either non-`true` outcome means the
 * subscriber should re-subscribe.
 */
export type StreamSubscriptionHandle = Disposable & {
  /** Stable identity of this subscription connection. */
  subscriptionKey: SubscriptionKey;
  /** The stream's max offset at subscribe time (durable replay starts behind it). */
  streamMaxOffset: number;
  ping(): boolean | Promise<boolean>;
  /** Close this connection; safe to call more than once. */
  unsubscribe(): void;
};
