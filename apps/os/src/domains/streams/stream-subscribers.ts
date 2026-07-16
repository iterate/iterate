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
// | wake       | returned from the expression-named poke| pulled; next frame waits for settle |
// | push       | named by a persisted itx expression   | awaited — the ack that advances the cursor |
// | webhook    | the configured URL (per-event POST)   | awaited 2xx — the ack that advances the cursor |
//
// Ephemeral subscriptions are session-scoped and forgotten on disconnect.
// Durable subscriptions (wake + push) are desired state — the folded
// `subscription-configured` events in core state — and their delivery
// bookkeeping is the SPINE: one SQLite cursor row per subscription
// (stream-storage.ts) plus the Durable Object alarm for retries. Cursor rows
// are storage; park/resume transitions are facts (`subscription-parked` /
// `-resumed` events). The spine triggers on watermark lag — never on event
// types — so facts stay data, not control flow.
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
import type { SizedStreamEvent, SubscriptionCursorStore } from "./stream-storage.ts";
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
  SKIP_CONFIRM_ATTEMPTS,
} from "./subscriber-math.ts";

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
  /** Re-arm the delivery pump after events are committed. Idempotent while draining. */
  wake(): void;
  /** `true` until close() runs — backs the subscription handle's `ping()`. */
  isLive(): boolean;
  /** `true` while a durable sink delivery is dispatched but unsettled. */
  hasPendingDelivery(): boolean;
  /** Stop the pump, dispose the sink, optionally append the disconnect fact, drop from the table. */
  close(reason: StreamSubscriberDisconnectReason, recordFact?: boolean): void;
};

/** Everything `open()` needs to start one delivery connection. */
type OpenConnectionArgs = {
  subscriptionKey: string;
  subscriptionType: StreamSubscriptionType;
  /** Already-retained sink (subscriber-sinks.ts owns retention semantics). */
  sink: RetainedProcessEventBatch;
  replayAfterOffset?: number;
  /** Stable stream creation identity observed by the caller; null binds to an unborn stream. */
  expectedIncarnation?: string | null;
  /** Reject the open if replay would exceed this many raw offsets. */
  maxReplayOffsetGap?: number;
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
  readEvents(args: { afterOffset: number; limit: number }): SizedStreamEvent[];
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
   * the event count and serialized payload bytes it carried (all lanes).
   */
  recordEgress(count: number, bytes: number): void;
  /** Injected clock (epoch ms). */
  now(): number;
  /** Injected randomness (backoff jitter); [0, 1) like Math.random. */
  random(): number;
  /** Arm the Durable Object alarm for the earliest pending retry. */
  armAlarm(atMs: number): void;
  /** Keep the Durable Object alive through background delivery work. */
  keepAlive(promise: Promise<unknown>): void;
};

export class StreamSubscribers {
  readonly #hooks: StreamSubscribersHooks;
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
  #idleTimer: ReturnType<typeof setTimeout> | undefined;
  /** Invalidates async delivery work started against a pre-recovery log. */
  #recoveryGeneration = 0;

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
  readonly #pushDrains = new Set<string>();
  /** Bisect state for onPoison:"skip" — current batch ceiling per key. */
  readonly #batchLimits = new Map<string, number>();
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

  constructor(args: { idleTeardownMs: number; hooks: StreamSubscribersHooks }) {
    this.#hooks = args.hooks;
    this.#idleTeardownMs = args.idleTeardownMs;
  }

  // ===========================================================================
  // The one wake-up: called post-commit and from the DO alarm.
  // ===========================================================================

  /**
   * The just-committed events of the most recent append, handed over by the
   * commit path so caught-up pumps and drains consume them directly instead
   * of re-reading (and re-parsing) them from SQLite once per delivery lane.
   * Correctness is offset-gated, never freshness-gated: `#readBatch` uses the
   * tail only when its first offset is exactly `afterOffset + 1`, so a stale
   * tail (more appends since, a rewound cursor) either still IS the right
   * contiguous window or self-disqualifies and falls back to storage.
   */
  #freshTail: SizedStreamEvent[] = [];

