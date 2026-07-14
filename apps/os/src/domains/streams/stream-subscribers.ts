// Every subscriber, one module: the stream's delivery machinery.
//
// A SUBSCRIBER gives the stream exactly one thing — a sink — and the lanes
// differ only in how the sink reaches the stream and what happens to the call
// result. Durable addressing is ONE grammar: a persisted itx expression naming
// the method to invoke (wake pokes it for a handshake, push calls it per
// batch); webhook is the same cursor machinery with an HTTP POST per EVENT:
//
// | lane       | sink arrives as                       | call result            |
// |------------|---------------------------------------|------------------------|
// | ephemeral  | `subscribe()` parameter               | disposed unpulled — zero return frames |
// | wake       | returned from the expression-named poke| pulled, never awaited — prompt corpse detection |
// | push       | named by a persisted itx expression   | awaited — the ack that advances the cursor |
// | webhook    | the configured URL (per-event POST)   | awaited 2xx — the ack that advances the cursor |
//
// Ephemeral subscriptions are session-scoped and forgotten on disconnect.
// Durable subscriptions (wake + push) are desired state — the folded
// `subscription-configured` events in core state — and their delivery
// bookkeeping is the SPINE: one SQLite cursor row per subscription
// (subscription-cursor-store.ts) plus the Durable Object alarm for retries.
// Cursor rows are storage; park/resume transitions are facts
// (`subscription-parked` / `-resumed` events). The spine triggers on
// watermark lag — never on event types — so facts stay data, not control flow.
//
// Runtime metrics: every connection carries real counters (events/bytes
// delivered, lag from cursor), the durable lanes record commit→settled
// latency on the stream's own clock (wake: the pulled result settling; push/
// webhook: the awaited ack), and subscribers that hand over a ping capability
// get NTP-style RTT sampled — observer-driven via runtimeState(), throttled,
// and purely observational (a failed ping drops the sample, nothing else).
// Ephemeral consumption is deliberately NOT measured here: those results stay
// unpulled (zero return frames), and the consuming host self-reports through
// its getRuntimeState capability instead (see subscriber-metrics.ts).
//
// This module is transport-free, clock-free, and randomness-free: everything
// it touches arrives through `StreamSubscribersHooks` (storage, log reads, the
// dial, time, backoff jitter, the alarm), so the whole state machine runs in
// plain-node vitest against an in-memory store and a scripted dial
// (stream-subscribers.test.ts). The only streams file that knows RPC exists is
// subscriber-sinks.ts.

import type { ItxExpression } from "../../itx/expression.ts";
import type { StreamEvent, StreamEventInput } from "./schemas.ts";
import type {
  GetProcessorRuntimeState,
  ProcessEventBatch,
  ProcessorRuntimeState,
  StreamEventBatch,
  StreamPushEventBatch,
  StreamSubscriberPing,
  StreamSubscriberWakeRequest,
  StreamWebhookDelivery,
} from "./rpc-types.ts";
import { isStreamReceiverUnavailableError } from "./rpc-types.ts";
import type {
  CoreProcessorState,
  StreamSubscriberDescriptor,
  StreamSubscriberDisconnectReason,
  StreamSubscriptionType,
  SubscriptionConfiguredPayload,
  SubscriptionDelivery,
} from "./core-processor-contract.ts";
import { StreamSubscriberDescriptor as StreamSubscriberDescriptorSchema } from "./core-processor-contract.ts";
import { compileEventSelector, type CompiledEventSelector } from "./event-selector.ts";
import {
  StreamDeliveryFrameReader,
  type DeliveryFrameProjection,
} from "./stream-delivery-frame-reader.ts";
import type {
  SubscriptionCursorRow,
  SubscriptionCursorSet,
  SubscriptionCursorStore,
} from "./subscription-cursor-store.ts";
import type { SelectedStreamFrame, SizedStreamEvent } from "./stream-storage.ts";
import {
  retainGetProcessorRuntimeState,
  retainProcessEventBatch,
  retainSubscriberPing,
  type RetainedProcessEventBatch,
  type RetainedSubscriberPing,
} from "./subscriber-sinks.ts";
import { LatencyRing, pingRoundTrip, type LatencyStats } from "./stream-runtime-metrics.ts";
import {
  computeBackoffMs,
  deliveryId,
  DELIVERY_BATCH_BYTE_LIMIT,
  DELIVERY_BATCH_LIMIT,
  halveBatchLimit,
  initialCursorFor,
  MAX_CONSECUTIVE_SKIPS,
  MAX_DELIVERY_ATTEMPTS,
  PUSH_DELIVERY_BATCH_BYTE_LIMIT,
  PUSH_DELIVERY_BATCH_LIMIT,
  SKIP_CONFIRM_ATTEMPTS,
} from "./subscriber-math.ts";

// A configured processor can consume a sparse subset of the stream. Collapse
// checkpoint-only gaps without turning one pump turn into an unbounded scan:
// each raw page is already capped at 1,000 events and 1 MiB.
const MAX_CONFIGURED_EMPTY_READ_PAGES = 8;

// A byte-capped raw page can contain only a small selected payload. Fold one
// more page into the same push to remove a serial receiver round trip while
// keeping raw parsing bounded to two 4 MiB pages per delivery attempt.
const MAX_SELECTED_PUSH_READ_PAGES = 2;

/** Serializable debug view of one live connection, for `runtimeState()`. */
export type ConnectionRuntimeState = {
  subscriptionType: StreamSubscriptionType;
  startedAt: string;
  cursor: number;
  /** `maxOffset - cursor` — real offset lag for EVERY connection kind, ephemeral included. */
  lag: number;
  batchesSent: number;
  eventsSent: number;
  /** Serialized payload bytes delivered into this connection's sink (cumulative). */
  bytesSent: number;
  lastDeliveredAt?: string;
  /**
   * Commit-to-settled latency, stream clock only: `createdAt` of the newest
   * event in a batch → the pulled batch result settling (the subscriber's
   * ingest resolved). Durable (wake) lane only — ephemeral results are
   * disposed unpulled, so ephemeral consumption is self-reported by the host
   * through `getRuntimeState` instead. Absent until a sample exists.
   */
  settleLatencyMs?: LatencyStats;
  /** Mutual-ping transport RTT to this subscriber (observer-driven sampling). Absent until pinged. */
  pingRttMs?: LatencyStats;
  /**
   * The connect-time identity descriptor. The runtime table is the ONLY home
   * for ephemeral identity — ephemeral connections don't fold into the
   * reduced `connectionsByKey` roster (core state v14) — so debug surfaces
   * read who's connected from here.
   */
  subscriber?: StreamSubscriberDescriptor;
  /**
   * True while the last batch handed to this connection's sink is unsettled —
   * exactly the signal idle teardown consults to classify a sink as wedged.
   */
  hasPendingDelivery: boolean;
};

/** Serializable debug view of one durable subscription's spine row, for `runtimeState()`. */
export type SubscriptionRuntimeState = {
  mode: SubscriptionDelivery["mode"];
  /** Exclusive. Authoritative cursor (push) or observational watermark (wake). */
  ackedOffset: number;
  /** `maxOffset - ackedOffset` — the Kafka lag number, per subscriber. */
  lag: number;
  attempt: number;
  nextAttemptAt: number | null;
  lastError: string | null;
  parkedAtOffset: number | null;
  /** Whether a live delivery connection currently exists (wake mode). */
  connected: boolean;
  /** Serialized payload bytes delivered (push/webhook lanes; cumulative). */
  bytesSent?: number;
  /** Commit-to-acked latency (stream clock): newest event `createdAt` → awaited delivery resolved. */
  settleLatencyMs?: LatencyStats;
  /** Duration of the awaited delivery call itself — the push/webhook lane's transport latency. */
  deliveryDurationMs?: LatencyStats;
};

/**
 * A live delivery connection from the stream to one sink. Not persisted; the
 * sink and pump state live in the `open()` closure, so this is just metrics
 * counters plus two control verbs.
 */
type Connection = {
  readonly subscriptionType: StreamSubscriptionType;
  readonly startedAt: string;
  /** Connect-time identity, surfaced through {@link ConnectionRuntimeState}. */
  readonly subscriber?: StreamSubscriberDescriptor;
  /** Highest offset delivered to the sink; also the pump's resume cursor. */
  readonly cursor: number;
  batchesSent: number;
  eventsSent: number;
  bytesSent: number;
  lastDeliveredAt?: string;
  /** Wake-lane commit→settle samples (see {@link ConnectionRuntimeState.settleLatencyMs}). */
  readonly settleLatency: LatencyRing;
  /** Mutual-ping RTT samples for this connection. */
  readonly pingRtt: LatencyRing;
  /** Retained ping capability; absent for subscribers that supplied none. */
  ping?: RetainedSubscriberPing;
  getProcessorRuntimeState?: GetProcessorRuntimeState & Disposable;
  /** Publish a newer stream head to the resident pump. Idempotent while draining. */
  notify(state: CoreProcessorState): void;
  /** `true` until close() runs — backs the subscription handle's `ping()`. */
  isLive(): boolean;
  /** `true` while a durable sink delivery is dispatched but unsettled. */
  hasPendingDelivery(): boolean;
  /** Stop the pump, dispose the sink, append the disconnect fact, drop from the table. */
  close(reason: StreamSubscriberDisconnectReason): void;
};

/** Everything `open()` needs to start one delivery connection. */
type OpenConnectionArgs = {
  subscriptionKey: string;
  subscriptionType: StreamSubscriptionType;
  /** Already-retained sink (subscriber-sinks.ts owns retention semantics). */
  sink: RetainedProcessEventBatch;
  /** Experimental transport unit for the process-event benchmark. */
  deliveryUnit?: "batch" | "event";
  replayAfterOffset?: number;
  selector?: CompiledEventSelector;
  /** `false` = state-only batches. Default `true`. */
  events?: boolean;
  /** Validated serializable identity, appended as the connected presence fact. */
  presence?: StreamSubscriberDescriptor;
  /** Live processor runtime-state capability, retained for the connection lifetime. */
  getRuntimeState?: GetProcessorRuntimeState;
  /** Subscriber's ping capability, retained for the connection lifetime. */
  ping?: StreamSubscriberPing;
};

