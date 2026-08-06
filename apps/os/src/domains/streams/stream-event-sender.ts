// Stored subscriptions: configuration, receiver calls, source-stored cursors,
// and failing-event retries. Live callback sends, connection
// generations, ping metrics, and idle
// teardown are the independent StreamConnections state machine at the bottom
// of this file.
//
// Every receiver gets stream events through one of these mechanics:
//
// | receiver kind    | operation                                      | acknowledgement       |
// |------------------|------------------------------------------------|-----------------------|
// | session callback | call the callback from `openConnection()`      | result stays unpulled |
// | hosted processor | wake it, retain its returned callback          | processor checkpoint  |
// | copy       | append copies to another Stream Durable Object | receiving append      |
// | ITX expression   | evaluate and await the named method             | method result          |
// | webhook          | send one attributed HTTP POST per event         | 2xx response           |
//
// Session connections are forgotten when they close (a wake-socket-backed
// session's dormancy lives on in its socket attachment — wake-socket.ts —
// never in this module's memory).
// Stored subscriptions are stored configuration — the directional events
// reduced into core state. Delivery uses one SQLite cursor row per subscription
// (stream-storage.ts) plus the Durable Object alarm for retries. Cursor rows
// are mutable storage; halt/resume transitions are appended events
// (`subscription-delivery-halted` / `subscription-delivery-resumed`). The
// delivery loop starts from cursor lag — never from event types — so appended
// events stay data, not control flow.
//
// Runtime metrics: every connection carries real counters (events/bytes
// sent, lag from cursor), durable sends record commit→acknowledgement
// latency on the stream's own clock (hosted: the processor reports its result;
// copy/ITX/webhook: the receiver call returns), and callback owners that hand over a ping capability
// get NTP-style RTT sampled when runtime observation begins, throttled, and
// purely observational (a failed ping drops the sample, nothing else).
// Session-callback consumption is deliberately NOT measured here: those results stay
// unread (zero returned event batches), and the receiving processor reports through
// its getRuntimeState capability instead (see event-consumption-metrics.ts).
//
// This module is transport-free, clock-free, and randomness-free: everything
// it touches arrives through `StreamEventSenderHooks` (storage, log reads, the
// calls to receivers, time, backoff jitter, and the alarm). Subscription behavior is proven at
// the public seam in stream-connections-and-subscriptions.e2e.test.ts; the only streams code
// that knows RPC exists is the receiver-call wiring in stream-durable-object.ts.

import type { StreamEvent, StreamEventInput } from "iterate/processors";
import type {
  GetProcessorRuntimeState,
  ProcessEventBatch,
  ProcessorRuntimeState,
  StreamDeliveryBatch,
  StreamEventBatch,
  CopyReceipt,
  StreamConnectionPing,
  StreamProcessorWakeRequest,
  StreamWakeDeliveryError,
  StreamWakeDeliveryResult,
  StreamWakeEventBatch,
  StreamWebhookDelivery,
} from "iterate/processors";
import { isStreamReceiverUnavailableError } from "iterate/processors";
import { LatencyRing, pingRoundTrip, type LatencyStats } from "iterate/processors";
import type { ItxExpression } from "../../itx/expression.ts";
import type {
  CoreProcessorState,
  SubscriptionConfiguredPayload,
  SubscriptionReceiver,
  SubscriptionStart,
  ConnectionOpenerDescriptor,
  ConnectionCloseReason,
  StreamConnectionKind,
} from "./core-processor-contract.ts";
import {
  ConnectionOpenerDescriptor as ConnectionOpenerDescriptorSchema,
  subscriptionConfigurationForDelivery,
  subscriptionConfiguredPayloadFromReducedState,
} from "./core-processor-contract.ts";
import {
  applyJsonataTransform,
  compileEventFilter,
  EventFilterEvaluationError,
  type CompiledEventFilter,
} from "./event-filter.ts";
import {
  boundedErrorMessage,
  DEFAULT_DELIVERY_TIMEOUT_MS,
  errorMessage,
  hasStructuredIdPrefix,
  internalStreamId,
  internalStreamIdPrefix,
  structuredId,
  withDeliveryTimeout,
} from "./stream-delivery-utils.ts";
import type { SizedStreamEvent, SubscriptionCursorStore } from "./stream-storage.ts";
import {
  retainGetProcessorRuntimeState,
  retainProcessEventBatch,
  retainConnectionPing,
  type RetainedProcessEventBatch,
  type RetainedConnectionPing,
  type RetainedProcessorWakeResponse,
} from "./retained-event-callbacks.ts";
import {
  isDurableObjectLifecycleError,
  isRetryableDurableObjectAvailabilityError,
} from "./stream-unavailable.ts";

// =============================================================================
// Delivery math: pure retry and batch-size calculations. Every function here
// is a pure function of its arguments — no clocks, no randomness (both are
// parameters), no storage — so the delivery loop's bits are table-testable in
// plain node without fakes.
// =============================================================================

/**
 * Consecutive failures after which a subscription halts. With the backoff
 * below this tolerates roughly 2–2.5 hours of continuous receiver outage before
 * giving up loudly (an `subscription-delivery-halted` event + a red row in the
 * UI); `subscription-delivery-resumed` is one itx call away.
 */
const MAX_DELIVERY_ATTEMPTS = 15;

/**
 * Confirmations required before an `onFailingEvent: "skip"` subscription declares a
 * single event is consistently failing and steps over it: the same event must fail this many
 * consecutive deliveries after the batch-size-1 read isolated it.
 */
const FAILING_EVENT_CONFIRM_ATTEMPTS = 3;

/**
 * Failing events skipped in a row (no intervening success) after which a
 * skip-mode subscription halts anyway: three consecutive event failures are
 * indistinguishable from "the receiver is down and everything fails", and
 * mass-skipping a down receiver's backlog would be silent data loss.
 */
const MAX_FAILING_EVENT_SKIPS_SINCE_LAST_SUCCESS = 3;

/**
 * Events per delivery batch. The byte cap below is the real batch guard; this
 * count cap keeps one send pass a bounded read. 1000 small
 * events ≈ 300KB — measured about 10× fewer callback calls and 4× faster browser
 * SQLite ingest than the previous 100 on catch-up-heavy workloads.
 */
const DELIVERY_BATCH_LIMIT = 1000;

/**
 * Hosted processors can turn one event into arbitrary Durable Object and
 * external work. Give each matching event its own acknowledgement boundary so
 * a slow event cannot make already-processed siblings time out and replay.
 * Matching work is deliberately one-at-a-time. The separate scan limit keeps
 * reconstructing and filtering a noisy source from filling the source Durable
 * Object's memory before that one-event boundary can help.
 */
const HOSTED_CALLBACK_EVENT_LIMIT = 1;
const HOSTED_SCAN_EVENT_LIMIT = 100;

/** Soft cap on a delivery batch's payload bytes (large events shrink the batch). */
const DELIVERY_BATCH_BYTE_LIMIT = 1024 * 1024;

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 30 * 60_000;
const BACKOFF_JITTER = 0.2;

/**
 * Exponential backoff with ±20% jitter: 1s, 2s, 4s … capped at 30 minutes.
 * `attempt` is 1-based (the first failure schedules the first retry).
 * `random` is injected (0..1) so tests are deterministic and the jitter that
 * prevents thundering-herd retries into one project worker stays testable.
 */
export function computeBackoffMs(attempt: number, random: number): number {
  const base = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));
  const jitter = 1 + BACKOFF_JITTER * (random * 2 - 1);
  return Math.round(base * jitter);
}

/** The initial exclusive cursor for a copy, ITX-call, or webhook subscription. */
function initialCursor(start: SubscriptionStart, configuredEventOffset: number): number {
  return start === "now" ? configuredEventOffset : 0;
}

/**
 * The one place receiver-specific initial cursor policy is spelled out:
 * hosted-processor rows start at 0 (the stored value means "the processor reported
 * a checkpoint through N", and a processor that has never been woken has observed nothing);
 * copy, ITX-call, and webhook rows start where their delivery policy says.
 */
function initialCursorFor(config: SubscriptionConfiguredPayload, configOffset: number): number {
  return config.receiver.action === "processor-wake"
    ? 0
    : initialCursor(config.receiver.delivery.start, configOffset);
}

/**
 * Stable delivery id for one exact batch window in one cursor epoch. Retrying
 * that window keeps the id; narrowing it or widening it to a newer tail event
 * produces a different id.
 */
export function deliveryId(
  streamId: string,
  subscriptionKey: string,
  cursorChangedAtSourceOffset: number,
  firstOffset: number,
  lastOffset: number,
) {
  return structuredId(
    "delivery",
    streamId,
    subscriptionKey,
    cursorChangedAtSourceOffset,
    firstOffset,
    lastOffset,
  );
}

/** Short, bounded retry when a Durable Object lifecycle turn interrupts a required event append. */
const LIFECYCLE_RETRY_DELAY_MS = 1_000;

/** Serializable debug view of one stored subscription's cursor row, for `runtimeState()`. */
export type SubscriptionRuntimeState = {
  /** Exclusive. Source-owned acknowledged offset or hosted processor's last reported checkpoint. */
  acknowledgedOffset: number;
  /** `maxOffset - acknowledgedOffset`, per subscription. */
  lag: number;
  attempt: number;
  nextAttemptAt: number | null;
  inFlightDeadlineAt: number | null;
  lastError: string | null;
  /** Serialized payload bytes delivered by copy, ITX-call, and webhook subscriptions. */
  bytesSent?: number;
  /** Commit-to-acked latency (stream clock): newest event `createdAt` → awaited delivery resolved. */
  completionLatencyMs?: LatencyStats;
  /** Duration of the awaited copy, ITX, or webhook call itself. */
  deliveryDurationMs?: LatencyStats;
};

/**
 * One explicit call per receiver variant. Hosted-processor wake and
 * ITX-expression delivery both evaluate an ITX expression against the
 * stream's fresh authority root; only wake returns a callback to retain.
 */
export type SubscriptionReceiverCalls = {
  /** Start or revive a hosted processor and retain its returned callback. */
  wakeStreamProcessor(
    expression: ItxExpression,
    request: StreamProcessorWakeRequest,
    expectedDelivery: ExpectedHostedDeliveryState,
  ): Promise<RetainedProcessorWakeResponse>;
  /** Evaluate an ITX receiver expression and invoke it. Resolve = acknowledgement. */
  deliverToItx(expression: ItxExpression, batch: StreamDeliveryBatch): Promise<void>;
  /** Deliver a batch to a stream, which appends source.copiedFrom to each event. */
  copyToStream(path: string, batch: StreamDeliveryBatch): Promise<CopyReceipt>;
  /** POST one event to the webhook URL. Resolve (2xx) = ack; non-2xx rejects. */
  deliverToWebhook(url: string, delivery: StreamWebhookDelivery): Promise<void>;
};

/** The policy/storage seams the owning Stream Durable Object provides. */
type StreamEventSenderHooks = {
  /**
   * Synchronous committed-event range read from stream storage, sized: each
   * event arrives with its serialized byte length so batch construction can
   * enforce the byte cap without re-stringifying what storage just parsed.
   */
  readEvents(args: {
    afterOffset: number;
    beforeOffset: number;
    limit: number;
  }): SizedStreamEvent[];
  /** Current core reduced state, read in the same synchronous block as each delivery. */
  coreState(): CoreProcessorState;
  /** Durable cursor rows in SQLite next to the event log. */
  store: SubscriptionCursorStore;
  /** Concrete calls to the configured receiver (see {@link SubscriptionReceiverCalls}). */
  receiverCalls: SubscriptionReceiverCalls;
  /**
   * Append an event produced by delivery (connection, halt, or failing-event error
   * records). Returns false only when Durable Object lifecycle teardown
   * interrupts the append; unexpected failures remain product defects and
   * throw. Callers that depend on the event must arrange a durable retry.
   */
  appendDeliveryEvent(event: StreamEventInput): boolean;
  /**
   * Send-throughput accounting: called once per call to a receiver with
   * the event count and serialized payload bytes it carried.
   */
  recordEgress(count: number, bytes: number): void;
  /** An in-memory runtime-debug field changed; refresh the observed state. */
  runtimeChanged(): void;
  /** Injected absolute wall-clock time in milliseconds. */
  now(): number;
  /** Injected randomness (backoff jitter); [0, 1) like Math.random. */
  random(): number;
  /** Arm the Durable Object alarm for the earliest pending retry. */
  armAlarm(atMs: number): void;
  /**
   * Delete the pending Durable Object alarm; called only when the full
   * recomputation found NOTHING needing a future turn (no due or in-flight
   * cursor rows, no idle deadline). Lets a quiet stream sleep until a real
   * touch instead of being booted forever by its last send's watchdog.
   */
  clearAlarm(): void;
  /**
   * Run durable delivery in its alarm-owned invocation. The production Stream
   * DO schedules an immediate alarm when called from an append and runs the
   * closure only when delivery is already running inside that alarm turn.
   */
  runDurable(work: () => Promise<unknown>): void;
  /** Keep the Durable Object alive through background delivery work. */
  keepAlive(promise: Promise<unknown>): void;
  /**
   * connectionKeys with a live hibernatable wake channel (wake-socket.ts).
   * Only such session connections are idle-teardown-eligible: severing a
   * session callback with no wake channel would strand the subscriber with
   * no way to learn about new events.
   */
  wakeChannelKeys(): ReadonlySet<string>;
  /**
   * Idle teardown just closed these session connections; ensure this
   * teardown's own close facts can never wake the subscribers they closed.
   * Called AFTER the close-fact appends, mirroring the hosted cursor ack.
   */
  onSessionsIdleClosed(connectionKeys: readonly string[]): void;
  /**
   * Post-commit: offer just-committed events to dormant wake-channel
   * subscribers (wake-socket.ts). Edge-triggered by design — a frame lost to
   * a crash between commit and send is repaired by the next qualifying
   * append (or the relay's liveness probe), never by the repair alarm.
   */
  wakeDormantSubscribers(justCommitted: SizedStreamEvent[]): void;
};