  /**
   * Re-arm every live connection's pump and reconcile durable subscriptions
   * (poke lagging wake subscribers without a connection, drain lagging push
   * subscriptions that are due). Never throws; never blocks the append.
   *
   * `freshTail` is the live-tail fast path: append passes what it just
   * committed (already sized by the log write) so tailing consumers skip the
   * storage round trip.
   */
  wake(freshTail?: SizedStreamEvent[]): void {
    if (freshTail !== undefined && freshTail.length > 0) this.#freshTail = freshTail;
    for (const connection of this.#connections.values()) connection.wake();
    if (this.#tearingDown) return;
    try {
      this.#reconcileDurable();
    } catch (error) {
      console.error("stream durable subscription reconcile failed", error);
    }
  }

  /**
   * Quiesce every delivery lane before storage-level recovery. Async calls
   * cannot be cancelled, so their generation fence makes late results inert.
   */
  resetForRecovery(): void {
    this.#recoveryGeneration += 1;
    if (this.#idleTimer !== undefined) clearTimeout(this.#idleTimer);
    this.#idleTimer = undefined;
    this.#tearingDown = true;
    try {
      for (const connection of [...this.#connections.values()]) {
        connection.close("replaced", false);
      }
    } finally {
      this.#tearingDown = false;
    }
    this.#pokesInFlight.clear();
    this.#pushDrains.clear();
    this.#batchLimits.clear();
    this.#consecutiveSkips.clear();
    this.#subscriptionMetrics.clear();
    this.#freshTail = [];
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
    expectedIncarnation?: string | null;
    maxReplayOffsetGap?: number;
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
      expectedIncarnation: args.expectedIncarnation,
      maxReplayOffsetGap: args.maxReplayOffsetGap,
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
  #reconcileDurable(): void {
    const state = this.#hooks.coreState();
    const now = this.#hooks.now();

    for (const [subscriptionKey, entry] of Object.entries(state.configuredSubscribersByKey)) {
      const config = entry.latestConfiguredEvent.payload;
      const configOffset = entry.latestConfiguredEvent.offset;

      // The per-mode initial-cursor policy lives in ONE place
      // (subscriber-math.initialCursorFor) so this and the config side effect
      // below can never drift.
      this.#hooks.store.ensure(subscriptionKey, initialCursorFor(config, configOffset));

      if (entry.parkedAtOffset !== undefined) continue;

      const row = this.#hooks.store.get(subscriptionKey);
      if (row === undefined) continue; // unreachable after ensure; defensive
      if (row.nextAttemptAt !== null && row.nextAttemptAt > now) continue; // alarm owns it
      // "Caught up" trusts the monotonic watermark. A subscriber that
      // discarded its checkpoint (schema-change refold) and lost its
      // connection mid-replay parks here at a partial refold until the next
      // append or dial moves the head — self-healing, but slow on a quiet
      // stream; the subscriber's own keepalive covers the DO-death variant.
      if (row.ackedOffset >= state.maxOffset) continue; // caught up; nothing to say

      if (config.delivery.mode === "wake") {
        if (this.#connections.has(subscriptionKey) || this.#pokesInFlight.has(subscriptionKey)) {
          continue;
        }
        this.#poke(subscriptionKey, config.delivery, configOffset);
        continue;
      }

      if (this.#pushDrains.has(subscriptionKey)) continue;
      this.#drainPush(subscriptionKey);
    }
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
  ): void {
    const recoveryGeneration = this.#recoveryGeneration;
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
        if (recoveryGeneration !== this.#recoveryGeneration) {
          response.sink[Symbol.dispose]();
          return;
        }
        const current = this.#hooks.coreState().configuredSubscribersByKey[subscriptionKey];
        if (
          current === undefined ||
          current.latestConfiguredEvent.offset !== configOffset ||
          current.latestConfiguredEvent.payload.delivery.mode !== "wake"
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
          this.#hooks.store.ack(subscriptionKey, response.checkpointOffset);
        } else {
          this.#hooks.store.advanceWatermark(subscriptionKey, response.checkpointOffset);
        }
      } catch (error) {
        if (recoveryGeneration === this.#recoveryGeneration) {
          this.#onDeliveryFailure(subscriptionKey, error);
        }
      } finally {
        if (recoveryGeneration === this.#recoveryGeneration) {
          this.#pokesInFlight.delete(subscriptionKey);
        }
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
  #drainPush(subscriptionKey: string): void {
    const recoveryGeneration = this.#recoveryGeneration;
    this.#pushDrains.add(subscriptionKey);
    const work = (async () => {
      try {
        for (;;) {
          if (recoveryGeneration !== this.#recoveryGeneration) return;
          const state = this.#hooks.coreState();
          const entry = state.configuredSubscribersByKey[subscriptionKey];
          if (entry === undefined || entry.parkedAtOffset !== undefined) return;
          const config = entry.latestConfiguredEvent.payload;
          if (config.delivery.mode === "wake") return;
          const row = this.#hooks.store.get(subscriptionKey);
          if (row === undefined) return;
          if (row.nextAttemptAt !== null && row.nextAttemptAt > this.#hooks.now()) return;

          // Webhook mode IS the push drain pinned to batch size 1: external
          // receivers get single-event POSTs, each ack covers exactly one
          // offset (mid-batch resume for free), the poison machinery always
          // sees the true delivery unit (bisecting is structurally moot), and
          // the per-iteration staleness checks above run per EVENT — a
          // removed/replaced webhook can never keep POSTing a stale batch to
          // the old URL. The cost is one row/config re-read per event on a
          // backlog, noise against the HTTP POST itself.
          const limit =
            config.delivery.mode === "webhook"
              ? 1
              : Math.min(
                  this.#batchLimits.get(subscriptionKey) ?? DELIVERY_BATCH_LIMIT,
                  DELIVERY_BATCH_LIMIT,
                );
          const sized = this.#readBatch(row.ackedOffset, limit);
          const lastOffset = sized.at(-1)?.event.offset;
          if (lastOffset === undefined) {
            // The allocator head can be ahead of the last surviving row after
            // ephemeral eviction. An empty range read proves that whole suffix
            // contains no durable work, so advance the durable cursor through
            // it instead of reporting permanent phantom lag.
            if (row.ackedOffset < state.maxOffset) {
              this.#hooks.store.ack(subscriptionKey, state.maxOffset, row.epoch);
            }
            return;
          }
          const byteLengthByOffset = new Map(
            sized.map((entry) => [entry.event.offset, entry.byteLength]),
          );

          // Ephemeral events never reach durable receivers — platform law,
          // enforced as the same skip-not-defer shape selectors use: the raw
          // read advances the cursor over their offsets, delivery drops them.
          const durable = sized
            .filter((entry) => entry.event.ephemeral !== true)
            .map((entry) => entry.event);
          const { matched, conditionErrors } = this.#applySelector(
            subscriptionKey,
            config,
            durable,
          );
          for (const fact of conditionErrors) this.#hooks.appendFact(fact);

          if (matched.length === 0) {
            // Skip-not-defer: nothing here for this subscriber, but the cursor
            // must advance or the subscription re-reads these events forever.
            this.#hooks.store.ack(subscriptionKey, lastOffset, row.epoch);
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

          const deliveredBytes = matched.reduce(
            (sum, event) => sum + (byteLengthByOffset.get(event.offset) ?? 0),
            0,
          );
          // Dispatch-time accounting: retries re-send real bytes, so failed
          // attempts count too (the wire carried them either way).
          const dispatchAtMs = this.#hooks.now();
          this.#hooks.recordEgress(matched.length, deliveredBytes);
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
              const batch: StreamPushEventBatch = {
                projectId: state.projectId,
                path: state.path,
                events: matched,
                streamMaxOffset: state.maxOffset,
                subscriptionKey,
                deliveryId: deliveryId(subscriptionKey, matched[0]!.offset, lastOffset),
                attempt: row.attempt + 1,
                configuredEvent,
              };
              await withDeliveryTimeout(
                this.#hooks.dial.push(config.delivery.expression, batch),
                `push ${subscriptionKey}`,
              );
            }
          } catch (error) {
            if (recoveryGeneration !== this.#recoveryGeneration) return;
            // "continue" = the failure handler already moved the goalposts
            // (halved the bisect window or stepped over confirmed poison) and
            // the loop should try again NOW; anything else backs off or parks
            // and the alarm/resume owns the future.
            if (this.#onPushFailure({ subscriptionKey, config, matched, error }) === "continue") {
              continue;
            }
            return;
          }
          if (recoveryGeneration !== this.#recoveryGeneration) return;
          // The awaited resolve above IS this lane's consumption ack — record
          // both the call duration (transport+receiver latency) and the
          // commit→acked age of the newest delivered event, all on the
          // stream's own clock.
          const settledAtMs = this.#hooks.now();
          const subscriptionMetrics = this.#subscriptionMetricsFor(subscriptionKey);
          subscriptionMetrics.deliveryDuration.record(settledAtMs - dispatchAtMs, settledAtMs);
          const newestCreatedAtMs = Date.parse(matched.at(-1)!.createdAt);
          if (Number.isFinite(newestCreatedAtMs)) {
            subscriptionMetrics.settleLatency.record(settledAtMs - newestCreatedAtMs, settledAtMs);
          }
          subscriptionMetrics.bytesSent += deliveredBytes;
          // Fenced on the epoch read above: a seek (cursor-set, replacement
          // deliver, remove+recreate) that landed while this delivery was in
          // flight bumped the epoch, and this ack no-ops instead of
          // clobbering it — the next iteration re-reads the row and drains
          // from wherever the seek pointed.
          this.#hooks.store.ack(subscriptionKey, lastOffset, row.epoch);
          this.#batchLimits.delete(subscriptionKey);
          this.#consecutiveSkips.delete(subscriptionKey);
        }
      } finally {
        if (recoveryGeneration === this.#recoveryGeneration) {
          this.#pushDrains.delete(subscriptionKey);
        }
      }
    })();
    this.#hooks.keepAlive(
      work.catch((error: unknown) => {
        console.error("stream push drain failed", { subscriptionKey, error });
      }),
    );
  }

  /**
   * Read up to `limit` events after `afterOffset`, shrinking under the byte
   * cap. A reader positioned exactly at the last commit's tail consumes the
   * handed-over fresh events instead of re-reading them from SQLite — the
   * committed objects are byte-for-byte what a read-back would parse (append
   * strict-parses the body and stamps `path` before commit).
   */
  #readBatch(afterOffset: number, limit: number): SizedStreamEvent[] {
    const sized =
      this.#freshTail[0]?.event.offset === afterOffset + 1
        ? this.#freshTail.length > limit
          ? this.#freshTail.slice(0, limit)
          : this.#freshTail
        : this.#hooks.readEvents({ afterOffset, limit });
    if (sized.length <= 1) return sized;
    let bytes = 0;
    for (let index = 0; index < sized.length; index += 1) {
      bytes += sized[index]!.byteLength;
      if (bytes > DELIVERY_BATCH_BYTE_LIMIT && index > 0) {
        return sized.slice(0, index);
      }
    }
    return sized;
  }

  /**
   * Apply a subscription's selector. A condition that THROWS on an event skips
   * that event and records an idempotent error fact — the raw event stays
   * authoritative; the durable record just makes the skip observable.
   */
  #applySelector(
    subscriptionKey: string,
    config: SubscriptionConfiguredPayload,
    events: StreamEvent[],
  ): { matched: StreamEvent[]; conditionErrors: StreamEventInput[] } {
    const selector = compileEventSelector(config.selector);
    const matched: StreamEvent[] = [];
    const conditionErrors: StreamEventInput[] = [];
    for (const event of events) {
      try {
        if (selector.matches(event)) matched.push(event);
      } catch (error) {
        // Never record a condition failure ABOUT an error fact: those facts
        // land on this same stream, so a condition that throws on the
        // error-occurred shape would otherwise read its own facts next
        // iteration and append one more per fact read — unbounded log growth
        // that even the pause door cannot stop (error-occurred is allowlisted
        // through it). The event is still skipped, silently.
        if (event.type === "events.iterate.com/stream/error-occurred") continue;
        conditionErrors.push({
          type: "events.iterate.com/stream/error-occurred",
          idempotencyKey: `selector-condition-failed:${subscriptionKey}:${event.offset}`,
          payload: {
            message: `subscription "${subscriptionKey}" selector condition failed on offset ${event.offset}: ${String(error)}`,
          },
        });
      }
    }
    return { matched, conditionErrors };
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
    config: SubscriptionConfiguredPayload;
    matched: StreamEvent[];
    error: unknown;
  }): "continue" | "stop" {
    const { subscriptionKey, config, matched, error } = args;
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
      this.#onDeliveryFailure(subscriptionKey, error);
      return "stop";
    }
    if (config.onPoison === "skip") {
      if (matched.length > 1) {
        // Bisect: retry immediately with a halved batch. Bounded by
        // log2(DELIVERY_BATCH_LIMIT) extra attempts; no backoff — the receiver
        // just proved it is alive enough to reject.
        const current = this.#batchLimits.get(subscriptionKey) ?? DELIVERY_BATCH_LIMIT;
        this.#batchLimits.set(subscriptionKey, halveBatchLimit(current));
        return "continue";
      }
      const row = this.#hooks.store.get(subscriptionKey);
      const attempt = (row?.attempt ?? 0) + 1;
      if (attempt < SKIP_CONFIRM_ATTEMPTS) {
        this.#backoff(subscriptionKey, attempt, error);
        return "stop";
      }
      // Confirmed poison — unless skips are running consecutive, in which
      // case the receiver is down (everything fails, nothing is "the" poison
      // event) and mass-skipping its backlog would be silent data loss: park.
      const skips = (this.#consecutiveSkips.get(subscriptionKey) ?? 0) + 1;
      if (skips >= MAX_CONSECUTIVE_SKIPS) {
        this.#park(subscriptionKey, attempt, error);
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
      this.#hooks.store.ack(subscriptionKey, poison.offset);
      this.#batchLimits.delete(subscriptionKey);
      return "continue";
    }

    const row = this.#hooks.store.get(subscriptionKey);
    this.#onDeliveryFailure(subscriptionKey, error, row?.attempt ?? 0);
    return "stop";
  }

  /** Shared failure path for pokes and park-mode pushes: back off, then park. */
  #onDeliveryFailure(subscriptionKey: string, error: unknown, previousAttempts?: number): void {
    const attempts = previousAttempts ?? this.#hooks.store.get(subscriptionKey)?.attempt ?? 0;
    const attempt = attempts + 1;
    if (attempt >= MAX_DELIVERY_ATTEMPTS) {
      this.#park(subscriptionKey, attempt, error);
      return;
    }
    this.#backoff(subscriptionKey, attempt, error);
  }

  #backoff(subscriptionKey: string, attempt: number, error: unknown): void {
    const nextAttemptAt = this.#hooks.now() + computeBackoffMs(attempt, this.#hooks.random());
    this.#hooks.store.nack(subscriptionKey, {
      attempt,
      nextAttemptAt,
      error: errorMessage(error),
    });
    this.#hooks.armAlarm(nextAttemptAt);
  }