/**
 * The transport quarantine's face: how the spine reaches subscribers. Wake and
 * push are BOTH itx-expression evaluations against the stream's authority root
 * (the project itx for project streams, the trusted deployment root for global
 * streams); `poke` additionally retains the sink the wake handshake returns.
 * `webhook` is a plain per-event HTTP POST.
 */
export type SubscriberDial = {
  /** Evaluate the wake expression (`[..., [tail, request]]`) to the handshake response. */
  poke(
    expression: ItxExpression,
    request: StreamSubscriberWakeRequest,
  ): Promise<{
    checkpointOffset: number;
    sink: RetainedProcessEventBatch;
    subscriber?: unknown;
    getRuntimeState?: GetProcessorRuntimeState;
    ping?: StreamSubscriberPing;
  }>;
  /** Evaluate the expression to a sink and invoke it with the batch. Resolve = ack. */
  push(expression: ItxExpression, batch: StreamPushEventBatch): Promise<void>;
  /** POST one event to the webhook URL. Resolve (2xx) = ack; non-2xx rejects. */
  webhook(url: string, delivery: StreamWebhookDelivery): Promise<void>;
};

/** The policy/storage seams the owning Stream Durable Object provides. */
type StreamSubscribersHooks = {
  /**
   * Synchronous committed-event range read from stream storage, sized: each
   * event arrives with its serialized byte length so batch construction can
   * enforce the byte cap without re-stringifying what storage just parsed.
   */
  readEvents(args: {
    afterOffset: number;
    throughOffset: number;
    limit: number;
  }): SizedStreamEvent[];
  /** Optional exact-type push frame that omits nonmatching payload materialization. */
  scanPushEventTypesFrame?(args: {
    afterOffset: number;
    throughOffset: number;
    eventTypes: readonly string[];
    rawLimit: number;
    selectedByteLimit: number;
  }): SelectedStreamFrame;
  /** Current core reduced state, read in the same synchronous block as each delivery. */
  coreState(): CoreProcessorState;
  /** The spine's durable cursor rows (SQLite next to the event log). */
  store: SubscriptionCursorStore;
  /** Transport quarantine (see {@link SubscriberDial}). */
  dial: SubscriberDial;
  /**
   * Append a fact the delivery machinery produces (presence, parked, poison
   * error records). Must not throw: close paths run during teardown where an
   * append can fail, and that must never mask the close itself.
   */
  appendFact(event: StreamEventInput): void;
  /**
   * Delivery-throughput accounting: called once per dispatched delivery with
   * the event count, serialized payload bytes, and exact dispatch timestamp
   * it carried (all lanes).
   */
  recordEgress(count: number, bytes: number, atMs: number): void;
  /** Injected clock (epoch ms). */
  now(): number;
  /** Injected randomness (backoff jitter); [0, 1) like Math.random. */
  random(): number;
  /** Arm the Durable Object alarm for the earliest pending retry. */
  armAlarm(atMs: number): void;
  /** Keep the Durable Object alive through background delivery work. */
  keepAlive(promise: Promise<unknown>): void;
};

type ControlSideEffectOptions = {
  /** The enclosing append batch owns the single post-commit reconciliation. */
  deferReconcile?: boolean;
};

type ConfiguredSubscribers = CoreProcessorState["configuredSubscribersByKey"];
type PushDrainStart = {
  state: CoreProcessorState;
  entry: ConfiguredSubscribers[string];
  row: SubscriptionCursorRow;
};

function sharedPushEventTypes(
  entries: readonly [string, ConfiguredSubscribers[string]][],
): readonly string[] | undefined {
  let shared: readonly string[] | undefined;
  for (const [, entry] of entries) {
    const config = entry.latestConfiguredEvent.payload;
    if (config.delivery.mode !== "push") continue;
    const configuredTypes = config.selector?.eventTypes;
    if (
      configuredTypes === undefined ||
      configuredTypes.length === 0 ||
      configuredTypes.includes("*") ||
      config.selector?.condition !== undefined
    ) {
      return undefined;
    }
    const normalized = [...new Set(configuredTypes)].sort();
    if (shared === undefined) {
      shared = normalized;
      continue;
    }
    if (
      shared.length !== normalized.length ||
      shared.some((eventType, index) => eventType !== normalized[index])
    ) {
      return undefined;
    }
  }
  return shared;
}

type SelectorConditionFailure = { event: StreamEvent; error: string };
type SelectorProjection = {
  matched: StreamEvent[];
  matchedByteLength: number;
  conditionFailures: SelectorConditionFailure[];
};
export class StreamSubscribers {
  readonly #hooks: StreamSubscribersHooks;
  readonly #deliveryFrameReader: StreamDeliveryFrameReader;
  /**
   * How long the stream may hold idle durable delivery connections before
   * severing them so it (and its subscribers) can hibernate instead of
   * accruing billable duration on cross-isolate RPC sessions that pin both
   * DOs. Tracked with an in-memory timer (NOT a DO alarm): the retained sinks
   * we tear down are in-memory and die on eviction anyway, the DO is always
   * resident while it holds them (so the timer is guaranteed to fire), and a
   * durable alarm's only extra power — waking a hibernated DO — is exactly
   * what we must never do FOR THIS. (The spine's retry alarm is the opposite
   * case: its state is durable rows, so waking the DO is exactly the point.)
   */
  readonly #idleTeardownMs: number;
  readonly #connections = new Map<string, Connection>();
  #configuredConnectionCount = 0;
  #idleTimer: ReturnType<typeof setTimeout> | undefined;
  #idleDeadlineMs: number | undefined;

