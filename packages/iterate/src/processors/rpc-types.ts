/**
 * The stream + processor RPC surface: stored subscriptions, live connections, the
 * processor state-push contract, and the batch envelope sent to callbacks.
 * These are hand-authored shapes (generics preserved) that both the public itx
 * contract and the server-side processor and connection code build against.
 */
import type { StreamEvent } from "./schemas.ts";

/** Source-local identity for one durable subscription that sends matching stream events. */
export type SubscriptionKey = string;

/** Stable identity for one live connection to a processEventBatch callback. */
export type ConnectionKey = string;

/** The read window accepted by `Stream.getEvents` / `Stream.readEvents`. */
export type StreamEventReadInput = {
  /** Exclusive lower bound. Defaults to 0. */
  afterOffset?: number;
  /** Exclusive upper bound. Omit/null to read through the latest offset. */
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
 * The internal extension used when stream delivery calls a hosted processor.
 * Public processor properties expose only {@link StreamProcessorRpc}; a stored
 * subscription persists an ITX expression that continues one
 * step past that public property to this trusted-only method:
 * `["agents", ["get", path], "processor", "wakeStreamProcessor"]`.
 *
 * `wakeStreamProcessor` is called by trusted stream delivery only
 * (trusted-internal): its processEventBatch callback drives the host's durable
 * checkpoint, so an ordinary session poking it could feed fabricated batches
 * and fast-forward the checkpoint past real events. Multi-processor hosts (an
 * agent Durable Object hosts agent + slack-agent + more) resolve WHICH
 * processor wakes from the request's `processorSlug`. Each public domain
 * surface selects that same named processor for inspection, while deliberately
 * omitting this method from its public TypeScript contract, so
 * `agent.processor`, `agent.slack.processor`, and other siblings expose their
 * own snapshots and checkpoints.
 */
export type WakeableStreamProcessorRpc<State = unknown> = StreamProcessorRpc<State> & {
  wakeStreamProcessor(request: StreamProcessorWakeRequest): Promise<StreamProcessorWakeResponse>;
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
export type { LiveStateRpc, LiveStateSubscriptionHandle } from "../sdk/capnweb/live-state/types.ts";

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
 * fabricated state to every live-state listener.
 */
/**
 * Batch delivered to stream processors and live connections.
 *
 * Kept named because callback retention, processor hosts, and tests all depend
 * on the same cross-RPC batch envelope.
 */
export type StreamEventBatch = {
  projectId: string | null;
  path: string;
  /** Random identity of this event log; changes when the stream is recreated. */
  streamId: string;
  events: StreamEvent[];
  /** Exclusive raw-log cursor from which this delivery scan began. */
  scannedAfterOffset: number;
  /** Inclusive raw-log cursor through which this delivery scan completed. */
  scannedThroughOffset: number;
  streamMaxOffset: number;
  state: unknown;
};

/**
 * One atomic stream read: the matching events plus the identity and raw-log
 * head they were read from. Consumers that persist offsets must use this
 * envelope instead of pairing `getEvents()` with a separate state read — a
 * reset between those calls would make equal offsets name a different log.
 */
export type StreamEventPage = {
  /** Random identity of the event log that served this page. */
  streamId: string;
  /** Highest assigned raw-log offset when this page was read. */
  streamMaxOffset: number;
  events: StreamEvent[];
};

/**
 * Callback invoked by the stream send loop for each delivered batch.
 *
 * It stays as a named type because Workers RPC callback lifecycle helpers need
 * to duplicate, retain, and dispose exactly this callback shape.
 */
export type ProcessEventBatch = (batch: StreamEventBatch) => unknown;

/**
 * Serializable failure reported after a durable wake delivery finishes.
 *
 * The result crosses an independent one-way RPC hop, so preserve the
 * lifecycle flags the stream uses to distinguish a dead Durable Object from
 * an application failure. Error prototypes and arbitrary properties do not
 * survive that hop reliably.
 */
export type StreamWakeDeliveryError = {
  name: string;
  message: string;
  durableObjectReset?: true;
  overloaded?: true;
  retryable?: true;
};

/** The hosted processor's final result for one durable wake delivery. */
export type StreamWakeDeliveryResult =
  | { outcome: "ok" }
  | { outcome: "error"; error: StreamWakeDeliveryError };

/**
 * One-shot acknowledgement capability owned by a single durable wake batch.
 *
 * It is deliberately independent of the callback call's return value. A
 * processor may append back to the stream that delivered the batch; making
 * the stream await that return value can make two Durable Objects wait for
 * each other forever.
 */
export type ReportStreamWakeDeliveryResult = (result: StreamWakeDeliveryResult) => unknown;

/** Internal hosted-processor frame: an ordinary batch plus its one-shot completion callback. */
export type StreamWakeEventBatch = StreamEventBatch & {
  reportDeliveryResult: ReportStreamWakeDeliveryResult;
};

/** Hosted processor callback. Its call result is always disposed without being awaited. */
export type ProcessStreamWakeEventBatch = (batch: StreamWakeEventBatch) => unknown;

/**
 * The committed subscription fields carried with a delivery whose cursor the
 * source stream stores. This deliberately omits metadata, provenance, and
 * idempotency bookkeeping that the core reducer does not retain. A receiver
 * uses the included event coordinates and payload to verify the delivery
 * against the subscription it recorded.
 */
export type SubscriptionConfigurationForDelivery = {
  type: "events.iterate.com/stream/subscription-configured";
  offset: number;
  createdAt: string;
  path: string;
  payload: {
    subscriptionKey?: string;
    description?: string;
    filter?: {
      eventTypes?: string[];
      condition?: string;
    };
    receiver:
      | {
          action: "processor-wake";
          expression: Array<string | [method: string, ...args: unknown[]]>;
          processorSlug?: string;
        }
      | {
          action: "copy-to-stream";
          receivingStreamPath: string;
          delivery: {
            start: "beginning" | "now";
            onFailingEvent: "halt";
          };
        }
      | {
          action: "itx-call";
          expression: Array<string | [method: string, ...args: unknown[]]>;
          delivery: {
            start: "beginning" | "now";
            onFailingEvent: "halt" | "skip";
          };
        }
      | {
          action: "webhook-post";
          url: string;
          transform?: string;
          delivery: {
            start: "beginning" | "now";
            onFailingEvent: "halt" | "skip";
          };
        };
  };
};

/**
 * The batch sent to a durable receiver for a subscription whose cursor the
 * source stream stores: delivery coordinates and events plus the fields an
 * at-least-once receiver needs to deduplicate and self-configure. Deliberately
 * not the state-carrying callback batch
 * {@link StreamEventBatch}: ITX calls and copy destinations do not get
 * folded core state, because other subscriptions' configuration, halt errors,
 * and the presence roster are deployment-internal. Webhooks use a narrower
 * per-event envelope for the same reason. Session callbacks and hosted
 * processors still get state-carrying batches because they paint or reduce
 * from stream state.
 */
export type StreamDeliveryBatch = {
  projectId: string | null;
  path: string;
  /** Random identity assigned when this source stream's storage was created. */
  streamId: string;
  /** Creation time of this source stream; orders recreated streams whose offsets restarted. */
  streamCreatedAt: string;
  events: StreamEvent[];
  streamMaxOffset: number;
  subscriptionKey: SubscriptionKey;
  /**
   * Offset of the configure or cursor-set event that started this delivery run.
   * It stays stable across network retries, but changes after an explicit seek
   * or same-key reconfiguration so those deliberate replays are not deduped as
   * old transport attempts.
   */
  cursorChangedAtSourceOffset: number;
  /**
   * Stable across retries of the same batch and cursor-control event,
   * so receivers can dedupe redeliveries even without per-event bookkeeping.
   * (`${event.path}@${event.offset}` remains the per-event idempotency idiom.)
   */
  deliveryId: string;
  /** 1-based consecutive attempt count for this batch. */
  attempt: number;
  /**
   * The committed `subscription-configured` event this delivery serves — so a
   * receiver can configure itself from committed stream state without a
   * side-channel registry for the source stream, filter, and receiver settings.
   * Narrowed to the fields the fold stores; an honest shape instead of a
   * `StreamEvent` cast that pretends metadata/source survived.
   */
  configuredEvent: SubscriptionConfigurationForDelivery;
};

/** What a receiving stream durably did with one delivered source batch. */
export type CopyReceipt = {
  /**
   * Events the receiver terminally acknowledged: appended now, already
   * present under the same source-coordinate idempotency key, or dropped
   * because their stream-copy path cannot safely continue (cycle/hop limit —
   * audited by an `error-occurred` event on the receiving stream). The sender
   * advances its cursor past every event in an acked batch. The count itself
   * is observability-only wire decoration: the sender never reads it — the
   * awaited call resolving is the whole acknowledgement.
   */
  acknowledged: number;
};

/**
 * A durable receiver's declaration that it cannot accept ANY batch right now —
 * part of the delivery contract, not an implementation detail. The subscription's cursor row
 * treats a rejection carrying this name as "the receiver is down/not ready"
 * and backs off or halts even under `onFailingEvent: "skip"`,
 * because failing-event confirmation is a verdict about ONE event and an unavailable
 * receiver fails every event: confirming skips during an outage window steps
 * over healthy events forever (the bootstrap incarnation: the project-worker
 * feed called its receiver before the config repo seeded, and permanently skipped the
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

/** An operation was bound to a stream lifetime that this path no longer names. */
export class StreamIdMismatchError extends Error {
  static readonly NAME = "StreamIdMismatchError";
  override readonly name = StreamIdMismatchError.NAME;
}

/** Canonical guarded-append rejection text, including across RPC hops that
 * normalize the custom error name to `Error`. */
export function streamIdMismatchMessage(expectedStreamId: string, actualStreamId: unknown): string {
  return `stream ID changed (${expectedStreamId} -> ${String(actualStreamId)}); append rejected`;
}

const STREAM_ID_MISMATCH_MESSAGE = /^stream ID changed \(.+ -> .+\); append rejected$/;

/**
 * Match a guarded append rejected because its source stream was recreated.
 * Durable Object RPC preserves the custom name; CapnWeb can reduce it to a
 * plain Error, so the exact canonical message remains a narrow fallback.
 */
export function isStreamIdMismatchError(error: unknown): boolean {
  const candidate = error as { message?: unknown; name?: unknown } | null;
  return (
    candidate?.name === StreamIdMismatchError.NAME ||
    (candidate?.name === "Error" &&
      typeof candidate.message === "string" &&
      STREAM_ID_MISMATCH_MESSAGE.test(candidate.message))
  );
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
 * resumability) and deliberately WITHOUT the `state` batch callbacks receive — core
 * reduced state is internal and has no business leaving the deployment.
 *
 * Webhook delivery is at-least-once: a remote processor must deduplicate by
 * (streamId, event.offset).
 */
export type StreamWebhookDelivery = {
  /** Never null: webhooks require a project-scoped stream (egress attribution). */
  projectId: string;
  path: string;
  /** Random identity assigned when this source stream's storage was created. */
  streamId: string;
  /** Creation time of this source stream; orders recreated streams whose offsets restarted. */
  streamCreatedAt: string;
  /**
   * The committed event. When the subscription configures a `transform`, its
   * `type`/`payload`/`metadata` are the transform's output while the
   * coordinates (`offset`, `createdAt`, `path`) keep naming the source row.
   */
  event: StreamEvent;
  subscriptionKey: SubscriptionKey;
  /** See {@link StreamDeliveryBatch.cursorChangedAtSourceOffset}. */
  cursorChangedAtSourceOffset: number;
  /** Stable across retries of this event within one delivery run. */
  deliveryId: string;
  /** 1-based consecutive attempt count for this event. */
  attempt: number;
  /** The committed subscription event this delivery serves (see {@link StreamDeliveryBatch}). */
  configuredEvent: SubscriptionConfigurationForDelivery;
};

/**
 * What the stream sends when waking a hosted processor through
 * `wakeStreamProcessor`: serializable coordinates only.
 */
export type StreamProcessorWakeRequest = {
  stream: {
    projectId: string | null;
    path: string;
    /** Random identity of this event log; fences persisted processor checkpoints. */
    streamId: string;
    streamMaxOffset: number;
  };
  subscriptionKey: SubscriptionKey;
  /** Which hosted processor to wake (multi-processor hosts resolve on it). */
  processorSlug?: string;
};

/**
 * What the woken processor hands back in one response. The stream retains
 * `processEventBatch` (ownership of a returned stub transfers to
 * the caller) and streams one-way batches into it from `checkpointOffset + 1`;
 * there is no callback registration call in the other direction.
 */
export type StreamProcessorWakeResponse = {
  /** Stream identity to which `checkpointOffset` and the returned callback are bound. */
  streamId: string;
  /** The processor's durable checkpoint offset — replay resumes after it. */
  checkpointOffset: number;
  /**
   * The live delivery callback the stream retains and invokes per batch.
   * Calls are one-way; each batch reports completion through its independent
   * `reportDeliveryResult` callback.
   */
  processEventBatch: ProcessStreamWakeEventBatch;
  /**
   * Serializable callback-owner identity (validated against
   * `ConnectionOpenerDescriptor` by the stream) appended as the
   * connection-opened presence fact; carries the processor's contract
   * announcement for the stream's `processorsBySlug` registry.
   */
  openedBy?: unknown;
  /** Live runtime-state capability, retained for the connection lifetime. */
  getRuntimeState?: GetProcessorRuntimeState;
  /** Optional ping capability, retained for the connection lifetime (see {@link StreamConnectionPing}). */
  ping?: StreamConnectionPing;
};

/**
 * The mutual ping's request half (NTP-style, for real latency measurement
 * between a stream and its callback owners): the requester stamps `t0` on its own
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
 * Optional ping capability a connection owner hands the stream (session
 * `openConnection()` argument or processor wake-response field).
 */
export type StreamConnectionPing = (
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
 * Live handle returned by `Stream.openConnection`.
 *
 * `ping()` reports liveness: `true` while
 * the connection is still open on the live stream, `false` after it closed
 * (replaced, delivery failure, or explicit close); it rejects when the stream's
 * Durable Object incarnation is gone. Either non-`true` outcome means the
 * owner should open another connection.
 */
export type StreamConnectionHandle = Disposable & {
  /** Stable identity of this live connection. */
  connectionKey: ConnectionKey;
  /** The stream's max offset when the connection opened. */
  streamMaxOffset: number;
  ping(): boolean | Promise<boolean>;
  /** Close this connection; safe to call more than once. */
  close(): void;
};