export class StreamEventSender {
  readonly #hooks: StreamEventSenderHooks;
  /** The live-callback state machine (session + hosted callbacks); see below. */
  readonly connections: StreamConnections;

  // In-memory state for durable sending. All of it is reconstructible: a DO eviction
  // resets these and the durable rows + folded config re-derive every decision
  // (at-least-once absorbs the repeats).
  readonly #hostedWakesInFlight = new Set<string>();
  /**
   * Hosted callbacks deliberately closed after an idle, fully-settled period.
   * Keep them closed until this source appends something new. This is
   * incarnation-local: after eviction a redundant wake is safe, while a
   * same-turn idle close followed by an immediate wake would create an
   * unbounded open/close alarm loop on a quiet stream.
   */
  readonly #hostedIdledAtOffset = new Map<
    string,
    { configuredAtOffset: number; sourceOffset: number }
  >();
  #nextHostedConnectionGeneration = 0;
  readonly #sourceOwnedSendsInFlight = new Set<string>();
  /**
   * Subscriptions whose last delivery attempt failed: the next read uses
   * batch limit 1 (isolate-or-progress — a healthy prefix commits one event
   * at a time until the poison event fails alone), resetting to
   * DELIVERY_BATCH_LIMIT on success.
   */
  readonly #limitNextReadToOne = new Set<string>();
  /**
   * Per-subscription delivery metrics for copy, ITX-call, and webhook
   * actions: the awaited call is the acknowledgement, so the stream is the only
   * observer of these callback owners' consumption. In-memory like every other
   * runtime metric; cleaned up with the subscription.
   */
  readonly #subscriptionMetrics = new Map<
    string,
    { completionLatency: LatencyRing; deliveryDuration: LatencyRing; bytesSent: number }
  >();
  constructor(args: { idleTeardownMs: number; hooks: StreamEventSenderHooks }) {
    this.#hooks = args.hooks;
    this.connections = new StreamConnections({
      idleTeardownMs: args.idleTeardownMs,
      hooks: {
        ...args.hooks,
        readBatch: (afterOffset, beforeOffset, limit) =>
          this.#readBatch(afterOffset, beforeOffset, limit),
        hostedDeliveryStillMatches: (subscriptionKey, expectedDelivery) =>
          this.#deliveryStillMatches(subscriptionKey, expectedDelivery),
        onHostedDeliveryFailure: (subscriptionKey, error) =>
          this.#onDeliveryFailure(subscriptionKey, error),
        sendDueSubscriptions: () => this.sendDue(),
        reconcileAlarm: () => this.reconcileAlarmAfterSettlement(),
      },
    });
  }

  // ===========================================================================
  // The one send check: called post-commit and from the DO alarm.
  // ===========================================================================

  /**
   * The just-committed events of the most recent append, handed over by the
   * commit path so caught-up callback loops and durable subscription send loops consume
   * them directly instead
   * of re-reading (and re-parsing) them from SQLite once per subscription.
   * Correctness is offset-gated, never freshness-gated: `#readBatch` uses the
   * array only when its first offset is exactly `afterOffset + 1`, so an old
   * array (more appends since, a rewound cursor) either still is the right
   * contiguous window or self-disqualifies and falls back to storage.
   */
  #justCommittedEvents: SizedStreamEvent[] = [];
  #consecutiveSendStartFailures = 0;

  /**
   * Ask every live callback to send queued events and start each durable send
   * that is due: wake lagging hosted processors without a callback and send
   * pending copy, ITX-call, or webhook events. Never throws; never blocks the append.
   *
   * `justCommittedEvents` is the new-event fast path: append passes what it just
   * committed (already sized by the log write) so caught-up callbacks skip the
   * storage round trip.
   */
  sendDue(justCommittedEvents?: SizedStreamEvent[]): boolean {
    if (justCommittedEvents !== undefined && justCommittedEvents.length > 0)
      this.#justCommittedEvents = justCommittedEvents;
    try {
      const state = this.#hooks.coreState();
      this.connections.closeStaleHosted((connectionKey) =>
        state.subscriptions.outbound.byKey[connectionKey] === undefined
          ? "subscription-removed"
          : "replaced",
      );
      this.connections.sendQueued();
      if (this.connections.isTearingDown) {
        // Also guards the dormant-wake offer below: close-fact appends during
        // teardown must not fan back out to the subscribers they closed.
        this.#armAlarmFromStore();
        this.#consecutiveSendStartFailures = 0;
        return true;
      }
      if (justCommittedEvents !== undefined && justCommittedEvents.length > 0) {
        this.#hooks.wakeDormantSubscribers(justCommittedEvents);
      }
      this.#sendDueSubscriptions();
      // A new Durable Object incarnation cannot trust an in-memory notion of
      // which native alarm is already armed. Recompute the earliest durable
      // delivery obligation after every send check so a later deadline or
      // idle timer can never overwrite a nearer persisted retry.
      this.#armAlarmFromStore();
      this.#consecutiveSendStartFailures = 0;
      return true;
    } catch (error) {
      console.error("starting due subscription deliveries failed", error);
      // Every decision above is recoverable from reduced configuration plus
      // durable cursor rows. Arrange a fresh turn even if this stream now goes
      // quiet; the append caller must not own or observe this bookkeeping
      // failure after its event rows committed.
      try {
        this.#consecutiveSendStartFailures += 1;
        this.#hooks.armAlarm(
          this.#hooks.now() +
            computeBackoffMs(this.#consecutiveSendStartFailures, this.#hooks.random()),
        );
      } catch (alarmError) {
        console.error("arming subscription repair alarm failed", alarmError);
      }
      return false;
    }
  }

  /** The DO alarm handler body: retry whatever is due, then re-arm. */
  onAlarm(): boolean {
    this.#rememberIdleHostedCallbacks(this.connections.onAlarm());
    this.#failExpiredHostedDeliveries();
    return this.sendDue();
  }

  // ===========================================================================
  // Durable sending: hosted-processor wake, copy/ITX/webhook sends, retries,
  // and halting.
  // ===========================================================================

  /**
   * For each configured durable configuration: ensure its cursor row exists
   * (rows are storage, not event-derived), stop if it is halted or backing off,
   * then wake its hosted processor or send its pending events.
   */
  #sendDueSubscriptions(): void {
    const state = this.#hooks.coreState();
    const now = this.#hooks.now();
    const configuredSubscriptionKeys = new Set(Object.keys(state.subscriptions.outbound.byKey));

    // Cursor rows and in-memory retry state are mutable projections of the
    // reduced configuration. Remove anything whose subscription no longer exists on
    // every send check, not only on the event edge or after an eviction.
    for (const row of this.#hooks.store.list()) {
      if (configuredSubscriptionKeys.has(row.subscriptionKey)) continue;
      this.#hooks.store.delete(row.subscriptionKey);
      this.#limitNextReadToOne.delete(row.subscriptionKey);
      this.#subscriptionMetrics.delete(row.subscriptionKey);
      this.#hostedIdledAtOffset.delete(row.subscriptionKey);
    }

    for (const [subscriptionKey, entry] of Object.entries(state.subscriptions.outbound.byKey)) {
      const config = entry.configuration;
      const configOffset = entry.configuredAtOffset;

      // The receiver-specific initial-cursor policy lives in ONE place
      // (initialCursorFor above) so boot recovery and ordinary
      // post-commit reconciliation cannot drift.
      this.#hooks.store.ensure(
        subscriptionKey,
        initialCursorFor(config, configOffset),
        configOffset,
      );