  // Durable-lane in-memory state. All of it is reconstructible: a DO eviction
  // resets these and the durable rows + folded config re-derive every decision
  // (at-least-once absorbs the repeats).
  readonly #pokesInFlight = new Set<string>();
  /**
   * True while runIdleTeardownNow severs connections. The disconnect facts it
   * appends bump maxOffset, and append's post-commit wake() would otherwise
   * see the new lag and re-poke — defeating the teardown (thermo review r1,
   * blocker 1, with an empirical repro). Reconcile is suppressed for the
   * teardown turn; the final watermark ack below covers the facts.
   */
  #tearingDown = false;
  #wakeGeneration = 0;
  #wakeStateGeneration = -1;
  #wakeState: CoreProcessorState | undefined;
  readonly #readWakeState = () => {
    // All pumps entered by one synchronous wake observe the same immutable
    // reduced-state object. A sink can synchronously trigger another wake in
    // tests/local transports; generation refresh preserves that newer head.
    if (this.#wakeStateGeneration !== this.#wakeGeneration) {
      this.#wakeState = this.#hooks.coreState();
      this.#wakeStateGeneration = this.#wakeGeneration;
    }
    return this.#wakeState!;
  };
  readonly #pushDrains = new Set<string>();
  /** Bisect state for onPoison:"skip" — current batch ceiling per key. */
  readonly #batchLimits = new Map<string, number>();
  /**
   * Row-count estimate for the current storage-read byte cap. The first backlog read
   * stays allocation-cheap at the full count limit; if its byte scan proves
   * that was an over-read, later reads fetch only the rows that fit plus one.
   * The estimate expands geometrically when smaller rows make it conservative.
   */
  /** Consecutive poison skips per key (no intervening success) — see MAX_CONSECUTIVE_SKIPS. */
  readonly #consecutiveSkips = new Map<string, number>();
  /**
   * Per-subscription delivery metrics for the stream-owned-cursor lanes
   * (push/webhook): the awaited call IS the ack, so the stream is the only
   * observer of these subscribers' consumption. In-memory like every other
   * runtime metric; cleaned up with the subscription.
   */
  readonly #subscriptionMetrics = new Map<
    string,
    { settleLatency: LatencyRing; deliveryDuration: LatencyRing; bytesSent: number }
  >();
  /** Last mutual-ping round start — throttles observer-driven sampling. Null until the first round. */
  #lastPingRoundAtMs: number | null = null;
  /** Cloudflare may freeze the clock between I/O turns; reuse that exact timestamp's ISO form. */
  #lastFormattedAtMs: number | undefined;
  #lastFormattedAt: string | undefined;
  /** Aligned durable lanes settle against the same newest event; parse its exact timestamp once. */
  #lastParsedCreatedAt: string | undefined;
  #lastParsedCreatedAtMs: number | undefined;
  /** Compiled selectors for durable push/webhook configs, keyed by the config event offset. */
  readonly #compiledSelectors = new Map<
    string,
    { configOffset: number; selector: CompiledEventSelector }
  >();
  readonly #selectorProjections = new WeakMap<
    DeliveryFrameProjection,
    Map<CompiledEventSelector, { all?: SelectorProjection; durable?: SelectorProjection }>
  >();

  constructor(args: { idleTeardownMs: number; hooks: StreamSubscribersHooks }) {
    this.#hooks = args.hooks;
    this.#deliveryFrameReader = new StreamDeliveryFrameReader(args.hooks);
    this.#idleTeardownMs = args.idleTeardownMs;
  }

  #formatTimestamp(atMs: number): string {
    if (atMs !== this.#lastFormattedAtMs) {
      this.#lastFormattedAtMs = atMs;
      this.#lastFormattedAt = new Date(atMs).toISOString();
    }
    return this.#lastFormattedAt!;
  }

  #parseCreatedAt(createdAt: string): number {
    if (createdAt !== this.#lastParsedCreatedAt) {
      this.#lastParsedCreatedAt = createdAt;
      this.#lastParsedCreatedAtMs = Date.parse(createdAt);
    }
    return this.#lastParsedCreatedAtMs!;
  }

  // ===========================================================================
  // The one wake-up: called post-commit and from the DO alarm.
  // ===========================================================================

  /**
   * The just-committed events of recent contiguous appends, handed over by the
   * commit path so caught-up pumps and drains consume them directly instead
   * of re-reading (and re-parsing) them from SQLite once per delivery lane.
   * Correctness is offset-gated, never freshness-gated: the frame reader uses the
   * tail only when it contains exactly `afterOffset + 1`, so a stale tail
   * (more appends since, a rewound cursor) either still IS the right contiguous
   * window or self-disqualifies and falls back to storage. A byte/row-capped
   * delivery can resume at a later position in the same tail without SQL.
   */
  #configuredSubscribers: ConfiguredSubscribers | undefined;
  #configuredSubscriberEntries: [string, ConfiguredSubscribers[string]][] = [];
  /** Exact type set shared by every push config; undefined disables SQL prefiltering. */
  #sharedPushEventTypes: readonly string[] | undefined;
  /** Config side-effect fence for deliveries that await across a replacement. */
  readonly #latestConfiguredOffsets = new Map<string, number>();

  /**
   * Re-arm every live connection's pump and reconcile durable subscriptions
   * (poke lagging wake subscribers without a connection, drain lagging push
   * subscriptions that are due). Never throws; never blocks the append.
   *
   * `freshTail` is the live-tail fast path: append passes what it just
   * committed (already sized by the log write) so tailing consumers skip the
   * storage round trip.
   */
  wake(freshTail?: SizedStreamEvent[], freshTailByteLength?: number): void {
    this.#wakeGeneration += 1;
    // Connection pumps advance their cursor before yielding. Only awaited
    // drains and wake handshakes can be overtaken by later append turns.
    this.#deliveryFrameReader.onWake({
      freshTail,
      freshTailByteLength,
      retainContiguousTail: this.#pushDrains.size > 0 || this.#pokesInFlight.size > 0,
    });
    if (this.#connections.size > 0) {
      const state = this.#readWakeState();
      for (const connection of this.#connections.values()) connection.notify(state);
    }
    if (this.#tearingDown) return;
    try {
      // Config side effects close stale wake connections before this final
      // post-commit wake and invalidate the identity-keyed entry snapshot.
      // Therefore a current snapshot with equal counts proves every configured
      // key already owns a live wake connection; there can be no push/webhook
      // key left to reconcile. Avoid even reading core state in that common
      // case while preserving the full mixed-mode path.
      if (
        this.#configuredSubscribers === undefined ||
        this.#configuredConnectionCount !== this.#configuredSubscriberEntries.length
      ) {
        const state = this.#readWakeState();
        const configuredEntries = this.#entriesFor(state.configuredSubscribersByKey);
        if (this.#configuredConnectionCount !== configuredEntries.length) {
          this.#reconcileDurable(state, configuredEntries);
        }
      }
      // Pure selector/ephemeral skips run synchronously until their first
      // delivery await (usually all the way to the head). Give the cursor
      // store one chance to checkpoint every lane's accumulated progress as
      // a multi-row write after reconciliation, instead of one UPDATE each.
      this.#hooks.store.flushPending();
    } catch (error) {
      console.error("stream durable subscription reconcile failed", error);
    }
  }

  /** Reuse the already-retained append tail when it proves a complete public read. */
  tryReadFreshEvents(args: {
    afterOffset: number;
    throughOffset: number;
    eventTypes?: readonly string[];
    includeEphemeral: boolean;
    limit: number;
  }): StreamEvent[] | undefined {
    return this.#deliveryFrameReader.tryReadFreshEvents(args);
  }

  /** The DO alarm handler body: retry whatever is due, then re-arm. */
  onAlarm(): void {
    this.wake();
    this.#armAlarmFromStore();
  }

  // ===========================================================================
  // Lane 1: ephemeral subscriptions (the `subscribe()` verb).
  // ===========================================================================

  openEphemeral(args: {
    subscriptionKey: string;
    sink: ProcessEventBatch;
    replayAfterOffset?: number;
    selector?: CompiledEventSelector;
    events?: boolean;
    presence?: StreamSubscriberDescriptor;
    getRuntimeState?: GetProcessorRuntimeState;
    ping?: StreamSubscriberPing;
  }): Connection {
    return this.#open({
      subscriptionKey: args.subscriptionKey,
      subscriptionType: "ephemeral",
      // No onDeliveryError: the batch result is disposed unpulled, so an
      // ephemeral subscription generates ZERO subscriber-originated return
      // frames (see subscriber-sinks.ts and the wire tests). Liveness is the
      // subscriber's problem: explicit unsubscribe or best-effort onRpcBroken.
      sink: retainProcessEventBatch(args.sink),
      replayAfterOffset: args.replayAfterOffset,
      selector: args.selector,
      events: args.events,
      presence: args.presence,
      getRuntimeState: args.getRuntimeState,
      ping: args.ping,
    });
  }

  // ===========================================================================
  // The durable spine: wake pokes, push drains, retries, parking.
  // ===========================================================================

  /**
   * Makes reality match the folded config. For each durable subscription:
   * ensure its cursor row exists (rows are storage, not log-derived — after a
   * state rebuild the config events re-create them here), skip parked ones,
   * skip ones backing off (the alarm owns those), then poke or drain.
   */
  #reconcileDurable(
    state: CoreProcessorState,
    configuredEntries: [string, ConfiguredSubscribers[string]][],
  ): void {
    let now: number | undefined;

    for (const [subscriptionKey, entry] of configuredEntries) {
      const config = entry.latestConfiguredEvent.payload;
      const configOffset = entry.latestConfiguredEvent.offset;

      // These reservations can only be created after this incarnation ensured
      // the row. Their work already owns delivery, so another cursor clone and
      // policy calculation on every append cannot affect reconciliation.
      if (config.delivery.mode === "wake") {
        if (this.#connections.has(subscriptionKey) || this.#pokesInFlight.has(subscriptionKey)) {
          continue;
        }
      } else if (this.#pushDrains.has(subscriptionKey)) {
        continue;
      }

      // The per-mode initial-cursor policy lives in ONE place
      // (subscriber-math.initialCursorFor) so this and the config side effect
      // below can never drift.
      const row = this.#hooks.store.ensure(subscriptionKey, initialCursorFor(config, configOffset));

      if (entry.parkedAtOffset !== undefined) continue;

      if (row.nextAttemptAt !== null && row.nextAttemptAt > (now ??= this.#hooks.now())) continue;
      // "Caught up" trusts the monotonic watermark. A subscriber that
      // discarded its checkpoint (schema-change refold) and lost its
      // connection mid-replay parks here at a partial refold until the next
      // append or dial moves the head — self-healing, but slow on a quiet
      // stream; the subscriber's own keepalive covers the DO-death variant.
      if (row.ackedOffset >= state.maxOffset) continue; // caught up; nothing to say

      if (config.delivery.mode === "wake") {
        this.#poke(subscriptionKey, config.delivery, configOffset, row.epoch);
        continue;
      }

      this.#drainPush(subscriptionKey, { state, entry, row });
    }
  }

  #entriesFor(configuredSubscribers: ConfiguredSubscribers) {
    if (configuredSubscribers !== this.#configuredSubscribers) {
      this.#configuredSubscribers = configuredSubscribers;
      this.#configuredSubscriberEntries = Object.entries(configuredSubscribers);
      this.#sharedPushEventTypes = sharedPushEventTypes(this.#configuredSubscriberEntries);
    }
    return this.#configuredSubscriberEntries;
  }

  /**
   * One poke: ask the wake target to hand back its checkpoint and a live sink,
   * then open the delivery connection from that checkpoint. The entire
   * handshake is this single call — the stream initiated it and owns the
   * returned sink, so there is no subscribe-back race. The ONE fence left is
   * against config replacement: a poke that resolves after its subscription
   * was replaced (or switched to push mode) must drop its sink rather than
   * open a zombie connection or ack a now-authoritative push cursor.
   */
  #poke(
    subscriptionKey: string,
    delivery: Extract<SubscriptionDelivery, { mode: "wake" }>,
    configOffset: number,
    epoch: number,
  ): void {
    const state = this.#hooks.coreState();
    if (state.projectId === undefined || state.path === undefined) return;
    const request: StreamSubscriberWakeRequest = {
      stream: { projectId: state.projectId, path: state.path, streamMaxOffset: state.maxOffset },
      subscriptionKey,
      ...(delivery.processorSlug === undefined ? {} : { processorSlug: delivery.processorSlug }),
    };

    this.#pokesInFlight.add(subscriptionKey);
    const work = (async () => {
      try {
        // A poke that outlives its timeout still eventually settles with a
        // RETAINED sink; dropping that undisposed would leak a session-pinning
        // stub on exactly the wedged-subscriber occasions the timeout exists
        // for. The late-settle hook disposes it (thermo round 2, blocker 4b).
        const pokePromise = this.#hooks.dial.poke(delivery.expression, request);
        const response = await withDeliveryTimeout(pokePromise, `poke ${subscriptionKey}`, {
          onLateResolve: (late) => late.sink[Symbol.dispose](),
        });
        const current = this.#hooks.coreState().configuredSubscribersByKey[subscriptionKey];
        if (
          current === undefined ||
          current.latestConfiguredEvent.offset !== configOffset ||
          current.latestConfiguredEvent.payload.delivery.mode !== "wake" ||
          this.#hooks.store.get(subscriptionKey)?.epoch !== epoch
        ) {
          response.sink[Symbol.dispose]();
          // The fence dropped a stale poke, but the CURRENT config (if any) is
          // still owed delivery and nothing else re-reconciles until the next
          // append — a liveness gap on quiet streams (round 2). Re-reconcile
          // once this poke's in-flight reservation clears below.
          queueMicrotask(() => this.wake());
          return;
        }
        let presence: StreamSubscriberDescriptor | undefined;
        try {
          presence =
            response.subscriber === undefined
              ? undefined
              : StreamSubscriberDescriptorSchema.parse(response.subscriber);
        } catch (error) {
          // Reject the malformed descriptor WITHOUT leaking the sink retained
          // moments earlier (round-1 finding 4.2 / round-2 blocker 4a).
          response.sink[Symbol.dispose]();
          throw error;
        }
        // The announcement's consumes list is the wake-mode selector: the
        // stream only delivers event types the processor consumes, exactly as
        // the old subscribe-back handshake did.
        const consumes = presence?.processor?.announcement.consumes;
        this.#open({
          subscriptionKey,
          subscriptionType: "configured",
          sink: response.sink,
          deliveryUnit:
            current.latestConfiguredEvent.payload.params?.deliveryUnit === "event"
              ? "event"
              : "batch",
          replayAfterOffset: response.checkpointOffset,
          selector:
            consumes === undefined
              ? undefined
              : compileEventSelector({ eventTypes: [...consumes] }),
          presence,
          getRuntimeState: response.getRuntimeState,
          ping: response.ping,
        });
        // Observational watermark: the subscriber confirmed this checkpoint.
        // While the connection streams, the watermark deliberately goes stale;
        // its only job is deciding whether to poke when no connection exists.
        // A successful HANDSHAKE proves the host is reachable, not that
        // deliveries succeed — so it must not clear the delivery-failure
        // streak by itself (that reset let a deterministically failing
        // subscriber re-poke forever without ever parking). PROGRESS clears
        // it: a checkpoint past the last watermark means deliveries have been
        // digested since the failure.
        const watermarkRow = this.#hooks.store.get(subscriptionKey);
        if (watermarkRow === undefined || response.checkpointOffset > watermarkRow.ackedOffset) {
          this.#hooks.store.ack(subscriptionKey, response.checkpointOffset, epoch);
        } else {
          this.#hooks.store.advanceWatermark(subscriptionKey, response.checkpointOffset, epoch);
        }
      } catch (error) {
        if (!this.#onDeliveryFailure({ subscriptionKey, configOffset, epoch, error })) {
          queueMicrotask(() => this.wake());
        }
      } finally {
        this.#pokesInFlight.delete(subscriptionKey);
      }
    })();
    this.#hooks.keepAlive(work);
  }

  /**
   * Drain one stream-owned-cursor subscription (push or webhook) to the tail:
   * read after the cursor, filter through the selector (skip-not-defer — the
   * cursor advances past non-matching events), deliver, and advance the
   * cursor on the awaited resolve. The awaited call IS the ack — these are
   * the lanes with acknowledgement semantics, which is exactly why the stream
   * can own their cursors. Push delivers per batch; webhook per event.
   */
  #drainPush(subscriptionKey: string, start: PushDrainStart): void {
    this.#pushDrains.add(subscriptionKey);
    const work = (async () => {
      // Reconciliation invokes this async body synchronously through its first
      // await, so its validated snapshot is exact for iteration one only.
      let initial: PushDrainStart | undefined = start;
      try {
        for (;;) {
          const snapshot = initial;
          initial = undefined;
          const state = snapshot?.state ?? this.#hooks.coreState();
          const entry = snapshot?.entry ?? state.configuredSubscribersByKey[subscriptionKey];
          if (entry === undefined || entry.parkedAtOffset !== undefined) return;
          const config = entry.latestConfiguredEvent.payload;
          if (config.delivery.mode === "wake") return;
          const row = snapshot?.row ?? this.#hooks.store.get(subscriptionKey);
          if (row === undefined) return;
          if (row.nextAttemptAt !== null && row.nextAttemptAt > this.#hooks.now()) return;
          // The core state is reduced synchronously with every commit, so its
          // head is authoritative for this incarnation. Do not issue a final
          // empty range query after the previous iteration acked the head.
          if (row.ackedOffset >= state.maxOffset) return;
          const hasPendingPushFrame =
            config.delivery.mode === "push" &&
            row.pendingThroughOffset !== null &&
            row.pendingStreamMaxOffset !== null &&
            row.pendingAttempt !== null &&
            row.pendingThroughOffset > row.ackedOffset;
          const frameThroughOffset = hasPendingPushFrame
            ? row.pendingThroughOffset!
            : state.maxOffset;
          // Every append/control reconciliation calls wake(). If this value is
          // unchanged after selection or delivery, the observed head is still
          // current and a final state/cursor probe cannot discover more work.
          const wakeGeneration = this.#wakeGeneration;

          // Webhook mode IS the push drain pinned to batch size 1: external
          // receivers get single-event POSTs, each ack covers exactly one
          // offset (mid-batch resume for free), the poison machinery always
          // sees the true delivery unit (bisecting is structurally moot), and
          // the per-iteration staleness checks above run per EVENT — a
          // removed/replaced webhook can never keep POSTing a stale batch to
          // the old URL. The cost is one row/config re-read per event on a
          // backlog, noise against the HTTP POST itself.
          const maxLimit = config.delivery.mode === "push" ? PUSH_DELIVERY_BATCH_LIMIT : 1;
          const limit = Math.min(this.#batchLimits.get(subscriptionKey) ?? maxLimit, maxLimit);
          const selector =
            config.selector === undefined
              ? undefined
              : this.#selectorFor(subscriptionKey, entry.latestConfiguredEvent.offset, config);
          const selectedEventTypes =
            config.delivery.mode === "push" ? this.#sharedPushEventTypes : undefined;
          const read = this.#deliveryFrameReader.read({
            afterOffset: row.ackedOffset,
            limit,
            throughOffset: frameThroughOffset,
            durableOnly: true,
            includeEventByteLengths: selector !== undefined && !selector.matchesAll,
            byteLimit:
              config.delivery.mode === "push"
                ? PUSH_DELIVERY_BATCH_BYTE_LIMIT
                : DELIVERY_BATCH_BYTE_LIMIT,
            selectedEventTypes,
          });
          let durable = read.events;
          let lastOffset = read.lastOffset;
          if (lastOffset === undefined) return; // caught up
          let scannedEventCount = read.scannedEventCount;
          let durableByteLength = read.byteLength;

          // Ephemeral events never reach durable receivers — platform law,
          // enforced as the same skip-not-defer shape selectors use: the raw
          // read advances the cursor over their offsets, delivery drops them.
          let matched = durable;
          let matchedByteLength: number | undefined;
          const conditionErrors: StreamEventInput[] = [];
          if (selector !== undefined) {
            const selected = this.#applySelector(
              subscriptionKey,
              selector,
              durable,
              read.eventByteLengths,
              read.projection,
              read.durableOnly,
            );
            matched = selected.matched;
            matchedByteLength = selected.matchedByteLength;
            conditionErrors.push(...selected.conditionErrors);
          }

          if (
            config.delivery.mode === "push" &&
            selector !== undefined &&
            !selector.matchesAll &&
            matched.length > 0 &&
            matchedByteLength !== undefined &&
            matchedByteLength < PUSH_DELIVERY_BATCH_BYTE_LIMIT &&
            !this.#batchLimits.has(subscriptionKey) &&
            !(read.stoppedByByteLimit && read.projection?.selectedEventTypesKey !== undefined) &&
            scannedEventCount < limit &&
            lastOffset < frameThroughOffset
          ) {
            for (let page = 1; page < MAX_SELECTED_PUSH_READ_PAGES; page += 1) {
              const nextRead = this.#deliveryFrameReader.read({
                afterOffset: lastOffset,
                limit: limit - scannedEventCount,
                throughOffset: frameThroughOffset,
                durableOnly: true,
                includeEventByteLengths: true,
                byteLimit: PUSH_DELIVERY_BATCH_BYTE_LIMIT,
                selectedEventTypes,
              });
              const nextLastOffset = nextRead.lastOffset;
              if (nextLastOffset === undefined) break;
              const selected = this.#applySelector(
                subscriptionKey,
                selector,
                nextRead.events,
                nextRead.eventByteLengths,
                nextRead.projection,
                nextRead.durableOnly,
              );
              const nextMatchedByteLength = selected.matchedByteLength ?? 0;
              if (
                selected.matched.length > 0 &&
                matchedByteLength + nextMatchedByteLength > PUSH_DELIVERY_BATCH_BYTE_LIMIT
              ) {
                break;
              }
              durable = durable.concat(nextRead.events);
              matched = matched.concat(selected.matched);
              matchedByteLength += nextMatchedByteLength;
              scannedEventCount += nextRead.scannedEventCount;
              durableByteLength += nextRead.byteLength;
              lastOffset = nextLastOffset;
              conditionErrors.push(...selected.conditionErrors);
              if (
                scannedEventCount >= limit ||
                lastOffset >= frameThroughOffset ||
                matchedByteLength >= PUSH_DELIVERY_BATCH_BYTE_LIMIT ||
                (nextRead.stoppedByByteLimit &&
                  nextRead.projection?.selectedEventTypesKey !== undefined)
              ) {
                break;
              }
            }
          }

          // Fact appends can synchronously commit and re-enter wake(). Defer
          // them until every page is selected so they cannot enter this frame.
          for (const fact of conditionErrors) this.#hooks.appendFact(fact);

          if (matched.length === 0) {
            // Skip-not-defer: nothing here for this subscriber, but the cursor
            // must advance or the subscription re-reads these events forever.
            // No receiver side effect occurred, so persistence can be batched
            // and boundedly lagged; the in-memory cursor advances immediately.
            this.#hooks.store.skip(subscriptionKey, lastOffset, row.epoch);
            if (lastOffset >= state.maxOffset && wakeGeneration === this.#wakeGeneration) {
              return;
            }
            continue;
          }

          if (state.projectId === undefined || state.path === undefined) return;
          const configuredEvent = {
            type: entry.latestConfiguredEvent.type,
            offset: entry.latestConfiguredEvent.offset,
            createdAt: entry.latestConfiguredEvent.createdAt,
            path: state.path,
            payload: entry.latestConfiguredEvent.payload,
          };

          const dispatchAtMs = this.#hooks.now();
          let pushStreamMaxOffset = state.maxOffset;
          let pushAttempt = row.attempt + 1;
          if (config.delivery.mode === "push") {
            // Both synchronous DO SQLite and setAlarm writes open the output
            // gate. The outbound RPC below cannot leave until the exact frame,
            // monotonic attempt, and crash-recovery wakeup are durable.
            const claim = this.#hooks.store.claimPushFrame(
              subscriptionKey,
              lastOffset,
              state.maxOffset,
              dispatchAtMs + DELIVERY_TIMEOUT_MS,
              row.epoch,
            );
            if (claim === undefined) continue;
            pushStreamMaxOffset = claim.streamMaxOffset;
            pushAttempt = claim.attempt;
            this.#hooks.armAlarm(dispatchAtMs + DELIVERY_TIMEOUT_MS);
          }

          const deliveredBytes =
            matched.length === durable.length
              ? durableByteLength
              : (matchedByteLength ?? missingFilteredByteLength());
          // Dispatch-time accounting: retries re-send real bytes, so failed
          // attempts count too (the wire carried them either way).
          this.#hooks.recordEgress(matched.length, deliveredBytes, dispatchAtMs);
          try {
            if (config.delivery.mode === "webhook") {
              if (state.projectId === null) return; // unreachable: rejected at append (egress attribution)
              await withDeliveryTimeout(
                this.#hooks.dial.webhook(config.delivery.url, {
                  projectId: state.projectId,
                  path: state.path,
                  // Exactly one: the batch-limit-1 read above IS webhook mode.
                  event: matched[0]!,
                  subscriptionKey,
                  deliveryId: deliveryId(subscriptionKey, matched[0]!.offset, lastOffset),
                  attempt: row.attempt + 1,
                  configuredEvent,
                }),
                `webhook ${subscriptionKey}`,
              );
            } else {
              const pushExpression = config.delivery.expression;
              const pushProjectId = state.projectId;
              const pushPath = state.path;
              const push = async (events: StreamEvent[], frameDeliveryId: string) =>
                await withDeliveryTimeout(
                  this.#hooks.dial.push(pushExpression, {
                    projectId: pushProjectId,
                    path: pushPath,
                    events,
                    streamMaxOffset: pushStreamMaxOffset,
                    subscriptionKey,
                    deliveryId: frameDeliveryId,
                    attempt: pushAttempt,
                    configuredEvent,
                  }),
                  `push ${subscriptionKey}`,
                );
              if (config.params?.deliveryUnit === "event") {
                // A generic push receiver has no ordered, failure-sticky
                // queue. Preserve its in-order, at-least-once contract by
                // awaiting each event before dispatching the next one.
                for (const event of matched) {
                  await push([event], deliveryId(subscriptionKey, event.offset, event.offset));
                }
              } else {
                await push(matched, deliveryId(subscriptionKey, matched[0]!.offset, lastOffset));
              }
            }
          } catch (error) {
            // "continue" = the failure handler already moved the goalposts
            // (halved the bisect window or stepped over confirmed poison) and
            // the loop should try again NOW; anything else backs off or parks
            // and the alarm/resume owns the future.
            if (
              this.#onPushFailure({
                subscriptionKey,
                configOffset: entry.latestConfiguredEvent.offset,
                epoch: row.epoch,
                config,
                matched,
                scannedEventCount,
                attempt: pushAttempt,
                error,
              }) === "continue"
            ) {
              continue;
            }
            return;
          }
          // The awaited resolve above IS this lane's consumption ack — record
          // both the call duration (transport+receiver latency) and the
          // commit→acked age of the newest delivered event, all on the
          // stream's own clock.
          const settledAtMs = this.#hooks.now();
          const subscriptionMetrics = this.#subscriptionMetricsFor(subscriptionKey);
          subscriptionMetrics.deliveryDuration.record(settledAtMs - dispatchAtMs, settledAtMs);
          const newestCreatedAtMs = this.#parseCreatedAt(matched.at(-1)!.createdAt);
          if (Number.isFinite(newestCreatedAtMs)) {
            subscriptionMetrics.settleLatency.record(settledAtMs - newestCreatedAtMs, settledAtMs);
          }
          subscriptionMetrics.bytesSent += deliveredBytes;
          // Config replacements can preserve the cursor epoch. Their
          // synchronous side effect publishes the new offset, giving this hot
          // path a zero-read fence after the awaited RPC.
          const latestConfiguredOffset = this.#latestConfiguredOffsets.get(subscriptionKey);
          if (
            latestConfiguredOffset !== undefined &&
            latestConfiguredOffset !== entry.latestConfiguredEvent.offset
          ) {
            continue;
          }
          let acknowledged: boolean;
          if (config.delivery.mode === "push") {
            acknowledged = this.#hooks.store.stageAck(subscriptionKey, lastOffset, row.epoch);
          } else {
            acknowledged = this.#hooks.store.ack(subscriptionKey, lastOffset, row.epoch);
          }
          if (!acknowledged) continue;
          this.#batchLimits.delete(subscriptionKey);
          this.#consecutiveSkips.delete(subscriptionKey);
          if (lastOffset >= state.maxOffset && wakeGeneration === this.#wakeGeneration) {
            return;
          }
        }
      } finally {
        this.#pushDrains.delete(subscriptionKey);
      }
    })();
    this.#hooks.keepAlive(
      work.catch((error: unknown) => {
        console.error("stream push drain failed", { subscriptionKey, error });
      }),
    );
  }

  /**
   * Apply a subscription's selector. A condition that THROWS on an event skips
   * that event and records an idempotent error fact — the raw event stays
   * authoritative; the durable record just makes the skip observable.
   */
  #applySelector(
    subscriptionKey: string | undefined,
    selector: CompiledEventSelector,
    events: StreamEvent[],
    eventByteLengths: readonly number[] | undefined,
    projection: DeliveryFrameProjection | undefined,
    durableOnly: boolean,
  ): {
    matched: StreamEvent[];
    matchedByteLength: number | undefined;
    conditionErrors: StreamEventInput[];
  } {
    if (selector.matchesAll) {
      return { matched: events, matchedByteLength: undefined, conditionErrors: [] };
    }
    if (eventByteLengths === undefined || eventByteLengths.length !== events.length) {
      missingFilteredByteLength();
    }
    const visibility = durableOnly ? "durable" : "all";
    const cached =
      projection === undefined
        ? undefined
        : this.#selectorProjections.get(projection)?.get(selector)?.[visibility];
    if (cached !== undefined) {
      return {
        matched: cached.matched.slice(),
        matchedByteLength: cached.matchedByteLength,
        conditionErrors: selectorConditionFacts(subscriptionKey, cached.conditionFailures),
      };
    }
    const matched: StreamEvent[] = [];
    const conditionFailures: SelectorConditionFailure[] = [];
    let matchedByteLength = 0;
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index]!;
      try {
        if (selector.matches(event)) {
          matched.push(event);
          matchedByteLength += eventByteLengths[index]!;
        }
      } catch (error) {
        // Never record a condition failure ABOUT an error fact: those facts
        // land on this same stream, so a condition that throws on the
        // error-occurred shape would otherwise read its own facts next
        // iteration and append one more per fact read — unbounded log growth
        // that even the pause door cannot stop (error-occurred is allowlisted
        // through it). The event is still skipped, silently.
        if (event.type === "events.iterate.com/stream/error-occurred") continue;
        conditionFailures.push({ event, error: String(error) });
      }
    }
    if (projection !== undefined) {
      const selectorProjections = this.#selectorProjections.get(projection) ?? new Map();
      const byVisibility = selectorProjections.get(selector) ?? {};
      byVisibility[visibility] = { matched, matchedByteLength, conditionFailures };
      selectorProjections.set(selector, byVisibility);
      this.#selectorProjections.set(projection, selectorProjections);
      return {
        matched: matched.slice(),
        matchedByteLength,
        conditionErrors: selectorConditionFacts(subscriptionKey, conditionFailures),
      };
    }
    return {
      matched,
      matchedByteLength,
      conditionErrors: selectorConditionFacts(subscriptionKey, conditionFailures),
    };
  }

  #selectorFor(
    subscriptionKey: string,
    configOffset: number,
    config: SubscriptionConfiguredPayload,
  ): CompiledEventSelector {
    const cached = this.#compiledSelectors.get(subscriptionKey);
    if (cached !== undefined && cached.configOffset === configOffset) return cached.selector;
    const selector = compileEventSelector(config.selector);
    this.#compiledSelectors.set(subscriptionKey, { configOffset, selector });
    return selector;
  }

  /**
   * A push delivery failed. `park` mode (and every poke failure) goes through
   * the shared backoff/park machine. `skip` mode first bisects the batch to
   * isolate the poison event, requires SKIP_CONFIRM_ATTEMPTS consecutive
   * failures of that lone event before stepping over it, and still parks when
   * skips run consecutive (a receiver that fails everything is DOWN, not
   * poisoned — mass-skipping its backlog would be silent data loss).
   */
  #onPushFailure(args: {
    subscriptionKey: string;
    configOffset: number;
    epoch: number;
    config: SubscriptionConfiguredPayload;
    matched: StreamEvent[];
    scannedEventCount: number;
    attempt: number;
    error: unknown;
  }): "continue" | "stop" {
    const {
      subscriptionKey,
      configOffset,
      epoch,
      config,
      matched,
      scannedEventCount,
      attempt: dispatchedAttempt,
      error,
    } = args;
    const row = this.#currentDeliveryRow(subscriptionKey, configOffset, epoch);
    if (row === undefined) return "continue";
    // A receiver that DECLARED itself unavailable (see
    // StreamReceiverUnavailableError) is down, not poisoned: no bisecting, no
    // skip confirmation — the same batch backs off and redelivers whole, and
    // sustained unavailability parks loudly like any other outage. Known
    // wrinkle: the backoff attempts accrued here share the row's counter with
    // skip confirmation, so a genuine poison event arriving the moment the
    // receiver recovers can confirm in fewer than SKIP_CONFIRM_ATTEMPTS lone
    // tries — a mis-skip needs a poison event racing the recovery boundary,
    // versus today's guaranteed skip of healthy events during the outage.
    if (isStreamReceiverUnavailableError(error)) {
      this.#onDeliveryFailure({
        subscriptionKey,
        configOffset,
        epoch,
        error,
        row,
        attempt: dispatchedAttempt,
      });
      return "stop";
    }
    if (config.onPoison === "skip") {
      if (matched.length > 1) {
        // Bisect the batch that actually failed, not the configured ceiling:
        // a byte cap, selector, or short tail may already have made it much
        // smaller. Retrying an identical failed frame adds receiver side
        // effects without narrowing the poison search.
        this.#batchLimits.set(subscriptionKey, halveBatchLimit(scannedEventCount));
        return "continue";
      }
      const attempt = row.attempt + 1;
      if (attempt < SKIP_CONFIRM_ATTEMPTS) {
        this.#backoff(subscriptionKey, epoch, attempt, error);
        return "stop";
      }
      // Confirmed poison — unless skips are running consecutive, in which
      // case the receiver is down (everything fails, nothing is "the" poison
      // event) and mass-skipping its backlog would be silent data loss: park.
      const skips = (this.#consecutiveSkips.get(subscriptionKey) ?? 0) + 1;
      if (skips >= MAX_CONSECUTIVE_SKIPS) {
        this.#park(subscriptionKey, configOffset, epoch, row, attempt, error);
        return "stop";
      }
      const poison = matched[0]!;
      this.#consecutiveSkips.set(subscriptionKey, skips);
      this.#hooks.appendFact({
        type: "events.iterate.com/stream/error-occurred",
        idempotencyKey: `push-poison-skipped:${subscriptionKey}:${poison.offset}`,
        payload: {
          message: `subscription "${subscriptionKey}" skipped poison event at offset ${poison.offset} after ${attempt} attempts: ${errorMessage(error)}`,
        },
      });
      // Step over the confirmed poison event and reset the bisect window +
      // failure streak: the receiver is alive, it just cannot digest that one.
      this.#hooks.store.ack(subscriptionKey, poison.offset, epoch);
      this.#batchLimits.delete(subscriptionKey);
      return "continue";
    }

    this.#onDeliveryFailure({
      subscriptionKey,
      configOffset,
      epoch,
      error,
      row,
      attempt: dispatchedAttempt,
    });
    return "stop";
  }

  #currentDeliveryRow(
    subscriptionKey: string,
    configOffset: number,
    epoch: number,
  ): SubscriptionCursorRow | undefined {
    const current = this.#hooks.coreState().configuredSubscribersByKey[subscriptionKey];
    if (current?.latestConfiguredEvent.offset !== configOffset) return undefined;
    const row = this.#hooks.store.get(subscriptionKey);
    return row?.epoch === epoch ? row : undefined;
  }

  /** Shared failure path for pokes and park-mode pushes: back off, then park. */
  #onDeliveryFailure(args: {
    subscriptionKey: string;
    configOffset: number;
    epoch: number;
    error: unknown;
    row?: SubscriptionCursorRow;
    attempt?: number;
    immediateFirstRetry?: boolean;
  }): boolean {
    const { subscriptionKey, configOffset, epoch, error } = args;
    const row = args.row ?? this.#currentDeliveryRow(subscriptionKey, configOffset, epoch);
    if (row === undefined) return false;
    const attempt = args.attempt ?? row.attempt + 1;
    if (attempt >= MAX_DELIVERY_ATTEMPTS) {
      this.#park(subscriptionKey, configOffset, epoch, row, attempt, error);
      return true;
    }
    if (args.immediateFirstRetry === true && attempt === 1) {
      this.#retryImmediately(subscriptionKey, epoch, attempt, error);
      return true;
    }
    this.#backoff(subscriptionKey, epoch, attempt, error);
    return true;
  }

  #retryImmediately(subscriptionKey: string, epoch: number, attempt: number, error: unknown): void {
    const nextAttemptAt = this.#hooks.now();
    this.#hooks.store.nack(subscriptionKey, {
      attempt,
      nextAttemptAt,
      error: errorMessage(error),
      epoch,
    });
    // The close below normally drives this retry. The durable alarm covers an
    // eviction between persisting the nack and scheduling the replacement poke.
    this.#hooks.armAlarm(nextAttemptAt);
  }

  #backoff(subscriptionKey: string, epoch: number, attempt: number, error: unknown): void {
    const nextAttemptAt = this.#hooks.now() + computeBackoffMs(attempt, this.#hooks.random());
    this.#hooks.store.nack(subscriptionKey, {
      attempt,
      nextAttemptAt,
      error: errorMessage(error),
      epoch,
    });
    // Activation already primed the incarnation's earliest durable deadline;
    // moving this known backoff earlier is O(1). Full-row scans belong on the
    // alarm path, not once per failure (which becomes O(S^2) under fan-out).
    this.#hooks.armAlarm(nextAttemptAt);
  }

  /**
   * Give up loudly: the parked fact folds into core state (delivery stops) and
   * shows red in the UI. Idempotent per (key, cursor) so redeliveries of the
   * failure cannot spam the log. `subscription-resumed` (or a fresh
   * `subscription-configured`) is the way back.
   */
  #park(
    subscriptionKey: string,
    configOffset: number,
    epoch: number,
    row: SubscriptionCursorRow,
    attempts: number,
    error: unknown,
  ): void {
    // State-guarded, not idempotency-keyed: a park after resume at an unmoved
    // cursor is a NEW transition and must land as a new fact (an idempotency
    // key derived from the cursor would swallow it and the subscription would
    // retry forever without ever turning red again). Duplicate suppression
    // comes from the fold: while parked, the pump never runs this path.
    const current = this.#hooks.coreState().configuredSubscribersByKey[subscriptionKey];
    if (
      current?.latestConfiguredEvent.offset !== configOffset ||
      current.parkedAtOffset !== undefined
    ) {
      return;
    }
    this.#hooks.appendFact({
      type: "events.iterate.com/stream/subscription-parked",
      payload: {
        subscriptionKey,
        atOffset: row.ackedOffset,
        attempts,
        error: errorMessage(error),
      },
    });
    // A parked row must not keep driving the alarm: the park was preceded by
    // a nack whose (now past) next_attempt_at would otherwise be re-armed by
    // every onAlarm forever — a permanent alarm hot loop per parked
    // subscription. Clear the backoff, keep the cursor (the park fact carries
    // the attempts + error for the audit trail).
    this.#hooks.store.ack(subscriptionKey, row.ackedOffset, epoch);
    this.#consecutiveSkips.delete(subscriptionKey);
    this.#batchLimits.delete(subscriptionKey);
  }

  #armAlarmFromStore(settledKey?: string): void {
    // Not a bare MIN over the rows: parked rows keep their cursor but must
    // not drive the alarm. An in-flight row's consumed backoff is ignored, but
    // its separately persisted recovery deadline must remain armed until the
    // RPC settles so a crash cannot strand a quiet stream.
    const state = this.#hooks.coreState();
    let next: number | null = null;
    let now: number | undefined;
    for (const row of this.#hooks.store.list()) {
      const key = row.subscriptionKey;
      if (state.configuredSubscribersByKey[key]?.parkedAtOffset !== undefined) continue;
      const inFlight =
        key !== settledKey && (this.#pushDrains.has(key) || this.#pokesInFlight.has(key));
      if (row.nextAttemptAt !== null && !inFlight && (next === null || row.nextAttemptAt < next)) {
        next = row.nextAttemptAt;
      }
      if (row.pendingRecoveryAt !== null) {
        let recoveryAt = row.pendingRecoveryAt;
        if (inFlight) {
          now ??= this.#hooks.now();
          if (recoveryAt <= now) recoveryAt = now + DELIVERY_TIMEOUT_MS;
        }
        if (next === null || recoveryAt < next) next = recoveryAt;
      }
    }
    if (next !== null) this.#hooks.armAlarm(next);
  }

  // ===========================================================================
  // Config side effects, called by the Stream DO's core processEvent.
  // ===========================================================================

  /** A `subscription-configured` event committed (new or replacing). */
  onSubscriptionConfigured(
    payload: SubscriptionConfiguredPayload,
    eventOffset: number,
    options?: ControlSideEffectOptions,
  ): void {
    const key = payload.subscriptionKey;
    this.#latestConfiguredOffsets.set(key, eventOffset);
    this.#configuredSubscribers = undefined;
    this.#compiledSelectors.delete(key);
    // A replaced config's live connection belongs to the old config; drop it
    // and let reconcile re-establish against the new one.
    this.#connections.get(key)?.close("replaced");
    const cursor = initialCursorFor(payload, eventOffset);
    const existing = this.#hooks.store.get(key);
    if (existing === undefined) {
      // Fresh rows already have the requested cursor and clean failure state;
      // do not rewrite the just-inserted row with setCursor + ack.
      this.#hooks.store.ensure(key, cursor);
    } else if (payload.delivery.mode !== "wake" && payload.deliver !== undefined) {
      // An explicit deliver policy on a REPLACEMENT config is a seek; setCursor
      // also clears its backoff, so a following ack would be redundant.
      this.#hooks.store.setCursor(key, cursor);
    } else {
      // Without an explicit replacement seek, preserve the existing cursor
      // while clearing old-target failure state for an immediate retry.
      this.#hooks.store.ack(key, existing.ackedOffset);
    }
    if (options?.deferReconcile !== true) this.wake();
  }

  /** A `subscription-removed` event committed. Deleting the row is revocation. */
  onSubscriptionRemoved(subscriptionKey: string): void {
    this.#latestConfiguredOffsets.delete(subscriptionKey);
    this.#configuredSubscribers = undefined;
    this.#hooks.store.delete(subscriptionKey);
    this.#connections.get(subscriptionKey)?.close("subscription-removed");
    this.#batchLimits.delete(subscriptionKey);
    this.#consecutiveSkips.delete(subscriptionKey);
    this.#subscriptionMetrics.delete(subscriptionKey);
    this.#compiledSelectors.delete(subscriptionKey);
  }

  #subscriptionMetricsFor(subscriptionKey: string) {
    let metrics = this.#subscriptionMetrics.get(subscriptionKey);
    if (metrics === undefined) {
      metrics = {
        settleLatency: new LatencyRing(),
        deliveryDuration: new LatencyRing(),
        bytesSent: 0,
      };
      this.#subscriptionMetrics.set(subscriptionKey, metrics);
    }
    return metrics;
  }

  /** A `subscription-cursor-set` fact committed: the audited seek. */
  onCursorSet(
    subscriptionKey: string,
    afterOffset: number,
    options?: ControlSideEffectOptions,
  ): void {
    this.#hooks.store.setCursor(subscriptionKey, afterOffset);
    if (options?.deferReconcile !== true) this.wake();
  }

  /** A contiguous committed run of audited seeks; the enclosing append owns the final wake. */
  onCursorSets(cursors: readonly SubscriptionCursorSet[]): void {
    this.#hooks.store.setCursors(cursors);
  }

  /**
   * A `subscription-resumed` fact committed: un-park (the fold already
   * cleared it), clear the backoff/failure streak, and kick. Resume is a PURE
   * un-park — moving the cursor is `subscription-cursor-set`'s job, its own
   * fact; a redrive appends both.
   */
  onResumed(subscriptionKey: string, options?: ControlSideEffectOptions): void {
    const row = this.#hooks.store.get(subscriptionKey);
    if (row !== undefined) this.#hooks.store.ack(subscriptionKey, row.ackedOffset);
    this.#consecutiveSkips.delete(subscriptionKey);
    this.#batchLimits.delete(subscriptionKey);
    if (options?.deferReconcile !== true) this.wake();
  }

  // ===========================================================================
  // The shared connection pump (verbatim semantics from the previous
  // stream-connections.ts): catch-up replay from the requested cursor, then
  // live batches after every commit; the first batch is immediate so a
  // subscriber can paint without a separate getState call.
  // ===========================================================================

  #open(args: OpenConnectionArgs): Connection {
    const { subscriptionKey, subscriptionType, sink } = args;

    // Replacing any existing connection for this key.
    this.#connections.get(subscriptionKey)?.close("replaced");

    const deliverEvents = args.events !== false;
    // State-only subscriptions are implicitly live-from-now: replay without
    // events is meaningless, so replayAfterOffset is ignored in that mode.
    const openedState = this.#hooks.coreState();
    let cursor = deliverEvents
      ? (args.replayAfterOffset ?? openedState.maxOffset)
      : openedState.maxOffset;
    let initialBatchPending = true;
    let draining = false;
    let open = true;
    let notifiedHead = openedState.maxOffset;
    let pendingState: CoreProcessorState | undefined = openedState;
    const onDeliverySettled =
      subscriptionType === "configured"
        ? (outcome: "ok" | "error", newestCreatedAtMs: number) => {
            if (outcome !== "ok") return;
            const settledAtMs = this.#hooks.now();
            connection.settleLatency.record(settledAtMs - newestCreatedAtMs, settledAtMs);
          }
        : undefined;

    const pump = async () => {
      draining = true;
      try {
        while (open) {
          const currentState = pendingState ?? this.#hooks.coreState();
          pendingState = undefined;
          let events: StreamEvent[] = [];
          let deliveredBytes = 0;
          if (deliverEvents) {
            const stateMaxOffset = currentState.maxOffset;
            let emptyReadPages = 0;
            for (;;) {
              // Same byte-capped read as the push drain: a batch of near-2MB
              // events in one live frame would blow the RPC frame limit and turn
              // into a delivery failure the subscriber can never get past. The
              // in-memory head avoids an empty SQLite probe once caught up.
              const read =
                cursor < stateMaxOffset
                  ? this.#deliveryFrameReader.read({
                      afterOffset: cursor,
                      limit: DELIVERY_BATCH_LIMIT,
                      throughOffset: stateMaxOffset,
                      durableOnly: subscriptionType === "configured",
                      includeEventByteLengths:
                        args.selector !== undefined && !args.selector.matchesAll,
                    })
                  : undefined;
              if (read?.lastOffset === undefined) {
                // Caught up; the next append wakes us again. The first drain
                // still owes the initial state batch.
                if (!initialBatchPending) return;
                break;
              }
              cursor = read.lastOffset;
              // Configured (wake) connections are a durable lane: ephemeral
              // events are dropped from delivery (the cursor above already
              // advanced over them), so hosted processors structurally never
              // see one. Ephemeral subscriptions receive them, live and on
              // replay.
              const visible = read.events;
              if (args.selector === undefined || args.selector.matchesAll) {
                events = visible;
                deliveredBytes = read.byteLength;
              } else {
                const selected = this.#applySelector(
                  undefined,
                  args.selector,
                  visible,
                  read.eventByteLengths,
                  read.projection,
                  read.durableOnly,
                );
                events = selected.matched;
                deliveredBytes = selected.matchedByteLength ?? missingFilteredByteLength();
              }
              emptyReadPages += 1;
              if (
                events.length > 0 ||
                initialBatchPending ||
                subscriptionType !== "configured" ||
                cursor >= stateMaxOffset ||
                emptyReadPages >= MAX_CONFIGURED_EMPTY_READ_PAGES
              ) {
                break;
              }
            }
            if (events.length === 0 && !initialBatchPending && subscriptionType !== "configured") {
              if (cursor < currentState.maxOffset) pendingState ??= currentState;
              continue;
            }
          } else {
            const stateMaxOffset = currentState.maxOffset;
            if (stateMaxOffset <= cursor && !initialBatchPending) return;
            cursor = stateMaxOffset;
          }
          initialBatchPending = false;
          const singleEventDelivery = args.deliveryUnit === "event" && events.length > 0;
          connection.batchesSent += singleEventDelivery ? events.length : 1;
          connection.eventsSent += events.length;
          connection.bytesSent += deliveredBytes;
          const dispatchAtMs = this.#hooks.now();
          connection.lastDeliveredAt = this.#formatTimestamp(dispatchAtMs);
          this.#hooks.recordEgress(events.length, deliveredBytes, dispatchAtMs);
          if (currentState.projectId === undefined || currentState.path === undefined) {
            throw new Error(
              "Cannot deliver stream batch before stream coordinates are initialized.",
            );
          }
          // Wake-lane cumulative fences are pulled for corpse detection, so a
          // fence's settle doubles as a free commit→consumed sample on the
          // stream's own clock. Ephemeral results stay unpulled: no onSettled
          // ever fires there (see subscriber-sinks.ts).
          const deliveryProjectId = currentState.projectId;
          const deliveryPath = currentState.path;
          const deliver = (deliveredEvents: StreamEvent[], deliveryThroughOffset: number) => {
            const newestCreatedAtMs =
              subscriptionType !== "configured" || deliveredEvents.length === 0
                ? undefined
                : this.#parseCreatedAt(deliveredEvents.at(-1)!.createdAt);
            sink(
              {
                projectId: deliveryProjectId,
                path: deliveryPath,
                events: deliveredEvents,
                deliveryThroughOffset,
                streamMaxOffset: currentState.maxOffset,
                // Read in the same synchronous block as streamMaxOffset, so the
                // two always correspond (state-at-streamMaxOffset; see rpc-types.ts).
                state: currentState,
              } satisfies StreamEventBatch,
              newestCreatedAtMs === undefined || !Number.isFinite(newestCreatedAtMs)
                ? undefined
                : newestCreatedAtMs,
              onDeliverySettled,
            );
          };
          if (singleEventDelivery) {
            for (let index = 0; index < events.length; index += 1) {
              const delivered = events[index]!;
              deliver([delivered], index === events.length - 1 ? cursor : delivered.offset);
            }
          } else {
            deliver(events, cursor);
          }
          await Promise.resolve();
          // A notification publishes its immutable state snapshot before it
          // observes `draining`. Keeping only the newest snapshot coalesces an
          // arbitrary append burst while preserving a no-loss handoff across
          // this yield. A capped replay keeps its current target until caught up.
          if (cursor < currentState.maxOffset) pendingState ??= currentState;
          if (pendingState === undefined) return;
        }
      } finally {
        draining = false;
      }
    };

    const startedAtMs = this.#hooks.now();
    const connection: Connection = {
      subscriptionType,
      startedAt: this.#formatTimestamp(startedAtMs),
      ...(args.presence === undefined ? {} : { subscriber: args.presence }),
      getProcessorRuntimeState: retainGetProcessorRuntimeState(args.getRuntimeState),
      ping: retainSubscriberPing(args.ping),
      get cursor() {
        return cursor;
      },
      batchesSent: 0,
      eventsSent: 0,
      bytesSent: 0,
      settleLatency: new LatencyRing(),
      pingRtt: new LatencyRing(),
      // Stay synchronous while a pump owns delivery. Entering an async
      // function just to hit its draining guard allocates one resolved Promise
      // per connection on every append burst; the active loop already rereads
      // the stream head after each delivery yield.
      notify: (state) => {
        // A sink may synchronously append while an outer wake is still walking
        // the connection table. Ignore that outer wake's older snapshot after
        // the nested wake has already published a newer head.
        if (state.maxOffset <= notifiedHead) return;
        notifiedHead = state.maxOffset;
        pendingState = state;
        if (!draining) void pump();
      },
      isLive: () => open,
      hasPendingDelivery: () => (sink.pendingDeliveries?.() ?? 0) > 0,
      close: (reason) => {
        if (!open) return;
        open = false;
        if (this.#connections.get(subscriptionKey) === connection) {
          this.#connections.delete(subscriptionKey);
          if (subscriptionType === "configured") {
            this.#configuredConnectionCount -= 1;
            if (this.#configuredConnectionCount === 0) this.#clearIdleTimer();
          }
        }
        // The ping stub proxies through the same chain the sink retains
        // (wake lane), so it releases before the sink tears that chain down.
        connection.ping?.[Symbol.dispose]();
        sink[Symbol.dispose]();
        connection.getProcessorRuntimeState?.[Symbol.dispose]();
        this.#hooks.appendFact({
          type: "events.iterate.com/stream/subscriber-disconnected",
          payload: { subscriptionKey, reason },
        });
        // A dead durable connection makes its watermark decisive again. Only
        // genuinely-broken closes re-reconcile: idle teardown suppresses
        // reconcile for its turn and advances watermarks itself (see
        // runIdleTeardownNow), and "replaced"/"subscription-removed" closes
        // are already mid-flow.
        if (reason === "rpc-broken" || reason === "delivery-failed") {
          this.wake();
        }
      },
    };

    this.#connections.set(subscriptionKey, connection);
    if (subscriptionType === "configured") this.#configuredConnectionCount += 1;
    this.#hooks.appendFact({
      type: "events.iterate.com/stream/subscriber-connected",
      payload: {
        subscriptionKey,
        subscriptionType,
        ...(args.presence === undefined ? {} : { subscriber: args.presence }),
      },
    });
    sink.onRpcBroken?.(() => connection.close("rpc-broken"));
    void pump();
    return connection;
  }

  /**
   * Durable-sink delivery failures arrive here (see subscriber-sinks.ts).
   * Persist the failure FIRST, close second: the close's disconnect fact
   * triggers the replacement poke. Attempt one retries immediately because a
   * dead callback normally means the processor was evicted; if the replacement
   * host rejects the same checkpoint, the preserved streak puts attempt two on
   * the existing exponential backoff. Deterministic failures therefore still
   * cannot become an RPC-rate loop and still park at the shared threshold.
   */
  onDurableDeliveryError(subscriptionKey: string, error: unknown): void {
    const connection = this.#connections.get(subscriptionKey);
    if (connection === undefined) return;
    console.error("stream durable sink delivery failed; replacing connection", {
      subscriptionKey,
      error,
    });
    const entry = this.#hooks.coreState().configuredSubscribersByKey[subscriptionKey];
    const row = this.#hooks.store.get(subscriptionKey);
    if (entry !== undefined && row !== undefined) {
      this.#onDeliveryFailure({
        subscriptionKey,
        configOffset: entry.latestConfiguredEvent.offset,
        epoch: row.epoch,
        error,
        row,
        immediateFirstRetry: true,
      });
    }
    connection.close("delivery-failed");
  }

  // ===========================================================================
  // Introspection + lifecycle plumbing.
  // ===========================================================================

  close(subscriptionKey: string, reason: StreamSubscriberDisconnectReason): void {
    this.#connections.get(subscriptionKey)?.close(reason);
  }

  hasConnection(subscriptionKey: string): boolean {
    return this.#connections.has(subscriptionKey);
  }

  async getProcessorRuntimeState(subscriptionKey: string): Promise<ProcessorRuntimeState | null> {
    const connection = this.#connections.get(subscriptionKey);
    return (await connection?.getProcessorRuntimeState?.()) ?? null;
  }

  /**
   * One throttled mutual-ping round over every live connection that supplied
   * a ping capability. Observer-driven: `runtimeState()` triggers it, so RTT
   * sampling runs only while something is reading runtime state — the debug
   * panel's poll, or a live browser tab's ~10s liveness probe. A stream with
   * no browser attached and no debug observer is never pinged. Purely
   * observational: a failed/garbage/slow ping drops the sample and NOTHING
   * else (liveness stays owned by result-pulling and onRpcBroken); it never
   * wakes pumps and never re-arms the idle timer.
   */
  samplePingsSoon(): void {
    const now = this.#hooks.now();
    if (
      this.#lastPingRoundAtMs !== null &&
      now - this.#lastPingRoundAtMs < PING_ROUND_MIN_INTERVAL_MS
    ) {
      return;
    }
    this.#lastPingRoundAtMs = now;
    for (const connection of this.#connections.values()) {
      const ping = connection.ping;
      if (ping === undefined) continue;
      const t0 = this.#hooks.now();
      const work = (async () => {
        try {
          const reply = await withDeliveryTimeout(Promise.resolve(ping({ t0 })), "ping", {
            timeoutMs: PING_TIMEOUT_MS,
          });
          const t3 = this.#hooks.now();
          if (
            typeof reply?.t1 !== "number" ||
            typeof reply.t2 !== "number" ||
            !Number.isFinite(reply.t1) ||
            !Number.isFinite(reply.t2)
          ) {
            return; // a subscriber that answers garbage just has no RTT data
          }
          const { rttMs } = pingRoundTrip({ t0, t1: reply.t1, t2: reply.t2 }, t3);
          if (connection.isLive()) connection.pingRtt.record(rttMs, t3);
        } catch {
          // Drop the sample; the delivery machinery owns liveness verdicts.
        }
      })();
      this.#hooks.keepAlive(work);
    }
  }

  connectionRuntimeState(): Record<string, ConnectionRuntimeState> {
    const maxOffset = this.#hooks.coreState().maxOffset;
    return Object.fromEntries(
      [...this.#connections].map(([subscriptionKey, connection]) => {
        const settleLatencyMs = connection.settleLatency.stats();
        const pingRttMs = connection.pingRtt.stats();
        return [
          subscriptionKey,
          {
            subscriptionType: connection.subscriptionType,
            startedAt: connection.startedAt,
            cursor: connection.cursor,
            lag: Math.max(0, maxOffset - connection.cursor),
            batchesSent: connection.batchesSent,
            eventsSent: connection.eventsSent,
            bytesSent: connection.bytesSent,
            lastDeliveredAt: connection.lastDeliveredAt,
            hasPendingDelivery: connection.hasPendingDelivery(),
            ...(settleLatencyMs === null ? {} : { settleLatencyMs }),
            ...(pingRttMs === null ? {} : { pingRttMs }),
            ...(connection.subscriber === undefined ? {} : { subscriber: connection.subscriber }),
          },
        ];
      }),
    );
  }

  subscriptionRuntimeState(): Record<string, SubscriptionRuntimeState> {
    const state = this.#hooks.coreState();
    const rows = new Map(this.#hooks.store.list().map((row) => [row.subscriptionKey, row]));
    return Object.fromEntries(
      Object.entries(state.configuredSubscribersByKey).map(([subscriptionKey, entry]) => {
        const row = rows.get(subscriptionKey);
        const ackedOffset = row?.ackedOffset ?? 0;
        const metrics = this.#subscriptionMetrics.get(subscriptionKey);
        const settleLatencyMs = metrics?.settleLatency.stats() ?? null;
        const deliveryDurationMs = metrics?.deliveryDuration.stats() ?? null;
        return [
          subscriptionKey,
          {
            mode: entry.latestConfiguredEvent.payload.delivery.mode,
            ackedOffset,
            lag: Math.max(0, state.maxOffset - ackedOffset),
            attempt: row?.attempt ?? 0,
            nextAttemptAt: row?.nextAttemptAt ?? null,
            lastError: row?.lastError ?? null,
            parkedAtOffset: entry.parkedAtOffset ?? null,
            connected: this.#connections.has(subscriptionKey),
            ...(metrics === undefined ? {} : { bytesSent: metrics.bytesSent }),
            ...(settleLatencyMs === null ? {} : { settleLatencyMs }),
            ...(deliveryDurationMs === null ? {} : { deliveryDurationMs }),
          },
        ];
      }),
    );
  }

  /**
   * Keep one in-memory idle timer armed while durable delivery connections
   * exist (the thing that pins the DO resident). Every append advances a
   * numeric inactivity deadline; the existing timer checks that deadline when
   * it fires instead of allocating and cancelling one timer per append.
   */
  armOrClearIdleTimer(nowMs: number): void {
    if (this.#configuredConnectionCount === 0) {
      this.#clearIdleTimer();
      return;
    }
    this.#idleDeadlineMs = nowMs + this.#idleTeardownMs;
    this.#idleTimer ??= setTimeout(() => this.#onIdleTimer(), this.#idleTeardownMs);
  }

  #onIdleTimer(): void {
    this.#idleTimer = undefined;
    const deadline = this.#idleDeadlineMs;
    if (deadline === undefined) return;
    const remainingMs = deadline - this.#hooks.now();
    if (remainingMs > 0) {
      this.#idleTimer = setTimeout(() => this.#onIdleTimer(), remainingMs);
      return;
    }
    this.#idleDeadlineMs = undefined;
    this.runIdleTeardownNow();
  }

  #clearIdleTimer(): void {
    if (this.#idleTimer !== undefined) clearTimeout(this.#idleTimer);
    this.#idleTimer = undefined;
    this.#idleDeadlineMs = undefined;
  }

  /**
   * Deliberately drops every live durable delivery connection so a quiet
   * stream stops pinning subscriber DOs with idle cross-isolate RPC sessions.
   * The durable subscription config is kept, so the next append re-pokes.
   * The idle timer's action, also exposed for tests / operator use.
   */
  runIdleTeardownNow(): void {
    this.#clearIdleTimer();
    // Snapshot first: close() mutates the connection table. The whole loop is
    // one synchronous DO turn, so nothing foreign can interleave — the only
    // events appended during it are our own subscriber-disconnected facts.
    const keys = this.#configuredConnectionKeys();
    // "Delivered into the sink" is not "ingested": a sink whose last batch is
    // still UNSETTLED belongs to a wedged subscriber, and advancing its
    // watermark to maxOffset would defer redelivery until the next append —
    // indefinitely on a quiet stream. Those keys skip the ack and get an
    // immediate re-poke instead (the at-least-once replay path).
    const wedgedKeys = new Set(
      keys.filter((key) => this.#connections.get(key)?.hasPendingDelivery() === true),
    );
    this.#tearingDown = true;
    try {
      for (const subscriptionKey of keys) this.close(subscriptionKey, "idle");
    } finally {
      this.#tearingDown = false;
    }
    // Advance every cleanly-drained watermark past the disconnect facts this
    // loop just appended, so the next reconcile is a no-op instead of an
    // immediate re-poke. Safe: the watermark is observational (the
    // subscriber's own checkpoint is the truth), and after >= idleTeardownMs
    // of append silence the pumps were long since drained, so maxOffset holds
    // nothing the sink has not already seen except our own facts.
    const maxOffset = this.#hooks.coreState().maxOffset;
    for (const subscriptionKey of keys) {
      if (wedgedKeys.has(subscriptionKey)) continue;
      this.#hooks.store.ack(subscriptionKey, maxOffset);
    }
    if (wedgedKeys.size > 0) queueMicrotask(() => this.wake());
  }

  #configuredConnectionKeys(): string[] {
    return [...this.#connections]
      .filter(([, connection]) => connection.subscriptionType === "configured")
      .map(([subscriptionKey]) => subscriptionKey);
  }
}