  /**
   * Give up loudly: the parked fact folds into core state (delivery stops) and
   * shows red in the UI. Idempotent per (key, cursor) so redeliveries of the
   * failure cannot spam the log. `subscription-resumed` (or a fresh
   * `subscription-configured`) is the way back.
   */
  #park(subscriptionKey: string, attempts: number, error: unknown): void {
    // State-guarded, not idempotency-keyed: a park after resume at an unmoved
    // cursor is a NEW transition and must land as a new fact (an idempotency
    // key derived from the cursor would swallow it and the subscription would
    // retry forever without ever turning red again). Duplicate suppression
    // comes from the fold: while parked, the pump never runs this path.
    if (
      this.#hooks.coreState().configuredSubscribersByKey[subscriptionKey]?.parkedAtOffset !==
      undefined
    ) {
      return;
    }
    const row = this.#hooks.store.get(subscriptionKey);
    this.#hooks.appendFact({
      type: "events.iterate.com/stream/subscription-parked",
      payload: {
        subscriptionKey,
        atOffset: row?.ackedOffset ?? 0,
        attempts,
        error: errorMessage(error),
      },
    });
    // A parked row must not keep driving the alarm: the park was preceded by
    // a nack whose (now past) next_attempt_at would otherwise be re-armed by
    // every onAlarm forever — a permanent alarm hot loop per parked
    // subscription. Clear the backoff, keep the cursor (the park fact carries
    // the attempts + error for the audit trail).
    if (row !== undefined) this.#hooks.store.ack(subscriptionKey, row.ackedOffset);
    this.#consecutiveSkips.delete(subscriptionKey);
    this.#batchLimits.delete(subscriptionKey);
  }

  #armAlarmFromStore(): void {
    // Not a bare MIN over the rows: parked rows keep their cursor but must
    // not drive the alarm, and a row whose retry is IN FLIGHT this very turn
    // still carries its (past) due time until the attempt settles — re-arming
    // from either spins the alarm at zero delay.
    const state = this.#hooks.coreState();
    let next: number | null = null;
    for (const row of this.#hooks.store.list()) {
      if (row.nextAttemptAt === null) continue;
      const key = row.subscriptionKey;
      if (state.configuredSubscribersByKey[key]?.parkedAtOffset !== undefined) continue;
      if (this.#pushDrains.has(key) || this.#pokesInFlight.has(key)) continue;
      if (next === null || row.nextAttemptAt < next) next = row.nextAttemptAt;
    }
    if (next !== null) this.#hooks.armAlarm(next);
  }

  // ===========================================================================
  // Config side effects, called by the Stream DO's core processEvent.
  // ===========================================================================

  /** A `subscription-configured` event committed (new or replacing). */
  onSubscriptionConfigured(payload: SubscriptionConfiguredPayload, eventOffset: number): void {
    const key = payload.subscriptionKey;
    // A replaced config's live connection belongs to the old config; drop it
    // and let reconcile re-establish against the new one.
    this.#connections.get(key)?.close("replaced");
    const cursor = initialCursorFor(payload, eventOffset);
    this.#hooks.store.ensure(key, cursor);
    // An explicit deliver policy on a REPLACEMENT config is a seek; without
    // one the existing cursor is kept (config update ≠ replay request).
    if (payload.delivery.mode !== "wake" && payload.deliver !== undefined) {
      this.#hooks.store.setCursor(key, cursor);
    }
    // Fresh config clears any backoff so the new target gets an immediate try.
    const row = this.#hooks.store.get(key);
    if (row !== undefined) this.#hooks.store.ack(key, row.ackedOffset);
    this.wake();
  }

  /** A `subscription-removed` event committed. Deleting the row is revocation. */
  onSubscriptionRemoved(subscriptionKey: string): void {
    this.#hooks.store.delete(subscriptionKey);
    this.#connections.get(subscriptionKey)?.close("subscription-removed");
    this.#batchLimits.delete(subscriptionKey);
    this.#consecutiveSkips.delete(subscriptionKey);
    this.#subscriptionMetrics.delete(subscriptionKey);
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
  onCursorSet(subscriptionKey: string, afterOffset: number): void {
    this.#hooks.store.setCursor(subscriptionKey, afterOffset);
    this.wake();
  }

  /**
   * A `subscription-resumed` fact committed: un-park (the fold already
   * cleared it), clear the backoff/failure streak, and kick. Resume is a PURE
   * un-park — moving the cursor is `subscription-cursor-set`'s job, its own
   * fact; a redrive appends both.
   */
  onResumed(subscriptionKey: string): void {
    const row = this.#hooks.store.get(subscriptionKey);
    if (row !== undefined) this.#hooks.store.ack(subscriptionKey, row.ackedOffset);
    this.#consecutiveSkips.delete(subscriptionKey);
    this.#batchLimits.delete(subscriptionKey);
    this.wake();
  }

  // ===========================================================================
  // The shared connection pump (verbatim semantics from the previous
  // stream-connections.ts): catch-up replay from the requested cursor, then
  // live batches after every commit; the first batch is immediate so a
  // subscriber can paint without a separate getState call.
  // ===========================================================================

  #open(args: OpenConnectionArgs): Connection {
    const { subscriptionKey, subscriptionType, sink } = args;

    const deliverEvents = args.events !== false;
    // This synchronous committed head is the subscription's atomic live
    // boundary. Ephemeral rows at/below it existed before the subscription
    // opened and are never replayed; rows above it are genuinely live.
    const coreState = this.#hooks.coreState();
    const openedAtOffset = coreState.maxOffset;
    if (
      args.replayAfterOffset !== undefined &&
      (!Number.isSafeInteger(args.replayAfterOffset) || args.replayAfterOffset < 0)
    ) {
      sink[Symbol.dispose]();
      throw new Error("replayAfterOffset must be a non-negative safe integer");
    }
    if (
      args.expectedIncarnation !== undefined &&
      args.expectedIncarnation !== null &&
      args.expectedIncarnation.trim().length === 0
    ) {
      sink[Symbol.dispose]();
      throw new Error("expectedIncarnation must be null or a non-empty string");
    }
    if (
      args.expectedIncarnation !== undefined &&
      (coreState.createdAt ?? null) !== args.expectedIncarnation
    ) {
      sink[Symbol.dispose]();
      throw new Error(
        `stream incarnation changed (${String(args.expectedIncarnation)} -> ${String(coreState.createdAt ?? null)})`,
      );
    }
    if (
      args.maxReplayOffsetGap !== undefined &&
      (!Number.isSafeInteger(args.maxReplayOffsetGap) || args.maxReplayOffsetGap < 0)
    ) {
      sink[Symbol.dispose]();
      throw new Error("maxReplayOffsetGap must be a non-negative safe integer");
    }
    // State-only subscriptions are implicitly live-from-now: replay without
    // events is meaningless, so replayAfterOffset is ignored in that mode.
    let cursor = deliverEvents ? (args.replayAfterOffset ?? openedAtOffset) : openedAtOffset;
    if (cursor > openedAtOffset) {
      sink[Symbol.dispose]();
      throw new Error(`replayAfterOffset ${cursor} is ahead of the stream head ${openedAtOffset}`);
    }
    if (
      deliverEvents &&
      args.maxReplayOffsetGap !== undefined &&
      openedAtOffset - cursor > args.maxReplayOffsetGap
    ) {
      sink[Symbol.dispose]();
      throw new Error(
        `replay gap ${openedAtOffset - cursor} exceeds maxReplayOffsetGap ${args.maxReplayOffsetGap}`,
      );
    }

    // Replacing any existing connection for this key only after the proposed
    // open is valid; a rejected bounded replay must leave the live one intact.
    this.#connections.get(subscriptionKey)?.close("replaced");
    let initialBatchPending = true;
    let draining = false;
    let open = true;

    const pump = async () => {
      if (draining) return;
      draining = true;
      try {
        while (open) {
          let events: StreamEvent[] = [];
          let deliveredBytes = 0;
          const scannedAfterOffset = cursor;
          if (deliverEvents) {
            // Same byte-capped read as the push drain: a batch of near-2MB
            // events in one live frame would blow the RPC frame limit and turn
            // into a delivery failure the subscriber can never get past.
            const readEvents = this.#readBatch(cursor, DELIVERY_BATCH_LIMIT);
            const lastOffset = readEvents.at(-1)?.event.offset;
            if (lastOffset === undefined) {
              // An evicted ephemeral suffix has no surviving row to carry its
              // scan coordinate. The synchronous allocator head proves the
              // absent interval, so emit one empty envelope across it. This is
              // what lets filtered processors durably checkpoint through old
              // chunks without ever replaying them.
              const currentHead = this.#hooks.coreState().maxOffset;
              if (currentHead <= cursor && !initialBatchPending) return;
              cursor = Math.max(cursor, currentHead);
            } else {
              cursor = lastOffset;
              // Configured (wake) connections are a durable lane: ephemerals
              // never reach them. Session subscriptions receive ephemerals
              // only when they were committed AFTER this connection's atomic
              // open boundary; historical ephemerals are never replayed.
              const visible =
                subscriptionType === "configured"
                  ? readEvents.filter((entry) => entry.event.ephemeral !== true)
                  : readEvents.filter(
                      (entry) =>
                        entry.event.ephemeral !== true || entry.event.offset > openedAtOffset,
                    );
              const delivered =
                args.selector === undefined
                  ? visible
                  : visible.filter((entry) => selectorMatchesSafely(args.selector!, entry.event));
              events = delivered.map((entry) => entry.event);
              deliveredBytes = delivered.reduce((sum, entry) => sum + entry.byteLength, 0);
            }
          } else {
            const stateMaxOffset = this.#hooks.coreState().maxOffset;
            if (stateMaxOffset <= cursor && !initialBatchPending) return;
            cursor = stateMaxOffset;
          }
          initialBatchPending = false;
          connection.batchesSent += 1;
          connection.eventsSent += events.length;
          connection.bytesSent += deliveredBytes;
          connection.lastDeliveredAt = new Date(this.#hooks.now()).toISOString();
          this.#hooks.recordEgress(events.length, deliveredBytes);
          const currentState = this.#hooks.coreState();
          if (currentState.projectId === undefined || currentState.path === undefined) {
            throw new Error(
              "Cannot deliver stream batch before stream coordinates are initialized.",
            );
          }
          // Wake-lane batches have their results pulled anyway (corpse
          // detection), and their NEXT frame is gated on that settle. Sending
          // two frames concurrently is data loss when the receiver serializes
          // them: if frame N rejects, queued frame N+1 can otherwise commit a
          // cursor beyond N without containing N's events. This exact race
          // skipped a fresh project's birth certificate in preview on
          // 2026-07-16. Ephemeral results stay unpulled and ungated: no
          // onSettled ever fires there (see subscriber-sinks.ts).
          const newestCreatedAtMs =
            events.length === 0 ? undefined : Date.parse(events.at(-1)!.createdAt);
          const batch = {
            projectId: currentState.projectId,
            path: currentState.path,
            events,
            scannedAfterOffset,
            scannedThroughOffset: cursor,
            streamMaxOffset: currentState.maxOffset,
            // Read in the same synchronous block as streamMaxOffset, so the
            // two always correspond (state-at-streamMaxOffset; see rpc-types.ts).
            state: currentState,
          } satisfies StreamEventBatch;
          if (subscriptionType === "configured") {
            const settlement = new Promise<"ok" | "error">((resolve) => {
              sink(batch, {
                onSettled: (outcome) => {
                  if (
                    outcome === "ok" &&
                    newestCreatedAtMs !== undefined &&
                    Number.isFinite(newestCreatedAtMs)
                  ) {
                    const settledAtMs = this.#hooks.now();
                    connection.settleLatency.record(settledAtMs - newestCreatedAtMs, settledAtMs);
                  }
                  resolve(outcome);
                },
              });
            });
            let outcome: "ok" | "error";
            try {
              outcome = await withDeliveryTimeout(settlement, `wake delivery ${subscriptionKey}`);
            } catch (error) {
              this.onDurableDeliveryError(subscriptionKey, error);
              return;
            }
            // A remote rejection runs onDurableDeliveryError from the retained
            // sink before reporting "error" here; either way the connection is
            // closed and its receiver checkpoint remains the replay authority.
            if (outcome !== "ok" || !open) return;
          } else {
            sink(batch);
          }
          await Promise.resolve();
        }
      } finally {
        draining = false;
      }
    };

    const connection: Connection = {
      subscriptionType,
      startedAt: new Date(this.#hooks.now()).toISOString(),
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
      wake: () => void pump(),
      isLive: () => open,
      hasPendingDelivery: () => (sink.pendingDeliveries?.() ?? 0) > 0,
      close: (reason, recordFact = true) => {
        if (!open) return;
        open = false;
        if (this.#connections.get(subscriptionKey) === connection) {
          this.#connections.delete(subscriptionKey);
        }
        // The ping stub proxies through the same chain the sink retains
        // (wake lane), so it releases before the sink tears that chain down.
        connection.ping?.[Symbol.dispose]();
        sink[Symbol.dispose]();
        connection.getProcessorRuntimeState?.[Symbol.dispose]();
        if (recordFact) {
          this.#hooks.appendFact({
            type: "events.iterate.com/stream/subscriber-disconnected",
            payload: { subscriptionKey, reason },
          });
        }
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
    this.#hooks.appendFact({
      type: "events.iterate.com/stream/subscriber-connected",
      payload: {
        subscriptionKey,
        subscriptionType,
        ...(args.presence === undefined ? {} : { subscriber: args.presence }),
      },
    });
    sink.onRpcBroken?.(() => connection.close("rpc-broken"));
    connection.wake();
    return connection;
  }

  /**
   * Durable-sink delivery failures arrive here (see subscriber-sinks.ts).
   * Backoff FIRST, close second: the close's disconnect fact triggers a wake
   * whose reconcile must already see the nack'd row — otherwise it re-pokes
   * immediately and a deterministic subscriber failure becomes an RPC-rate
   * poke→deliver→close hot loop that never parks. The shared failure machine
   * counts the streak (the poke-success watermark deliberately preserves it;
   * see #poke) and parks at the same threshold as every other lane.
   */
  onDurableDeliveryError(subscriptionKey: string, error: unknown): void {
    const connection = this.#connections.get(subscriptionKey);
    if (connection === undefined) return;
    console.error("stream durable sink delivery failed; backing off before re-poke", {
      subscriptionKey,
      error,
    });
    this.#onDeliveryFailure(subscriptionKey, error);
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
   * Keep the in-memory idle timer armed only while durable delivery
   * connections exist (the thing that pins the DO resident). Reset on every
   * append; cleared once no durable connection remains. No storage writes,
   * and nothing scheduled against a hibernated DO.
   */
  armOrClearIdleTimer(): void {
    if (this.#idleTimer !== undefined) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = undefined;
    }
    if (this.#configuredConnectionKeys().length === 0) return;
    this.#idleTimer = setTimeout(() => this.runIdleTeardownNow(), this.#idleTeardownMs);
  }

  /**
   * Deliberately drops every live durable delivery connection so a quiet
   * stream stops pinning subscriber DOs with idle cross-isolate RPC sessions.
   * The durable subscription config is kept, so the next append re-pokes.
   * The idle timer's action, also exposed for tests / operator use.
   */
  runIdleTeardownNow(): void {
    this.#idleTimer = undefined;
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

/** A selector error during LIVE delivery skips the event; live lanes never append error facts per event. */
function selectorMatchesSafely(selector: CompiledEventSelector, event: StreamEvent): boolean {
  try {
    return selector.matches(event);
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)) || "unknown error";
}