      // A cursor-set event is durable intent. Apply the newest request whenever
      // reduced state is ahead of the mutable cursor row; this repairs an
      // interruption after the event committed and makes older seeks unable to
      // rewind a newer cursor generation.
      let row = this.#hooks.store.get(subscriptionKey);
      if (
        entry.cursorSet !== undefined &&
        config.receiver.action !== "processor-wake" &&
        row !== undefined &&
        row.cursorChangedAtOffset < entry.cursorSet.setAtSourceOffset
      ) {
        this.#hooks.store.setCursor(
          subscriptionKey,
          entry.cursorSet.afterOffset,
          entry.cursorSet.setAtSourceOffset,
        );
        row = this.#hooks.store.get(subscriptionKey);
      }

      if (entry.deliveryHalted !== undefined) continue;

      if (row === undefined) continue; // unreachable after ensure; defensive
      if (row.inFlightDeadlineAt !== null) {
        this.#hooks.armAlarm(row.inFlightDeadlineAt);
        continue;
      }
      if (row.nextAttemptAt !== null && row.nextAttemptAt > now) continue; // alarm owns it
      if (config.receiver.action === "processor-wake") {
        if (
          this.connections.has(subscriptionKey) ||
          this.#hostedWakesInFlight.has(subscriptionKey)
        ) {
          continue;
        }
        const idled = this.#hostedIdledAtOffset.get(subscriptionKey);
        if (idled?.configuredAtOffset === configOffset && state.maxOffset <= idled.sourceOffset) {
          continue;
        }
        this.#hostedIdledAtOffset.delete(subscriptionKey);
        this.#wakeStreamProcessor(subscriptionKey, config.receiver, {
          configuredAtOffset: configOffset,
          cursorChangedAtOffset: row.cursorChangedAtOffset,
          connectionGeneration: ++this.#nextHostedConnectionGeneration,
        });
        continue;
      }

      if (row.acknowledgedOffset >= state.maxOffset) continue; // caught up; nothing to send

      if (this.#sourceOwnedSendsInFlight.has(subscriptionKey)) continue;
      this.#sendPendingSourceOwnedEvents(subscriptionKey);
    }
  }

  /**
   * Wake a hosted processor and ask it for its checkpoint and live callback,
   * then send events after that checkpoint. The entire
   * wake response is this single call — the stream initiated it and owns the
   * returned callback, so there is no second callback-registration race. If wake resolves
   * after its subscription was replaced (or switched to copy, ITX-call, or webhook),
   * drop that callback rather than open a dead connection or acknowledge the new cursor.
   */
  #wakeStreamProcessor(
    subscriptionKey: string,
    receiver: Extract<SubscriptionReceiver, { action: "processor-wake" }>,
    expectedDelivery: ExpectedHostedDeliveryState,
  ): void {
    const state = this.#hooks.coreState();
    if (state.projectId === undefined || state.path === undefined || state.streamId === undefined) {
      throw new Error("Cannot wake a hosted processor before stream identity is initialized.");
    }
    const request: StreamProcessorWakeRequest = {
      stream: {
        projectId: state.projectId,
        path: state.path,
        streamId: state.streamId,
        streamMaxOffset: state.maxOffset,
      },
      subscriptionKey,
      ...(receiver.processorSlug === undefined ? {} : { processorSlug: receiver.processorSlug }),
    };

    this.#hooks.runDurable(async () => {
      if (this.#hostedWakesInFlight.has(subscriptionKey)) return;
      this.#hostedWakesInFlight.add(subscriptionKey);
      try {
        if (!this.#deliveryStillMatches(subscriptionKey, expectedDelivery)) return;
        // Persist the watchdog BEFORE the remote call leaves this Durable
        // Object. The output gate then guarantees a receiver cannot observe
        // the request until the future wake is durable; arming only after the
        // call started leaves a kill/deploy window that can strand the row.
        this.#armInFlightWatchdog();
        // A wake call that outlives its timeout still eventually settles with a
        // RETAINED processEventBatch; dropping that undisposed would leak a session-pinning
        // callback on exactly the wedged-connection occasions the timeout exists
        // for. The late-settle hook disposes it (thermo round 2, blocker 4b).
        const wakePromise = this.#hooks.receiverCalls.wakeStreamProcessor(
          receiver.expression,
          request,
          expectedDelivery,
        );
        const response = await withDeliveryTimeout(
          wakePromise,
          `wake hosted processor ${subscriptionKey}`,
          { onLateResolve: (late) => late.processEventBatch[Symbol.dispose]() },
        );
        const current = this.#hooks.coreState().subscriptions.outbound.byKey[subscriptionKey];
        if (
          !this.#deliveryStillMatches(subscriptionKey, expectedDelivery) ||
          current?.configuration.receiver.action !== "processor-wake"
        ) {
          response.processEventBatch[Symbol.dispose]();
          // This wake response no longer matches, but the current configuration
          // may still have events to send. Wake it after this in-flight call is
          // released rather than waiting for another append on a quiet stream.
          queueMicrotask(() => this.sendDue());
          return;
        }
        const currentMaxOffset = this.#hooks.coreState().maxOffset;
        if (response.streamId !== request.stream.streamId) {
          response.processEventBatch[Symbol.dispose]();
          throw new Error(
            `hosted processor checkpoint belongs to stream ID ${response.streamId}, expected ${request.stream.streamId}`,
          );
        }
        if (response.checkpointOffset > currentMaxOffset) {
          response.processEventBatch[Symbol.dispose]();
          throw new Error(
            `hosted processor checkpoint ${response.checkpointOffset} is beyond this stream's current maximum offset ${currentMaxOffset}`,
          );
        }
        let openedBy: ConnectionOpenerDescriptor | undefined;
        try {
          openedBy =
            response.openedBy === undefined
              ? undefined
              : ConnectionOpenerDescriptorSchema.parse(response.openedBy);
        } catch (error) {
          // Reject the malformed descriptor WITHOUT leaking the processEventBatch retained
          // moments earlier (round-1 finding 4.2 / round-2 blocker 4a).
          response.processEventBatch[Symbol.dispose]();
          throw error;
        }
        // Both filters apply. The durable configuration can narrow what this
        // one delivery receives; the processor announcement is the outer bound
        // of event types the callback says it can handle.
        const consumes = openedBy?.processor?.announcement.consumes;
        const configuredFilter = compileEventFilter(current.configuration.filter);
        const announcedFilter =
          consumes === undefined ? undefined : compileEventFilter({ eventTypes: [...consumes] });
        const connection = this.connections.openHosted({
          connectionKey: subscriptionKey,
          expectedHostedDelivery: expectedDelivery,
          processEventBatch: response.processEventBatch,
          replayAfterOffset: response.checkpointOffset,
          filter: {
            matches(event) {
              return (
                configuredFilter.matches(event) &&
                (announcedFilter === undefined || announcedFilter.matches(event))
              );
            },
          },
          openedBy,
          getRuntimeState: response.getRuntimeState,
          ping: response.ping,
        });
        // Last reported checkpoint: the callback owner confirmed this checkpoint.
        // While the connection streams, the stored checkpoint deliberately goes stale;
        // its only job is deciding whether to wake the processor when no callback exists.
        // A successful wake response proves the host is reachable, not that
        // deliveries succeed — so it must not clear the delivery-failure
        // streak by itself (that reset let a deterministically failing
        // callback owner wake forever without ever halting). PROGRESS clears
        // it: a checkpoint past the last reported checkpoint means deliveries have been
        // digested since the failure.
        const checkpointRow = this.#hooks.store.get(subscriptionKey);
        if (
          checkpointRow === undefined ||
          response.checkpointOffset > checkpointRow.acknowledgedOffset
        ) {
          this.#hooks.store.ack(subscriptionKey, response.checkpointOffset, {
            cursorChangedAtOffset: expectedDelivery.cursorChangedAtOffset,
          });
        } else {
          this.#hooks.store.recordReportedCheckpoint(subscriptionKey, response.checkpointOffset);
        }
        connection.sendQueued();
      } catch (error) {
        if (this.#deliveryStillMatches(subscriptionKey, expectedDelivery)) {
          this.#onDeliveryFailure(subscriptionKey, error);
        } else {
          queueMicrotask(() => this.sendDue());
        }
      } finally {
        this.#hostedWakesInFlight.delete(subscriptionKey);
        this.reconcileAlarmAfterSettlement();
      }
    });
  }

  /**
   * Send pending events for one copy, ITX-call, or webhook configuration:
   * read after the cursor, apply the filter (skip-not-defer — the
   * cursor advances past non-matching events), deliver, and advance the
   * cursor when the awaited call resolves. That resolution IS the
   * acknowledgement, which is why the stream can own these cursors. Stream
   * and ITX receivers receive batches; webhooks receive one event at a time.
   */
  #sendPendingSourceOwnedEvents(subscriptionKey: string): void {
    this.#hooks.runDurable(async () => {
      if (this.#sourceOwnedSendsInFlight.has(subscriptionKey)) return;
      this.#sourceOwnedSendsInFlight.add(subscriptionKey);
      let activeDeliveryState: ExpectedDeliveryState | undefined;
      try {
        for (;;) {
          const state = this.#hooks.coreState();
          const entry = state.subscriptions.outbound.byKey[subscriptionKey];
          if (entry === undefined || entry.deliveryHalted !== undefined) return;
          const config = entry.configuration;
          const receiver = config.receiver;
          if (receiver.action === "processor-wake") return;
          const row = this.#hooks.store.get(subscriptionKey);
          if (row === undefined) return;
          if (row.nextAttemptAt !== null && row.nextAttemptAt > this.#hooks.now()) return;
          const expectedDelivery = {
            configuredAtOffset: entry.configuredAtOffset,
            cursorChangedAtOffset: row.cursorChangedAtOffset,
          };
          activeDeliveryState = expectedDelivery;

          // Poison isolation goes straight to batch size 1 after a failure:
          // healthy prefixes commit one event at a time until the failing
          // event is the only retry left (isolate-or-progress).
          //
          // Webhook delivery pins the read limit to 1 always: external
          // receivers get single-event POSTs, each ack covers exactly one
          // offset (mid-batch resume for free), the failing-event machinery
          // always sees the true delivery unit, and the per-iteration
          // staleness checks above run per EVENT — a removed/replaced webhook
          // can never keep POSTing a stale batch to the old URL. The
          // failure pin composes rather than duplicates: for a webhook it is
          // already the steady state. The cost is one row/config re-read per
          // event on a backlog, noise against the HTTP POST itself.
          const limit =
            receiver.action === "webhook-post" || this.#limitNextReadToOne.has(subscriptionKey)
              ? 1
              : DELIVERY_BATCH_LIMIT;

          const sized = this.#readBatch(row.acknowledgedOffset, Number.MAX_SAFE_INTEGER, limit);
          const lastOffset = sized.at(-1)?.event.offset;
          if (lastOffset === undefined) {
            // The allocator's maximum offset can be greater than the last surviving row after
            // ephemeral eviction. An empty range read proves that whole suffix
            // contains no durable work, so advance the durable cursor through
            // it instead of reporting permanent phantom lag.
            if (row.acknowledgedOffset < state.maxOffset) {
              this.#hooks.store.ack(subscriptionKey, state.maxOffset, {
                cursorChangedAtOffset: row.cursorChangedAtOffset,
                preserveFailingEventSkips: true,
              });
            }
            return;
          }
          const byteLengthByOffset = new Map(
            sized.map((entry) => [entry.event.offset, entry.byteLength]),
          );

          // Durable delivery never sends ephemeral events. The cursor still
          // advances over skipped rows.
          const visible = sized
            .filter((entry) => entry.event.ephemeral !== true)
            .map((entry) => entry.event);
          // The receiver's cycle-drop audit event is first-hand and would
          // start a fresh provenance chain if copied onward; a reciprocal
          // wildcard copy pair could then manufacture audit events forever.
          const deliverable =
            receiver.action === "copy-to-stream"
              ? visible.filter(
                  (event) =>
                    !hasStructuredIdPrefix(
                      event.idempotencyKey,
                      internalStreamIdPrefix("copy-drop"),
                    ),
                )
              : visible;
          const { matched, failure: filterFailure } = this.#applyFilter(
            subscriptionKey,
            config,
            expectedDelivery,
            deliverable,
          );
          if (filterFailure !== undefined && matched.length === 0) {
            if (!this.#hooks.appendDeliveryEvent(filterFailure.eventToAppend)) {
              // The filter decision is not allowed to outrun its durable
              // explanation. Lifecycle teardown can interrupt append after
              // validation but before commit; leave the cursor untouched and
              // retry the same source rows in a fresh incarnation.
              this.#hooks.armAlarm(this.#hooks.now() + LIFECYCLE_RETRY_DELAY_MS);
              return;
            }
            if (
              this.#onSourceOwnedFailure({
                subscriptionKey,
                config,
                matched: [filterFailure.event],
                error: filterFailure.error,
              }) === "continue"
            ) {
              continue;
            }
            return;
          }

          if (matched.length === 0) {
            // Skip-not-defer: nothing here for this callback owner, but the cursor
            // must advance or the subscription re-reads these events forever.
            this.#hooks.store.ack(subscriptionKey, lastOffset, {
              cursorChangedAtOffset: row.cursorChangedAtOffset,
              preserveFailingEventSkips: true,
            });
            continue;
          }

          // A filter failure is an ordered boundary. A healthy prefix may
          // be delivered and acknowledged, but never the failing event or a
          // later row; the next iteration then routes that exact event through
          // the receiver's failing event policy.
          const deliveredThroughOffset = filterFailure?.event.offset
            ? filterFailure.event.offset - 1
            : lastOffset;

          if (
            state.projectId === undefined ||
            state.path === undefined ||
            state.streamId === undefined ||
            state.createdAt === undefined
          ) {
            throw new Error(`subscription "${subscriptionKey}" exists on an uninitialized stream`);
          }
          const streamId = state.streamId;
          const streamCreatedAt = state.createdAt;
          const configuredEvent = subscriptionConfigurationForDelivery({
            type: "events.iterate.com/stream/subscription-configured",
            offset: entry.configuredAtOffset,
            createdAt: entry.configuredAt,
            path: state.path,
            payload: subscriptionConfiguredPayloadFromReducedState({
              configuration: entry.configuration,
              configuredAtOffset: entry.configuredAtOffset,
            }),
          });

          const deliveredBytes = matched.reduce(
            (sum, event) => sum + (byteLengthByOffset.get(event.offset) ?? 0),
            0,
          );
          // Dispatch-time accounting: retries re-send real bytes, so failed
          // attempts count too (the wire carried them either way).
          const dispatchAtMs = this.#hooks.now();
          this.#hooks.recordEgress(matched.length, deliveredBytes);
          // Same ordering as hosted wake: the durable retry must commit
          // before any remote receiver can observe this attempt.
          this.#armInFlightWatchdog();
          try {
            if (receiver.action === "webhook-post") {
              if (state.projectId === null) return; // unreachable: rejected at append (egress attribution)
              await withDeliveryTimeout(
                this.#hooks.receiverCalls.deliverToWebhook(receiver.url, {
                  projectId: state.projectId,
                  path: state.path,
                  streamId,
                  streamCreatedAt,
                  // Exactly one: webhook delivery pins the read limit to one.
                  event: applyJsonataTransform(
                    "webhook",
                    subscriptionKey,
                    receiver.jsonataTransform,
                    matched[0]!,
                  ),
                  subscriptionKey,
                  cursorChangedAtSourceOffset: row.cursorChangedAtOffset,
                  deliveryId: deliveryId(
                    streamId,
                    subscriptionKey,
                    row.cursorChangedAtOffset,
                    matched[0]!.offset,
                    deliveredThroughOffset,
                  ),
                  attempt: row.attempt + 1,
                  configuredEvent,
                }),
                `webhook ${subscriptionKey}`,
              );
            } else {
              const batch: StreamDeliveryBatch = {
                projectId: state.projectId,
                path: state.path,
                streamId,
                streamCreatedAt,
                // An ITX transform is applied here, per delivered event; a
                // copy batch always carries the untransformed source events
                // because the RECEIVING stream applies its transform before
                // committing (provenance is stamped after it). A transform
                // evaluation failure throws into the catch below — the
                // ordinary delivery-failure ladder, respecting onFailingEvent
                // and the straight-to-1 isolation.
                events:
                  receiver.action === "itx-call" && receiver.jsonataTransform !== undefined
                    ? matched.map((event) =>
                        applyJsonataTransform(
                          "itx",
                          subscriptionKey,
                          receiver.jsonataTransform,
                          event,
                        ),
                      )
                    : matched,
                streamMaxOffset: state.maxOffset,
                subscriptionKey,
                cursorChangedAtSourceOffset: row.cursorChangedAtOffset,
                deliveryId: deliveryId(
                  streamId,
                  subscriptionKey,
                  row.cursorChangedAtOffset,
                  matched[0]!.offset,
                  deliveredThroughOffset,
                ),
                attempt: row.attempt + 1,
                configuredEvent,
              };
              if (receiver.action === "copy-to-stream") {
                // The awaited resolve is the whole acknowledgement: appended
                // events, idempotent duplicates, and cycle/hop-limit drops are
                // all terminal, so the cursor advances past every event in an
                // acked batch.
                await withDeliveryTimeout(
                  this.#hooks.receiverCalls.copyToStream(receiver.receivingStreamPath, batch),
                  `stream ${subscriptionKey}`,
                );
              } else {
                await withDeliveryTimeout(
                  this.#hooks.receiverCalls.deliverToItx(receiver.expression, batch),
                  `itx expression ${subscriptionKey}`,
                );
              }
            }
          } catch (error) {
            // The receiverCalls yielded to the event loop. A cursor seek, removal, or
            // same-key replacement may have landed while the old receiver was
            // in flight. Its eventual rejection belongs to that older configuration
            // and must not back off, halt, or skip work for the new one.
            if (!this.#deliveryStillMatches(subscriptionKey, expectedDelivery)) continue;
            // "continue" = the failure handler already moved the goalposts
            // (dropped the next read straight to batch size 1 or stepped over
            // a confirmed failing event) and the loop should try again NOW;
            // anything else backs off or halts and the alarm/resume owns the
            // future.
            if (
              this.#onSourceOwnedFailure({ subscriptionKey, config, matched, error }) === "continue"
            ) {
              continue;
            }
            return;
          }
          // A successful call from an older configuration must not advance the
          // current cursor, metrics, or finite-delivery counters.
          if (!this.#deliveryStillMatches(subscriptionKey, expectedDelivery)) continue;
          // The awaited resolve above IS this receiver's acknowledgement — record
          // both the call duration (transport+receiver latency) and the
          // commit→acked age of the newest delivered event, all on the
          // stream's own clock.
          const completedAtMs = this.#hooks.now();
          const subscriptionMetrics = this.#subscriptionMetricsFor(subscriptionKey);
          subscriptionMetrics.deliveryDuration.record(completedAtMs - dispatchAtMs, completedAtMs);
          const newestCreatedAtMs = Date.parse(matched.at(-1)!.createdAt);
          if (Number.isFinite(newestCreatedAtMs)) {
            subscriptionMetrics.completionLatency.record(
              completedAtMs - newestCreatedAtMs,
              completedAtMs,
            );
          }
          subscriptionMetrics.bytesSent += deliveredBytes;
          this.#hooks.runtimeChanged();
          // Compare the offset of the configuration or cursor-set event read
          // above. If a seek or replacement was appended while this delivery
          // was in flight, this acknowledgement does nothing; the next
          // iteration re-reads the row and sends from the newly chosen cursor.
          this.#hooks.store.ack(subscriptionKey, deliveredThroughOffset, {
            cursorChangedAtOffset: row.cursorChangedAtOffset,
          });
          this.#limitNextReadToOne.delete(subscriptionKey);
        }
      } catch (error) {
        console.error("durable subscription send loop failed", { subscriptionKey, error });
        // An unexpected local delivery-loop failure is still a bounded, observable
        // delivery failure. Without this transition a quiet stream could keep
        // an active row forever with neither an alarm nor a halted event.
        const entry = this.#hooks.coreState().subscriptions.outbound.byKey[subscriptionKey];
        if (
          activeDeliveryState !== undefined &&
          this.#deliveryStillMatches(subscriptionKey, activeDeliveryState) &&
          entry !== undefined &&
          entry.configuration.receiver.action !== "processor-wake"
        ) {
          this.#onDeliveryFailure(subscriptionKey, error);
        } else {
          queueMicrotask(() => this.sendDue());
        }
      } finally {
        this.#sourceOwnedSendsInFlight.delete(subscriptionKey);
        this.reconcileAlarmAfterSettlement();
      }
    });
  }

  /**
   * Whether this async call still belongs to the same configuration and cursor.
   * The configuration offset detects remove/recreate and same-key replacement;
   * the cursor-changing event offset detects a seek appended during the call.
   */
  #deliveryStillMatches(subscriptionKey: string, expectedDelivery: ExpectedDeliveryState): boolean {
    const entry = this.#hooks.coreState().subscriptions.outbound.byKey[subscriptionKey];
    const row = this.#hooks.store.get(subscriptionKey);
    return (
      entry?.configuredAtOffset === expectedDelivery.configuredAtOffset &&
      row?.configuredAtOffset === expectedDelivery.configuredAtOffset &&
      row.cursorChangedAtOffset === expectedDelivery.cursorChangedAtOffset
    );
  }

  /**
   * Read up to `limit` events after `afterOffset`, shrinking under the byte
   * cap. A reader positioned exactly before the just-committed first event consumes the
   * handed-over fresh events instead of re-reading them from SQLite — the
   * committed objects are byte-for-byte what a read-back would parse (append
   * strict-parses the body and stamps `path` before commit).
   */
  #readBatch(afterOffset: number, beforeOffset: number, limit: number): SizedStreamEvent[] {
    const sized =
      this.#justCommittedEvents[0]?.event.offset === afterOffset + 1
        ? this.#justCommittedEvents
            .filter((entry) => entry.event.offset < beforeOffset)
            .slice(0, limit)
        : this.#hooks.readEvents({ afterOffset, beforeOffset, limit });
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
   * Apply a subscription's filter in source order. A condition that throws
   * stops the batch at that exact event; the caller sends the healthy prefix,
   * then routes the failed event through the ordinary failing event retry policy.
   */
  #applyFilter(
    subscriptionKey: string,
    config: SubscriptionConfiguredPayload,
    expectedDelivery: ExpectedDeliveryState,
    events: StreamEvent[],
  ): {
    matched: StreamEvent[];
    failure?: { event: StreamEvent; error: Error; eventToAppend: StreamEventInput };
  } {
    const filter = compileEventFilter(config.filter);
    const matched: StreamEvent[] = [];
    for (const event of events) {
      try {
        if (filter.matches(event)) matched.push(event);
      } catch (error) {
        // The audit event lands on this stream and is itself scanned by the
        // subscription. Exclude only this subscription's own idempotent event
        // to terminate that recursion; every other runtime filter failure
        // remains a real ordered failing event decision.
        if (
          hasStructuredIdPrefix(
            event.idempotencyKey,
            internalStreamIdPrefix("filter-condition-failed"),
            subscriptionKey,
          )
        ) {
          continue;
        }
        const filterError = new Error(
          `subscription "${subscriptionKey}" filter condition failed on offset ${event.offset}: ${errorMessage(error)}`,
          { cause: error },
        );
        return {
          matched,
          failure: {
            event,
            error: filterError,
            eventToAppend: {
              type: "events.iterate.com/stream/error-occurred",
              idempotencyKey: internalStreamId(
                "filter-condition-failed",
                subscriptionKey,
                expectedDelivery.configuredAtOffset,
                expectedDelivery.cursorChangedAtOffset,
                event.offset,
              ),
              payload: { message: filterError.message },
            },
          },
        };
      }
    }
    return { matched };
  }

  /**
   * A copy, ITX-call, or webhook delivery failed. Any batch failure pins the next read
   * to batch size 1 (isolate-or-progress). `halt` policy (and every hosted wake
   * failure) goes through the shared backoff/halt machine. `skip` policy
   * requires FAILING_EVENT_CONFIRM_ATTEMPTS consecutive
   * failures of the isolated event before stepping over it, and still halts when
   * skips run consecutive (a receiver that fails everything is DOWN, not
   * failing one event — mass-skipping its backlog would be silent data loss).
   */
  #onSourceOwnedFailure(args: {
    subscriptionKey: string;
    config: SubscriptionConfiguredPayload;
    matched: StreamEvent[];
    error: unknown;
  }): "continue" | "stop" {
    const { subscriptionKey, config, matched, error } = args;
    this.#limitNextReadToOne.add(subscriptionKey);
    // A receiver that declared itself unavailable, or a receiver call rejected
    // by workerd because its Durable Object is temporarily unavailable, is
    // down rather than unable to digest one event. Never turn infrastructure
    // overload into a permanent skip verdict.
    //
    // The batch backs off and redelivers, and sustained
    // unavailability halts loudly like any other outage. Its retry
    // count is deliberately separate from the per-event failing event confirmation
    // fields in the cursor row: an outage can never pre-confirm a later event.
    if (
      isStreamReceiverUnavailableError(error) ||
      isRetryableDurableObjectAvailabilityError(error)
    ) {
      this.#onDeliveryFailure(subscriptionKey, error);
      return "stop";
    }
    if (
      config.receiver.action !== "processor-wake" &&
      config.receiver.delivery.onFailingEvent === "skip"
    ) {
      if (matched.length > 1) {
        // Retry NOW at batch size 1; the receiver proved it is alive enough
        // to reject, and the healthy prefix should commit without backoff.
        return "continue";
      }
      const failingEvent = matched[0]!;
      const row = this.#hooks.store.get(subscriptionKey);
      const deliveryAttempt = (row?.attempt ?? 0) + 1;
      const failingEventAttempt =
        row?.failingEventOffset === failingEvent.offset ? row.failingEventAttempt + 1 : 1;
      if (failingEventAttempt < FAILING_EVENT_CONFIRM_ATTEMPTS) {
        this.#backoff(subscriptionKey, deliveryAttempt, error, {
          offset: failingEvent.offset,
          attempt: failingEventAttempt,
        });
        return "stop";
      }
      // Confirmed failing event — unless skips are running consecutive, in which
      // case the receiver is down (everything fails, nothing is "the" failing event
      // event) and mass-skipping its backlog would be silent data loss: halt.
      const skips = (row?.failingEventSkipsSinceLastSuccess ?? 0) + 1;
      if (skips >= MAX_FAILING_EVENT_SKIPS_SINCE_LAST_SUCCESS) {
        this.#halt(subscriptionKey, deliveryAttempt, error);
        return "stop";
      }
      const recorded = this.#hooks.appendDeliveryEvent({
        type: "events.iterate.com/stream/error-occurred",
        idempotencyKey: internalStreamId(
          "subscription-failing-event-skipped",
          subscriptionKey,
          failingEvent.offset,
          row?.cursorChangedAtOffset ?? 0,
        ),
        payload: {
          message: `subscription "${subscriptionKey}" skipped failing event at offset ${failingEvent.offset} after ${failingEventAttempt} event-specific attempts: ${errorMessage(error)}`,
        },
      });
      if (!recorded) {
        // Skipping without the audit event would be silent data loss. Retry the
        // same failing event after this object incarnation finishes tearing
        // down; the idempotency key makes a post-commit interruption safe too.
        this.#hooks.armAlarm(this.#hooks.now() + LIFECYCLE_RETRY_DELAY_MS);
        return "stop";
      }
      // Step over the confirmed failing event and reset the read window +
      // failure streak: the receiver is alive, it just cannot digest that one.
      if (row === undefined) return "stop";
      this.#hooks.store.ackFailingEventSkipped(
        subscriptionKey,
        failingEvent.offset,
        row.cursorChangedAtOffset,
      );
      this.#limitNextReadToOne.delete(subscriptionKey);
      return "continue";
    }

    const row = this.#hooks.store.get(subscriptionKey);
    this.#onDeliveryFailure(subscriptionKey, error, row?.attempt ?? 0);
    return "stop";
  }

  /** Shared failure path for hosted wake and halt-policy delivery. */
  #onDeliveryFailure(subscriptionKey: string, error: unknown, previousAttempts?: number): void {
    const attempts = previousAttempts ?? this.#hooks.store.get(subscriptionKey)?.attempt ?? 0;
    const attempt = attempts + 1;
    // A receiver that reports its failure as deterministic (a worker source
    // build that cannot compile, `retryable: false`) will fail identically on
    // every retry; halt now with the exact error instead of burning the
    // attempt ladder against a foregone conclusion.
    if ((error as { retryable?: unknown } | null)?.retryable === false) {
      this.#halt(subscriptionKey, attempt, error);
      return;
    }
    if (attempt >= MAX_DELIVERY_ATTEMPTS) {
      this.#halt(subscriptionKey, attempt, error);
      return;
    }
    if (isRetryableDurableObjectAvailabilityError(error)) {
      const nextAttemptAt = this.#hooks.now() + LIFECYCLE_RETRY_DELAY_MS;
      this.#hooks.store.nack(subscriptionKey, {
        attempt,
        nextAttemptAt,
        error: errorMessage(error),
      });
      this.#hooks.armAlarm(nextAttemptAt);
      return;
    }
    this.#backoff(subscriptionKey, attempt, error);
  }

  /**
   * Convert a persisted hosted-batch watchdog into the ordinary bounded
   * failure ladder. A live connection gets first refusal in
   * `StreamConnections.onAlarm()`; rows left here are the eviction/idle case,
   * where the callback and its in-memory generation vanished before settling.
   */
  #failExpiredHostedDeliveries(): void {
    const now = this.#hooks.now();
    for (const row of this.#hooks.store.list()) {
      if (row.inFlightDeadlineAt === null || row.inFlightDeadlineAt > now) continue;
      const entry = this.#hooks.coreState().subscriptions.outbound.byKey[row.subscriptionKey];
      if (
        entry === undefined ||
        entry.deliveryHalted !== undefined ||
        entry.configuredAtOffset !== row.configuredAtOffset ||
        entry.configuration.receiver.action !== "processor-wake"
      ) {
        this.#hooks.store.clearInFlight(row.subscriptionKey, {
          connectionGeneration: row.inFlightConnectionGeneration ?? -1,
          cursorChangedAtOffset: row.cursorChangedAtOffset,
        });
        continue;
      }
      this.#onDeliveryFailure(
        row.subscriptionKey,
        new Error(
          `hosted processor batch acknowledgement timed out after ${DEFAULT_DELIVERY_TIMEOUT_MS}ms; the source isolate no longer owns a live callback`,
        ),
        row.attempt,
      );
    }
  }

  #backoff(
    subscriptionKey: string,
    attempt: number,
    error: unknown,
    failingEvent?: { offset: number; attempt: number },
  ): void {
    const nextAttemptAt = this.#hooks.now() + computeBackoffMs(attempt, this.#hooks.random());
    this.#hooks.store.nack(subscriptionKey, {
      attempt,
      nextAttemptAt,
      error: errorMessage(error),
      ...(failingEvent === undefined ? {} : { failingEvent }),
    });
    this.#hooks.armAlarm(nextAttemptAt);
  }

  /**
   * Give up loudly: the halted event reduces into core state (delivery stops) and
   * shows red in the UI. Idempotent per (key, cursor) so redeliveries of the
   * failure cannot spam the log. `subscription-delivery-resumed` (or a fresh
   * `subscription-configured`) is the way back.
   */
  #halt(subscriptionKey: string, attempts: number, error: unknown): void {
    // State-guarded, not idempotency-keyed: a halt after resume at an unmoved
    // cursor is a NEW transition and must land as a new event (an idempotency
    // key derived from the cursor would swallow it and the subscription would
    // retry forever without ever turning red again). Duplicate dropping
    // comes from the fold: while halted, the send loop never runs this path.
    if (
      this.#hooks.coreState().subscriptions.outbound.byKey[subscriptionKey]?.deliveryHalted !==
      undefined
    ) {
      return;
    }
    const row = this.#hooks.store.get(subscriptionKey);
    const terminalError = boundedErrorMessage(error);
    const recorded = this.#hooks.appendDeliveryEvent({
      type: "events.iterate.com/stream/subscription-delivery-halted",
      payload: {
        subscriptionKey,
        reason: "delivery-failed",
        afterOffset: row?.acknowledgedOffset ?? 0,
        attempts,
        ...(terminalError === undefined ? {} : { error: terminalError }),
      },
    });
    if (!recorded) {
      // Halting is an appended event, not an in-memory state transition. Keep
      // the failed row retryable until that event commits so a lifecycle interruption can
      // neither strand the subscription nor erase the durable explanation.
      const nextAttemptAt = this.#hooks.now() + LIFECYCLE_RETRY_DELAY_MS;
      this.#hooks.store.nack(subscriptionKey, {
        attempt: attempts,
        nextAttemptAt,
        error: errorMessage(error),
      });
      this.#hooks.armAlarm(nextAttemptAt);
      return;
    }
    // A halted row must not keep driving the alarm: the halt was preceded by
    // a nack whose (now past) next_attempt_at would otherwise be re-armed by
    // every onAlarm forever — a permanent alarm hot loop per halted
    // subscription. Clear the backoff, keep the cursor (the halted event carries
    // the attempts + error for the audit trail).
    if (row !== undefined) this.#hooks.store.ack(subscriptionKey, row.acknowledgedOffset);
    this.#limitNextReadToOne.delete(subscriptionKey);
  }

  #armAlarmFromStore(): void {
    // Not a bare MIN over the rows: halted rows keep their cursor but must
    // not arm the alarm, and a row whose retry is in flight this very turn
    // still carries its (past) due time until the attempt settles — re-arming
    // from either spins the alarm at zero delay.
    const state = this.#hooks.coreState();
    let next: number | null = null;
    let lagWithoutSchedule = false;
    for (const row of this.#hooks.store.list()) {
      const key = row.subscriptionKey;
      const configured = state.subscriptions.outbound.byKey[key];
      if (configured === undefined) {
        this.#hooks.store.delete(key);
        continue;
      }
      if (configured.deliveryHalted !== undefined) continue;
      if (row.inFlightDeadlineAt !== null) {
        if (next === null || row.inFlightDeadlineAt < next) next = row.inFlightDeadlineAt;
        continue;
      }
      if (this.#sourceOwnedSendsInFlight.has(key) || this.#hostedWakesInFlight.has(key)) {
        // The alarm that launched this attempt has already fired. Keep a
        // durable watchdog armed so isolate death during the awaited remote
        // call cannot strand a quiet subscription with no future wake.
        const watchdogAt =
          this.#hooks.now() + DEFAULT_DELIVERY_TIMEOUT_MS + LIFECYCLE_RETRY_DELAY_MS;
        if (next === null || watchdogAt < next) next = watchdogAt;
        continue;
      }
      if (row.nextAttemptAt === null) {
        // A non-halted row lagging the head with NOTHING scheduled is the
        // lifecycle-retry state: an interrupted audit/settlement append armed
        // a bare short-delay alarm without touching the row (deliberately —
        // the cursor must not move past unexplained work). That armed wake is
        // this row's only future, so it must veto the quiet deletion below.
        if (row.acknowledgedOffset < state.maxOffset) lagWithoutSchedule = true;
        continue;
      }
      if (next === null || row.nextAttemptAt < next) next = row.nextAttemptAt;
    }
    if (next !== null) this.#hooks.armAlarm(next);
    this.connections.rearmIdleAlarm();
    // Nothing durable needs a future turn and no idle deadline is pending:
    // delete the alarm outright, or the last send's in-flight watchdog
    // outlives its successful delivery and boots the hibernated stream every
    // ~21s forever (each boot appends `woken`, whose delivery re-arms the
    // next watchdog). Settlement paths re-run this method so the LAST
    // completion is what finds the quiet state. A later armNoLaterThan in
    // the same turn re-arms after the delete.
    if (
      next === null &&
      !lagWithoutSchedule &&
      !this.connections.hasPendingIdleDeadline &&
      this.#sourceOwnedSendsInFlight.size === 0 &&
      this.#hostedWakesInFlight.size === 0
    ) {
      this.#hooks.clearAlarm();
    }
  }

  /** Recompute (and possibly clear) the alarm after an asynchronous settlement. */
  reconcileAlarmAfterSettlement(): void {
    try {
      // Re-derive idle eligibility from the CURRENT connection map first: a
      // settlement may be the first reconciliation that can see a connection
      // published after its opened-fact reconcile, and the quiet deletion
      // below must observe that pending idle deadline, not clear the alarm
      // out from under it.
      this.connections.armOrClearIdleAlarm();
      this.#armAlarmFromStore();
    } catch (error) {
      console.error("post-settlement alarm reconciliation failed", error);
    }
  }

  /**
   * Persist a conservative re-check before starting an awaited remote call.
   * Successful work may leave one harmless extra alarm; losing an isolate may
   * never leave a quiet stored subscription with no future invocation.
   */
  #armInFlightWatchdog(): void {
    this.#hooks.armAlarm(
      this.#hooks.now() + DEFAULT_DELIVERY_TIMEOUT_MS + LIFECYCLE_RETRY_DELAY_MS,
    );
  }

  // ===========================================================================
  // Runtime delivery metrics.
  // ===========================================================================

  #subscriptionMetricsFor(subscriptionKey: string) {
    let metrics = this.#subscriptionMetrics.get(subscriptionKey);
    if (metrics === undefined) {
      metrics = {
        completionLatency: new LatencyRing(),
        deliveryDuration: new LatencyRing(),
        bytesSent: 0,
      };
      this.#subscriptionMetrics.set(subscriptionKey, metrics);
    }
    return metrics;
  }

  // ===========================================================================
  // Runtime debug state and idle teardown.
  // ===========================================================================

  subscriptionRuntimeState(): Record<string, SubscriptionRuntimeState> {
    const state = this.#hooks.coreState();
    const rows = new Map(this.#hooks.store.list().map((row) => [row.subscriptionKey, row]));
    return Object.fromEntries(
      Object.keys(state.subscriptions.outbound.byKey).map((subscriptionKey) => {
        const row = rows.get(subscriptionKey);
        const acknowledgedOffset = row?.acknowledgedOffset ?? 0;
        const metrics = this.#subscriptionMetrics.get(subscriptionKey);
        const completionLatencyMs = metrics?.completionLatency.stats() ?? null;
        const deliveryDurationMs = metrics?.deliveryDuration.stats() ?? null;
        return [
          subscriptionKey,
          {
            acknowledgedOffset,
            lag: Math.max(0, state.maxOffset - acknowledgedOffset),
            attempt: row?.attempt ?? 0,
            nextAttemptAt: row?.nextAttemptAt ?? null,
            inFlightDeadlineAt: row?.inFlightDeadlineAt ?? null,
            lastError: row?.lastError ?? null,
            ...(metrics === undefined ? {} : { bytesSent: metrics.bytesSent }),
            ...(completionLatencyMs === null ? {} : { completionLatencyMs }),
            ...(deliveryDurationMs === null ? {} : { deliveryDurationMs }),
          },
        ];
      }),
    );
  }

  runIdleTeardownNow(): void {
    this.#rememberIdleHostedCallbacks(this.connections.runIdleTeardownNow());
  }

  #rememberIdleHostedCallbacks(subscriptionKeys: readonly string[]): void {
    if (subscriptionKeys.length === 0) return;
    const state = this.#hooks.coreState();
    for (const subscriptionKey of subscriptionKeys) {
      const configured = state.subscriptions.outbound.byKey[subscriptionKey];
      if (configured?.configuration.receiver.action !== "processor-wake") continue;
      this.#hostedIdledAtOffset.set(subscriptionKey, {
        configuredAtOffset: configured.configuredAtOffset,
        sourceOffset: state.maxOffset,
      });
    }
  }
}