/**
 * Bounds one delivery/poke attempt. Without it a wedged receiver (the worst
 * real case: a cold worker build that never completes) holds the drain slot
 * and pins the DO unboundedly, with no nack, no backoff, and no park. On
 * timeout the attempt counts as a failure — the spine backs off and retries;
 * a build that was merely slow continues server-side via waitUntil, so the
 * retry hits the warm cache (the same shape #1761's build budget had).
 */
const DELIVERY_TIMEOUT_MS = 60_000;

/**
 * Minimum interval between mutual-ping rounds. Sampling is observer-driven
 * (each `runtimeState()` call requests a round), so this throttle turns the
 * panel's ~2s poll into a ≤1-ping-per-5s-per-connection ceiling.
 */
const PING_ROUND_MIN_INTERVAL_MS = 5_000;
/** Bound on one ping attempt — a reply slower than this isn't a useful RTT sample. */
const PING_TIMEOUT_MS = 10_000;

async function withDeliveryTimeout<T>(
  promise: Promise<T>,
  label: string,
  opts: {
    /** Runs iff the underlying promise RESOLVES after the timeout already won
     * the race — the caller's chance to dispose late-arriving resources. */
    onLateResolve?: (value: T) => void;
    /** Override for callers with their own bound (pings); deliveries use the default. */
    timeoutMs?: number;
  } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DELIVERY_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  if (opts.onLateResolve !== undefined) {
    const onLateResolve = opts.onLateResolve;
    void promise.then(
      (value) => {
        if (timedOut) onLateResolve(value);
      },
      () => {
        // Late rejections have nothing to dispose; the race already surfaced
        // a failure to the caller.
      },
    );
  }
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function selectorConditionFacts(
  subscriptionKey: string | undefined,
  failures: readonly SelectorConditionFailure[],
): StreamEventInput[] {
  if (subscriptionKey === undefined || failures.length === 0) return [];
  return failures.map(({ event, error }) => ({
    type: "events.iterate.com/stream/error-occurred",
    idempotencyKey: `selector-condition-failed:${subscriptionKey}:${event.offset}`,
    payload: {
      message: `subscription "${subscriptionKey}" selector condition failed on offset ${event.offset}: ${error}`,
    },
  }));
}

function missingFilteredByteLength(): never {
  throw new Error("Filtered stream delivery requires aligned per-event byte lengths.");
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)) || "unknown error";
}