// =============================================================================
// StreamConnections: the live-callback state machine (session and hosted
// callbacks, send loops, connection generations, ping metrics, idle teardown).
// =============================================================================

/** Configuration and deliveredThroughOffset values captured before an asynchronous delivery starts. */
export type ExpectedDeliveryState = {
  configuredAtOffset: number;
  cursorChangedAtOffset: number;
};

/** Also distinguishes replacement callbacks opened within one durable generation. */
export type ExpectedHostedDeliveryState = ExpectedDeliveryState & {
  connectionGeneration: number;
};

/** Delivery progress and retry details shared by every live callback connection. */
type ConnectionRuntimeDetails = {
  startedAt: string;
  deliveredThroughOffset: number;
  lag: number;
  batchesSent: number;
  eventsSent: number;
  bytesSent: number;
  lastDeliveredAt?: string;
  completionLatencyMs?: LatencyStats;
  pingRttMs?: LatencyStats;
  openedBy?: ConnectionOpenerDescriptor;
  hasPendingDelivery: boolean;
  pendingDeliveryStartedAt?: string;
  pendingDeliveryDeadlineAt?: string;
};

/** Serializable debug view of one live callback connection. */
export type ConnectionRuntimeState = ConnectionRuntimeDetails &
  (
    | { kind: "session" }
    | {
        kind: "hosted";
        /** The durable subscription whose processor callback this connection serves. */
        subscriptionKey: string;
      }
  );

/** One live event-batch callback. Copy, ITX-call, and webhook subscriptions do not appear here. */
type StreamConnection = {
  readonly kind: StreamConnectionKind;
  readonly expectedHostedDelivery?: ExpectedHostedDeliveryState;
  readonly startedAt: string;
  readonly openedBy?: ConnectionOpenerDescriptor;
  readonly deliveredThroughOffset: number;
  batchesSent: number;
  eventsSent: number;
  bytesSent: number;
  lastDeliveredAt?: string;
  readonly completionLatency: LatencyRing;
  readonly pingRtt: LatencyRing;
  ping?: RetainedConnectionPing;
  getProcessorRuntimeState?: GetProcessorRuntimeState & Disposable;
  sendQueued(): void;
  isLive(): boolean;
  hasPendingDelivery(): boolean;
  pendingDeliveryStartedAtMs(): number | null;
  pendingDeliveryDeadlineAtMs(): number | null;
  takeDuePendingDeliveryProbe(nowMs: number): boolean;
  schedulePendingDeliveryProbe(atMs: number): void;
  close(reason: ConnectionCloseReason, error?: string): void;
};

/**
 * Apply a session connection's per-batch delivery ceilings. Count first,
 * then cumulative bytes; the first event always survives so one event
 * larger than the byte cap reaches the consumer (whose parser reports it)
 * instead of stalling the cursor forever.
 */
function capSessionDelivery(
  matched: SizedStreamEvent[],
  maxEvents: number | undefined,
  maxBytes: number | undefined,
): SizedStreamEvent[] {
  let capped = maxEvents !== undefined ? matched.slice(0, maxEvents) : matched;
  if (maxBytes !== undefined && capped.length > 1) {
    let bytes = 0;
    for (let index = 0; index < capped.length; index += 1) {
      bytes += capped[index]!.byteLength;
      if (bytes > maxBytes && index > 0) {
        capped = capped.slice(0, index);
        break;
      }
    }
  }
  return capped;
}

type OpenConnectionArgs<Batch extends StreamEventBatch> = {
  connectionKey: string;
  kind: StreamConnectionKind;
  expectedHostedDelivery?: ExpectedHostedDeliveryState;
  processEventBatch: RetainedProcessEventBatch<Batch>;
  replayAfterOffset?: number;
  expectedStreamId?: string | null;
  maxReplayOffsetGap?: number;
  filter?: CompiledEventFilter;
  events?: boolean;
  /** Per-connection ceiling on events per delivered batch (session lane). */
  maxDeliveryEvents?: number;
  /** Per-connection ceiling on summed event bytes per delivered batch; always ≥1 event. */
  maxDeliveryBytes?: number;
  /** false omits the reduced core state from every batch. */
  includeState?: boolean;
  openedBy?: ConnectionOpenerDescriptor;
  getRuntimeState?: GetProcessorRuntimeState;
  ping?: StreamConnectionPing;
  sendOnOpen?: boolean;
};

/** The StreamEventSender seams plus the bridges into its private delivery internals. */
type StreamConnectionsHooks = Pick<
  StreamEventSenderHooks,
  | "coreState"
  | "store"
  | "appendDeliveryEvent"
  | "recordEgress"
  | "runtimeChanged"
  | "now"
  | "armAlarm"
  | "keepAlive"
  | "wakeChannelKeys"
  | "onSessionsIdleClosed"
> & {
  readBatch(afterOffset: number, beforeOffset: number, limit: number): SizedStreamEvent[];
  hostedDeliveryStillMatches(
    connectionKey: string,
    expectedDelivery: ExpectedHostedDeliveryState,
  ): boolean;
  onHostedDeliveryFailure(connectionKey: string, error: unknown): void;
  sendDueSubscriptions(): void;
  /** Recompute (and possibly clear) the alarm after a hosted batch settles. */
  reconcileAlarm(): void;
};

const PING_ROUND_MIN_INTERVAL_MS = 5_000;
const PING_TIMEOUT_MS = 10_000;
const HOSTED_PENDING_PROBE_INTERVAL_MS = 1_000;
const HOSTED_PENDING_PROBE_TIMEOUT_MS = 1_000;
function connectionError(error: unknown): string {
  return boundedErrorMessage(error) ?? "unknown error";
}

function deliveryErrorDiagnostics(error: unknown): {
  errorName: string;
  errorMessage: string;
  itxCallId?: string;
  cloudflareErrorReference?: string;
} {
  const errorMessage = connectionError(error);
  let errorName = "NonErrorThrowable";
  let itxCallId: string | undefined;
  try {
    if (typeof error === "object" && error !== null) {
      const candidateName: unknown = Reflect.get(error, "name");
      const candidateItxCallId: unknown = Reflect.get(error, "itxCallId");
      if (typeof candidateName === "string" && candidateName.length > 0) {
        errorName = candidateName.slice(0, 200);
      }
      if (
        typeof candidateItxCallId === "string" &&
        candidateItxCallId.length > 0 &&
        candidateItxCallId.length <= 200
      ) {
        itxCallId = candidateItxCallId;
      }
    }
  } catch {
    // A hostile remote throwable must not break the failure/retry transition.
  }
  const cloudflareErrorReference = /\breference\s*=\s*([a-z0-9]{8,128})\b/iu.exec(
    errorMessage,
  )?.[1];
  return {
    errorName,
    errorMessage,
    ...(itxCallId === undefined ? {} : { itxCallId }),
    ...(cloudflareErrorReference === undefined ? {} : { cloudflareErrorReference }),
  };
}

/**
 * Runtime state machine for session callbacks and hosted-processor callbacks.
 *
 * It owns only live capabilities, callback send loops, connection generations, metrics, and
 * idle teardown. Stored durable configuration, cursors, failing-event policy, and receiver
 * retries stay in StreamEventSender. The hooks are the explicit boundary
 * between those independent responsibilities.
 */
export class StreamConnections {
  readonly #hooks: StreamConnectionsHooks;
  readonly #idleTeardownMs: number;
  readonly #connections = new Map<string, StreamConnection>();
  #idleTeardownAtMs: number | null = null;
  #tearingDown = false;
  #lastPingRoundAtMs: number | null = null;
  readonly #pendingDeliveryProbes = new Set<StreamConnection>();

  constructor(args: { idleTeardownMs: number; hooks: StreamConnectionsHooks }) {
    this.#idleTeardownMs = args.idleTeardownMs;
    this.#hooks = args.hooks;
  }

  get isTearingDown(): boolean {
    return this.#tearingDown;
  }

  sendQueued(): void {
    for (const connection of this.#connections.values()) connection.sendQueued();
  }

  /**
   * Close hosted callbacks whose configuration/cursor generation is no
   * longer current before they can receive another batch. This is the
   * level-triggered backstop for a configuration/removal hook interrupted
   * after its event committed.
   */
  closeStaleHosted(
    reasonFor: (
      connectionKey: string,
    ) => Extract<ConnectionCloseReason, "replaced" | "subscription-removed">,
  ): void {
    for (const [connectionKey, connection] of this.#connections) {
      if (
        connection.kind !== "hosted" ||
        connection.expectedHostedDelivery === undefined ||
        this.#hooks.hostedDeliveryStillMatches(connectionKey, connection.expectedHostedDelivery)
      ) {
        continue;
      }
      connection.close(reasonFor(connectionKey));
    }
  }

  onAlarm(): string[] {
    const now = this.#hooks.now();
    for (const [connectionKey, connection] of this.#connections) {
      const deadlineAt = connection.pendingDeliveryDeadlineAtMs();
      if (
        deadlineAt === null ||
        deadlineAt > now ||
        connection.expectedHostedDelivery === undefined
      ) {
        if (
          connection.kind === "hosted" &&
          connection.expectedHostedDelivery !== undefined &&
          connection.takeDuePendingDeliveryProbe(now)
        ) {
          this.#probePendingHostedDelivery(connectionKey, connection);
        }
        continue;
      }
      this.onHostedDeliveryError(
        connectionKey,
        new Error(
          `hosted processor batch acknowledgement timed out after ${DEFAULT_DELIVERY_TIMEOUT_MS}ms`,
        ),
        connection.expectedHostedDelivery,
      );
    }
    if (this.#idleTeardownAtMs !== null && this.#idleTeardownAtMs <= this.#hooks.now()) {
      return this.runIdleTeardownNow();
    }
    return [];
  }

  #probePendingHostedDelivery(connectionKey: string, connection: StreamConnection): void {
    const ping = connection.ping;
    const expectedDelivery = connection.expectedHostedDelivery;
    if (
      ping === undefined ||
      expectedDelivery === undefined ||
      this.#pendingDeliveryProbes.has(connection)
    ) {
      return;
    }
    this.#pendingDeliveryProbes.add(connection);
    const t0 = this.#hooks.now();
    const work = withDeliveryTimeout(
      Promise.resolve().then(() => ping({ t0 })),
      `pending hosted delivery probe ${connectionKey}`,
      { timeoutMs: HOSTED_PENDING_PROBE_TIMEOUT_MS },
    )
      .catch((error: unknown) => {
        // The timeout means only that this incarnation was busy for the probe
        // slice; the batch watchdog still owns that verdict. Every other ping
        // rejection is definitive: hostRuntimeCapabilities.ping has no
        // application work that can fail, so its callback leg is unavailable
        // even when an RPC hop stripped Cloudflare's lifecycle flags.
        if (isStreamReceiverUnavailableError(error)) return;
        const unavailable = isRetryableDurableObjectAvailabilityError(error)
          ? error
          : Object.assign(new Error(errorMessage(error), { cause: error }), { retryable: true });
        this.onHostedDeliveryError(connectionKey, unavailable, expectedDelivery, "rpc-broken");
      })
      .finally(() => {
        this.#pendingDeliveryProbes.delete(connection);
        const deadlineAt = connection.pendingDeliveryDeadlineAtMs();
        if (
          !connection.isLive() ||
          !connection.hasPendingDelivery() ||
          this.#connections.get(connectionKey) !== connection ||
          deadlineAt === null ||
          deadlineAt <= this.#hooks.now()
        ) {
          return;
        }
        const nextProbeAt = Math.min(
          this.#hooks.now() + HOSTED_PENDING_PROBE_INTERVAL_MS,
          deadlineAt,
        );
        connection.schedulePendingDeliveryProbe(nextProbeAt);
        this.#hooks.armAlarm(nextProbeAt);
      });
    this.#hooks.keepAlive(work);
  }

  rearmIdleAlarm(): void {
    if (this.#idleTeardownAtMs !== null) this.#hooks.armAlarm(this.#idleTeardownAtMs);
  }

  /** Whether an idle-teardown deadline is pending (the alarm must stay armed for it). */
  get hasPendingIdleDeadline(): boolean {
    return this.#idleTeardownAtMs !== null;
  }

  openSession(args: {
    connectionKey: string;
    processEventBatch: ProcessEventBatch;
    replayAfterOffset?: number;
    expectedStreamId?: string | null;
    maxReplayOffsetGap?: number;
    filter?: CompiledEventFilter;
    events?: boolean;
    maxDeliveryEvents?: number;
    maxDeliveryBytes?: number;
    includeState?: boolean;
    openedBy?: ConnectionOpenerDescriptor;
    getRuntimeState?: GetProcessorRuntimeState;
    ping?: StreamConnectionPing;
  }): StreamConnection {
    return this.#open({
      ...args,
      kind: "session",
      // Ephemeral results remain deliberately unpulled; openedBy liveness
      // is session-owned through close/onRpcBroken.
      processEventBatch: retainProcessEventBatch(args.processEventBatch),
    });
  }

  openHosted(args: Omit<OpenConnectionArgs<StreamWakeEventBatch>, "kind">): StreamConnection {
    return this.#open({ ...args, kind: "hosted", sendOnOpen: false });
  }

  close(connectionKey: string, reason: ConnectionCloseReason): void {
    this.#connections.get(connectionKey)?.close(reason);
  }

  has(connectionKey: string): boolean {
    return this.#connections.has(connectionKey);
  }

  connectionKind(connectionKey: string): StreamConnection["kind"] | undefined {
    return this.#connections.get(connectionKey)?.kind;
  }

  async getProcessorRuntimeState(connectionKey: string): Promise<ProcessorRuntimeState | null> {
    const connection = this.#connections.get(connectionKey);
    return (await connection?.getProcessorRuntimeState?.()) ?? null;
  }

  /** Back off a failing hosted callback before closing and activating it again. */
  onHostedDeliveryError(
    connectionKey: string,
    error: unknown,
    expectedDelivery: ExpectedHostedDeliveryState,
    source: "delivery" | "rpc-broken" = "delivery",
  ): void {
    const connection = this.#connections.get(connectionKey);
    if (
      connection === undefined ||
      connection.expectedHostedDelivery?.connectionGeneration !==
        expectedDelivery.connectionGeneration ||
      !this.#hooks.hostedDeliveryStillMatches(connectionKey, expectedDelivery)
    ) {
      return;
    }
    const state = this.#hooks.coreState();
    const pendingDeliveryStartedAtMs = connection.pendingDeliveryStartedAtMs();
    const pendingDeliveryDeadlineAtMs = connection.pendingDeliveryDeadlineAtMs();
    const processorAnnouncement = connection.openedBy?.processor?.announcement;
    const details = {
      connectionKey,
      source,
      ...deliveryErrorDiagnostics(error),
      projectId: state.projectId,
      streamPath: state.path,
      streamId: state.streamId,
      configuredAtOffset: expectedDelivery.configuredAtOffset,
      cursorChangedAtOffset: expectedDelivery.cursorChangedAtOffset,
      connectionGeneration: expectedDelivery.connectionGeneration,
      deliveredThroughOffset: connection.deliveredThroughOffset,
      streamMaxOffset: state.maxOffset,
      ...(pendingDeliveryStartedAtMs === null
        ? {}
        : { pendingDeliveryStartedAt: new Date(pendingDeliveryStartedAtMs).toISOString() }),
      ...(pendingDeliveryDeadlineAtMs === null
        ? {}
        : { pendingDeliveryDeadlineAt: new Date(pendingDeliveryDeadlineAtMs).toISOString() }),
      ...(processorAnnouncement === undefined
        ? {}
        : {
            processorSlug: processorAnnouncement.slug,
            processorContractVersion: processorAnnouncement.version,
          }),
    };
    if (error instanceof EventFilterEvaluationError) {
      console.info("stream hosted callback filter condition failed; backing off", details);
    } else if (source === "rpc-broken" || isDurableObjectLifecycleError(error)) {
      console.warn(
        "stream durable callback unavailable; backing off before waking it again",
        details,
      );
    } else {
      console.error("stream durable callback failed; backing off before waking it again", details);
    }
    this.#hooks.onHostedDeliveryFailure(connectionKey, error);
    connection.close(
      source === "rpc-broken" ? "rpc-broken" : "delivery-failed",
      connectionError(error),
    );
  }

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
            return;
          }
          const { rttMs } = pingRoundTrip({ t0, t1: reply.t1, t2: reply.t2 }, t3);
          if (connection.isLive()) {
            connection.pingRtt.record(rttMs, t3);
            this.#hooks.runtimeChanged();
          }
        } catch {
          // Ping sampling is observational; delivery owns liveness.
        }
      })();
      this.#hooks.keepAlive(work);
    }
  }

  runtimeState(): Record<string, ConnectionRuntimeState> {
    const maxOffset = this.#hooks.coreState().maxOffset;
    return Object.fromEntries(
      [...this.#connections].map(([connectionKey, connection]) => {
        const completionLatencyMs = connection.completionLatency.stats();
        const pingRttMs = connection.pingRtt.stats();
        const pendingDeliveryStartedAtMs = connection.pendingDeliveryStartedAtMs();
        const pendingDeliveryDeadlineAtMs = connection.pendingDeliveryDeadlineAtMs();
        return [
          connectionKey,
          {
            ...(connection.kind === "hosted"
              ? { kind: "hosted" as const, subscriptionKey: connectionKey }
              : { kind: "session" as const }),
            startedAt: connection.startedAt,
            deliveredThroughOffset: connection.deliveredThroughOffset,
            lag: Math.max(0, maxOffset - connection.deliveredThroughOffset),
            batchesSent: connection.batchesSent,
            eventsSent: connection.eventsSent,
            bytesSent: connection.bytesSent,
            lastDeliveredAt: connection.lastDeliveredAt,
            hasPendingDelivery: connection.hasPendingDelivery(),
            ...(pendingDeliveryDeadlineAtMs === null
              ? {}
              : {
                  pendingDeliveryDeadlineAt: new Date(pendingDeliveryDeadlineAtMs).toISOString(),
                  ...(pendingDeliveryStartedAtMs === null
                    ? {}
                    : {
                        pendingDeliveryStartedAt: new Date(
                          pendingDeliveryStartedAtMs,
                        ).toISOString(),
                      }),
                }),
            ...(completionLatencyMs === null ? {} : { completionLatencyMs }),
            ...(pingRttMs === null ? {} : { pingRttMs }),
            ...(connection.openedBy === undefined ? {} : { openedBy: connection.openedBy }),
          },
        ];
      }),
    );
  }

  armOrClearIdleAlarm(): void {
    // Teardown's own close-fact appends reconcile through here while the
    // remainder still looks idle-eligible with stale activity; arming from
    // that nested turn issues one pointless immediate wake per teardown.
    if (this.#tearingDown) return;
    const eligible = this.#idleEligibleConnectionKeys();
    // Wedged connections are excluded from the activity derivation (teardown
    // still closes them, but never acks or memoizes them) — their in-flight
    // watchdog owns their future, and letting their stale lastDeliveredAt
    // drive a past-due idle deadline would arm an immediate alarm every turn.
    const idleCandidates = [...eligible.hosted, ...eligible.session].filter(
      (key) => this.#connections.get(key)?.hasPendingDelivery() !== true,
    );
    if (idleCandidates.length === 0) {
      this.#idleTeardownAtMs = null;
      return;
    }
    // Level-triggered, derived from observable state: the deadline is "idle
    // window after the newest delivery activity", never "idle window after
    // this reconcile". The old now+window reset slid the deadline forward on
    // the idle alarm's OWN turn, so a fire landing moments before the freshly
    // pushed deadline missed it and rearmed a whole window out — real-clock
    // idle teardown could take 2× the window (proven against a deployed
    // preview). Deriving from lastDeliveredAt makes a fire always find the
    // same due deadline it was armed for.
    let lastActivityMs = 0;
    for (const connectionKey of idleCandidates) {
      const connection = this.#connections.get(connectionKey);
      if (connection === undefined) continue;
      const activityMs = Date.parse(connection.lastDeliveredAt ?? connection.startedAt);
      if (Number.isFinite(activityMs) && activityMs > lastActivityMs) lastActivityMs = activityMs;
    }
    this.#idleTeardownAtMs =
      (lastActivityMs === 0 ? this.#hooks.now() : lastActivityMs) + this.#idleTeardownMs;
    this.#hooks.armAlarm(Math.max(this.#hooks.now(), this.#idleTeardownAtMs));
  }

  runIdleTeardownNow(): string[] {
    this.#idleTeardownAtMs = null;
    const { hosted, session } = this.#idleEligibleConnectionKeys();
    const keys = [...hosted, ...session];
    const wedgedKeys = new Set(
      hosted.filter((key) => this.#connections.get(key)?.hasPendingDelivery() === true),
    );
    this.#tearingDown = true;
    try {
      for (const connectionKey of keys) this.close(connectionKey, "idle");
    } finally {
      this.#tearingDown = false;
    }
    // Closing each callback appends its connection-closed fact synchronously.
    // A settled hosted processor has already handled everything that existed
    // before teardown, and waking it solely to consume those close facts would
    // create an immediate close -> wake -> open -> idle-close loop. Advance its
    // cursor through the close facts on purpose. A processor that consumes
    // connection presence sees them on its next real wake, when the runner
    // replays from its own reported checkpoint; the sending cursor is only the
    // source stream's wake/delivery position.
    const maxOffset = this.#hooks.coreState().maxOffset;
    for (const connectionKey of hosted) {
      if (wedgedKeys.has(connectionKey)) continue;
      this.#hooks.store.ack(connectionKey, maxOffset);
    }
    // Session connections have no cursor row; their equivalent of the ack
    // above is the wake-socket attachment stamp, which must likewise land
    // AFTER the close facts so those facts can never wake the subscriber.
    if (session.length > 0) this.#hooks.onSessionsIdleClosed(session);
    this.#idleTeardownAtMs = null;
    if (wedgedKeys.size > 0) queueMicrotask(() => this.#hooks.sendDueSubscriptions());
    return keys.filter((connectionKey) => !wedgedKeys.has(connectionKey));
  }

  /**
   * Hosted connections are always idle-eligible (the durable subscription
   * re-wakes them). A session connection is eligible only when its owner's
   * relay holds a live wake socket; every other session connection keeps
   * today's semantics — it lives (and pins) as long as its session does.
   */
  #idleEligibleConnectionKeys(): { hosted: string[]; session: string[] } {
    const hosted: string[] = [];
    const session: string[] = [];
    let wakeKeys: ReadonlySet<string> | undefined;
    for (const [connectionKey, connection] of this.#connections) {
      if (connection.kind === "hosted") hosted.push(connectionKey);
      else if ((wakeKeys ??= this.#hooks.wakeChannelKeys()).has(connectionKey)) {
        session.push(connectionKey);
      }
    }
    return { hosted, session };
  }

  #open<Batch extends StreamEventBatch>(args: OpenConnectionArgs<Batch>): StreamConnection {
    const { connectionKey, kind, processEventBatch } = args;
    const deliverEvents = args.events !== false;
    const coreState = this.#hooks.coreState();
    const openedAtOffset = coreState.maxOffset;
    if (kind === "hosted" && args.expectedHostedDelivery === undefined) {
      processEventBatch[Symbol.dispose]();
      throw new Error("hosted processor connections require the expected delivery state");
    }
    if (
      args.replayAfterOffset !== undefined &&
      (!Number.isSafeInteger(args.replayAfterOffset) || args.replayAfterOffset < 0)
    ) {
      processEventBatch[Symbol.dispose]();
      throw new Error("replayAfterOffset must be a non-negative safe integer");
    }
    if (
      args.expectedStreamId !== undefined &&
      args.expectedStreamId !== null &&
      args.expectedStreamId.trim().length === 0
    ) {
      processEventBatch[Symbol.dispose]();
      throw new Error("expectedStreamId must be null or a non-empty string");
    }
    if (
      args.expectedStreamId !== undefined &&
      (coreState.streamId ?? null) !== args.expectedStreamId
    ) {
      processEventBatch[Symbol.dispose]();
      throw new Error(
        `stream ID changed (${String(args.expectedStreamId)} -> ${String(coreState.streamId ?? null)})`,
      );
    }
    if (
      args.maxReplayOffsetGap !== undefined &&
      (!Number.isSafeInteger(args.maxReplayOffsetGap) || args.maxReplayOffsetGap < 0)
    ) {
      processEventBatch[Symbol.dispose]();
      throw new Error("maxReplayOffsetGap must be a non-negative safe integer");
    }
    let deliveredThroughOffset = deliverEvents
      ? (args.replayAfterOffset ?? openedAtOffset)
      : openedAtOffset;
    if (deliveredThroughOffset > openedAtOffset) {
      processEventBatch[Symbol.dispose]();
      throw new Error(
        `replayAfterOffset ${deliveredThroughOffset} is greater than the stream maximum offset ${openedAtOffset}`,
      );
    }
    if (
      deliverEvents &&
      args.maxReplayOffsetGap !== undefined &&
      openedAtOffset - deliveredThroughOffset > args.maxReplayOffsetGap
    ) {
      processEventBatch[Symbol.dispose]();
      throw new Error(
        `replay gap ${openedAtOffset - deliveredThroughOffset} exceeds maxReplayOffsetGap ${args.maxReplayOffsetGap}`,
      );
    }

    this.#connections.get(connectionKey)?.close("replaced");
    try {
      const openedRecorded = this.#hooks.appendDeliveryEvent({
        type: "events.iterate.com/stream/connection-opened",
        payload: {
          connectionKey,
          kind,
          ...(args.openedBy === undefined ? {} : { openedBy: args.openedBy }),
        },
      });
      if (!openedRecorded) {
        throw Object.assign(
          new Error(
            `connection "${connectionKey}" opened-event append was interrupted by Durable Object lifecycle teardown`,
          ),
          { retryable: true },
        );
      }
    } catch (error) {
      // The callback crossed an RPC boundary before this method started, so
      // this method owns it even when the durable opened fact cannot commit.
      processEventBatch[Symbol.dispose]();
      throw error;
    }

    let initialBatchPending = true;
    let sendLoopRunning = false;
    let open = true;
    let hostedBatchPending = false;
    let hostedBatchToken: symbol | null = null;
    let hostedBatchStartedAtMs: number | null = null;
    let hostedBatchDeadlineAtMs: number | null = null;
    let hostedBatchProbeAtMs: number | null = null;
    let connection!: StreamConnection;

    const sendQueuedBatches = async () => {
      if (sendLoopRunning || (kind === "hosted" && hostedBatchPending)) return;
      sendLoopRunning = true;
      try {
        while (open) {
          let events: StreamEvent[] = [];
          let deliveredBytes = 0;
          const scannedAfterOffset = deliveredThroughOffset;
          if (deliverEvents) {
            const readEvents = this.#hooks.readBatch(
              deliveredThroughOffset,
              Number.MAX_SAFE_INTEGER,
              kind === "hosted" ? HOSTED_SCAN_EVENT_LIMIT : DELIVERY_BATCH_LIMIT,
            );
            const lastOffset = readEvents.at(-1)?.event.offset;
            if (lastOffset === undefined) {
              const currentMaxOffset = this.#hooks.coreState().maxOffset;
              if (currentMaxOffset <= deliveredThroughOffset && !initialBatchPending) return;
              deliveredThroughOffset = Math.max(deliveredThroughOffset, currentMaxOffset);
            } else {
              deliveredThroughOffset = lastOffset;
              const visible =
                kind === "hosted"
                  ? readEvents.filter((entry) => entry.event.ephemeral !== true)
                  : readEvents;
              const matched =
                args.filter === undefined
                  ? visible
                  : visible.filter((entry) => args.filter!.matches(entry.event));
              const delivered =
                kind === "hosted"
                  ? matched.slice(0, HOSTED_CALLBACK_EVENT_LIMIT)
                  : capSessionDelivery(matched, args.maxDeliveryEvents, args.maxDeliveryBytes);
              // If more matching hosted work remains in the scanned window,
              // stop at the last event actually handed to the callback. The
              // next acknowledged batch resumes immediately after it; all
              // preceding non-matches have still been skipped durably.
              const lastDeliveredOffset = delivered.at(-1)?.event.offset;
              deliveredThroughOffset =
                delivered.length < matched.length && lastDeliveredOffset !== undefined
                  ? lastDeliveredOffset
                  : lastOffset;
              events = delivered.map((entry) => entry.event);
              deliveredBytes = delivered.reduce((sum, entry) => sum + entry.byteLength, 0);
            }
          } else {
            const stateMaxOffset = this.#hooks.coreState().maxOffset;
            if (stateMaxOffset <= deliveredThroughOffset && !initialBatchPending) return;
            deliveredThroughOffset = stateMaxOffset;
          }
          if (
            kind === "session" &&
            args.includeState === false &&
            deliverEvents &&
            events.length === 0 &&
            !initialBatchPending
          ) {
            // A state-free batch whose filter rejected every event has no
            // payload. Advance the cursor without calling the consumer, but
            // preserve the loop's cooperative yield while scanning a large
            // non-matching backlog. The greeting batch still seeds its cursor.
            await Promise.resolve();
            continue;
          }
          initialBatchPending = false;
          connection.batchesSent += 1;
          connection.eventsSent += events.length;
          connection.bytesSent += deliveredBytes;
          connection.lastDeliveredAt = new Date(this.#hooks.now()).toISOString();
          this.#hooks.recordEgress(events.length, deliveredBytes);
          const currentState = this.#hooks.coreState();
          if (
            currentState.projectId === undefined ||
            currentState.path === undefined ||
            currentState.streamId === undefined
          ) {
            throw new Error("Cannot deliver stream batch before stream identity is initialized.");
          }
          const newestCreatedAtMs =
            events.length === 0 ? undefined : Date.parse(events.at(-1)!.createdAt);
          const batch = {
            projectId: currentState.projectId,
            path: currentState.path,
            streamId: currentState.streamId,
            events,
            scannedAfterOffset,
            scannedThroughOffset: deliveredThroughOffset,
            streamMaxOffset: currentState.maxOffset,
            state: args.includeState === false ? null : currentState,
          } satisfies StreamEventBatch;
          if (kind === "hosted") {
            const expectedDelivery = args.expectedHostedDelivery!;
            const deliveryToken = Symbol("hosted stream delivery");
            hostedBatchPending = true;
            hostedBatchToken = deliveryToken;
            hostedBatchStartedAtMs = this.#hooks.now();
            hostedBatchDeadlineAtMs = hostedBatchStartedAtMs + DEFAULT_DELIVERY_TIMEOUT_MS;
            hostedBatchProbeAtMs = hostedBatchStartedAtMs + HOSTED_PENDING_PROBE_INTERVAL_MS;
            // This SQLite write and the native alarm are both issued before
            // the callback leaves the source DO. The output gate therefore
            // makes a vanished isolate recover as an expired durable attempt,
            // not as an unbounded series of first-attempt wake calls.
            this.#hooks.store.markInFlight(connectionKey, {
              deadlineAt: hostedBatchDeadlineAtMs,
              connectionGeneration: expectedDelivery.connectionGeneration,
              cursorChangedAtOffset: expectedDelivery.cursorChangedAtOffset,
            });
            this.#hooks.armAlarm(hostedBatchDeadlineAtMs);
            this.#hooks.armAlarm(hostedBatchProbeAtMs);
            (processEventBatch as unknown as RetainedProcessEventBatch<StreamWakeEventBatch>)({
              ...batch,
              reportDeliveryResult: (deliveryResult) => {
                // Each callback belongs to exactly one batch. Duplicate or
                // late reports cannot complete a replacement connection or the
                // next batch on this connection.
                if (hostedBatchToken !== deliveryToken) return;
                hostedBatchPending = false;
                hostedBatchToken = null;
                hostedBatchStartedAtMs = null;
                hostedBatchDeadlineAtMs = null;
                hostedBatchProbeAtMs = null;
                const parsed = parseWakeDeliveryResult(deliveryResult);
                if (
                  parsed.outcome === "ok" &&
                  connection.isLive() &&
                  this.#connections.get(connectionKey) === connection &&
                  this.#hooks.hostedDeliveryStillMatches(connectionKey, expectedDelivery)
                ) {
                  this.#hooks.store.clearInFlight(connectionKey, {
                    connectionGeneration: expectedDelivery.connectionGeneration,
                    cursorChangedAtOffset: expectedDelivery.cursorChangedAtOffset,
                  });
                  // The batch's pre-armed watchdog is now moot; let the full
                  // recomputation decide whether anything still needs a turn.
                  this.#hooks.reconcileAlarm();
                  if (newestCreatedAtMs !== undefined && Number.isFinite(newestCreatedAtMs)) {
                    const completedAtMs = this.#hooks.now();
                    connection.completionLatency.record(
                      completedAtMs - newestCreatedAtMs,
                      completedAtMs,
                    );
                  }
                  // Run after this sendQueuedBatches's finally clears
                  // `sendLoopRunning`; this is the only path that dispatches
                  // the next hosted batch.
                  queueMicrotask(() => connection.sendQueued());
                } else if (
                  parsed.outcome === "error" &&
                  connection.isLive() &&
                  this.#connections.get(connectionKey) === connection
                ) {
                  this.onHostedDeliveryError(connectionKey, parsed.error, expectedDelivery);
                }
                this.#hooks.runtimeChanged();
              },
            } satisfies StreamWakeEventBatch);
          } else {
            (processEventBatch as RetainedProcessEventBatch<StreamEventBatch>)(batch);
          }
          this.#hooks.runtimeChanged();
          // Hosted processors acknowledge in order, one batch at a time. Do
          // not await the remote promise in this invocation tree; the result callback
          // or the native-alarm watchdog starts the next state transition.
          if (kind === "hosted") return;
          await Promise.resolve();
        }
      } catch (error) {
        if (kind === "hosted" && args.expectedHostedDelivery !== undefined) {
          this.onHostedDeliveryError(connectionKey, error, args.expectedHostedDelivery);
        } else {
          const details = { connectionKey, error };
          if (error instanceof EventFilterEvaluationError) {
            console.info("stream session filter condition failed; closing connection", details);
          } else {
            console.error("stream session callback failed; closing connection", details);
          }
          connection.close("delivery-failed", connectionError(error));
        }
      } finally {
        sendLoopRunning = false;
      }
    };

    connection = {
      kind,
      ...(args.expectedHostedDelivery === undefined
        ? {}
        : { expectedHostedDelivery: args.expectedHostedDelivery }),
      startedAt: new Date(this.#hooks.now()).toISOString(),
      ...(args.openedBy === undefined ? {} : { openedBy: args.openedBy }),
      getProcessorRuntimeState: retainGetProcessorRuntimeState(args.getRuntimeState),
      ping: retainConnectionPing(args.ping),
      get deliveredThroughOffset() {
        return deliveredThroughOffset;
      },
      batchesSent: 0,
      eventsSent: 0,
      bytesSent: 0,
      completionLatency: new LatencyRing(),
      pingRtt: new LatencyRing(),
      sendQueued: () => void sendQueuedBatches(),
      isLive: () => open,
      hasPendingDelivery: () => (kind === "hosted" ? hostedBatchPending : false),
      pendingDeliveryStartedAtMs: () => hostedBatchStartedAtMs,
      pendingDeliveryDeadlineAtMs: () => hostedBatchDeadlineAtMs,
      takeDuePendingDeliveryProbe: (nowMs) => {
        if (hostedBatchProbeAtMs === null || hostedBatchProbeAtMs > nowMs) return false;
        hostedBatchProbeAtMs = null;
        return true;
      },
      schedulePendingDeliveryProbe: (atMs) => {
        if (hostedBatchPending) hostedBatchProbeAtMs = atMs;
      },
      close: (reason, error) => {
        if (!open) return;
        open = false;
        hostedBatchPending = false;
        hostedBatchToken = null;
        hostedBatchStartedAtMs = null;
        hostedBatchDeadlineAtMs = null;
        hostedBatchProbeAtMs = null;
        if (this.#connections.get(connectionKey) === connection) {
          this.#connections.delete(connectionKey);
          this.#hooks.runtimeChanged();
        }
        connection.ping?.[Symbol.dispose]();
        processEventBatch[Symbol.dispose]();
        connection.getProcessorRuntimeState?.[Symbol.dispose]();
        // Best-effort by design. A lifecycle-interrupted append loses this
        // observation exactly as abrupt isolate death does: the in-memory
        // connection table is its only witness, so a fresh incarnation has
        // nothing durable from which to retry. Runtime state, not paired
        // opened/closed events, remains authoritative for "open now".
        void this.#hooks.appendDeliveryEvent({
          type: "events.iterate.com/stream/connection-closed",
          payload: { connectionKey, reason, ...(error === undefined ? {} : { error }) },
        });
        if (reason === "rpc-broken" || reason === "delivery-failed") {
          this.#hooks.sendDueSubscriptions();
        }
      },
    };

    // The opened fact was recorded before this object retained optional
    // capabilities or published the callback in the in-memory table.
    // Appending it ran the stream's post-commit send check synchronously;
    // publishing first would let a hosted callback receive a batch before the
    // wake path records the processor's reported checkpoint.
    this.#connections.set(connectionKey, connection);
    this.#hooks.runtimeChanged();
    // Idle eligibility changed exactly here, so (re)derive the deadline here.
    // The connection-opened append's nested reconcile ran BEFORE this
    // publication and could not see the connection; on main the stray
    // in-flight watchdog alarm papered over that gap by re-running the
    // reconcile later, but with quiet-alarm deletion there may be no later
    // fire — an unarmmed idle deadline would pin this connection forever.
    this.armOrClearIdleAlarm();
    processEventBatch.onRpcBroken?.((error) => {
      if (kind === "hosted" && args.expectedHostedDelivery !== undefined) {
        this.onHostedDeliveryError(connectionKey, error, args.expectedHostedDelivery, "rpc-broken");
      } else {
        connection.close("rpc-broken", connectionError(error));
      }
    });
    if (args.sendOnOpen !== false) connection.sendQueued();
    return connection;
  }
}

/** Turn the hosted processor's wire-safe result into the error shape used by retry policy. */
function parseWakeDeliveryResult(
  value: StreamWakeDeliveryResult,
): { outcome: "ok" } | { outcome: "error"; error: Error } {
  const candidate = value as Partial<StreamWakeDeliveryResult> | null;
  if (candidate?.outcome === "ok") return { outcome: "ok" };
  if (candidate?.outcome !== "error" || !("error" in candidate)) {
    return {
      outcome: "error",
      error: new Error("hosted processor reported an invalid delivery result"),
    };
  }
  const serialized = candidate.error as Partial<StreamWakeDeliveryError> | null;
  if (typeof serialized?.name !== "string" || typeof serialized.message !== "string") {
    return {
      outcome: "error",
      error: new Error("wake delivery reported an invalid failure"),
    };
  }
  const error = new Error(serialized.message);
  error.name = serialized.name;
  return {
    outcome: "error",
    error: Object.assign(error, {
      ...(typeof serialized.itxCallId === "string" &&
      serialized.itxCallId.length > 0 &&
      serialized.itxCallId.length <= 200
        ? { itxCallId: serialized.itxCallId }
        : {}),
      ...(serialized.durableObjectReset === true ? { durableObjectReset: true } : {}),
      ...(serialized.overloaded === true ? { overloaded: true } : {}),
      ...(serialized.retryable === true ? { retryable: true } : {}),
    }),
  };
}
