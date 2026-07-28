// Stored subscriptions: configuration, receiver calls, source-stored cursors,
// failing-event retries, and expiry. Live callback sends, connection
// generations, ping metrics, and idle
// teardown are the independent StreamConnections state machine.
//
// Every receiver gets stream events through one of these mechanics:
//
// | receiver kind    | operation                                      | acknowledgement       |
// |------------------|------------------------------------------------|-----------------------|
// | session callback | call the callback from `openConnection()`      | result stays unpulled |
// | hosted processor | wake it, retain its returned callback          | processor checkpoint  |
// | cross-post       | append copies to another Stream Durable Object | receiving append      |
// | ITX expression   | evaluate and await the named method             | method result          |
// | webhook          | send one attributed HTTP POST per event         | 2xx response           |
//
// Session connections are forgotten when they close.
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
// cross-post/ITX/webhook: the receiver call returns), and callback owners that hand over a ping capability
// get NTP-style RTT sampled when runtime observation begins, throttled, and
// purely observational (a failed ping drops the sample, nothing else).
// Session-callback consumption is deliberately NOT measured here: those results stay
// unread (zero returned event batches), and the receiving processor reports through
// its getRuntimeState capability instead (see event-consumption-metrics.ts).
//
// This module is transport-free, clock-free, and randomness-free: everything
// it touches arrives through `StreamEventSenderHooks` (storage, log reads, the
// calls to receivers, time, backoff jitter, and the alarm). Subscription behavior is proven at
// the public seam in stream-connections-and-subscriptions.e2e.test.ts; the only streams file
// that knows RPC exists is subscription-receiver-calls.ts.

import type { StreamEvent, StreamEventInput } from "iterate/processors";
import type {
  GetProcessorRuntimeState,
  ProcessEventBatch,
  ProcessorRuntimeState,
  StreamDeliveryBatch,
  CrossPostReceipt,
  StreamConnectionPing,
  StreamProcessorWakeRequest,
  StreamWebhookDelivery,
} from "iterate/processors";
import { isStreamReceiverUnavailableError } from "iterate/processors";
import { LatencyRing, type LatencyStats } from "iterate/processors";
import type { ItxExpression } from "../../itx/expression.ts";
import type {
  CoreProcessorState,
  SubscriptionConfiguredPayload,
  SubscriptionReceiver,
  ConnectionOpenerDescriptor,
  ConnectionCloseReason,
} from "./core-processor-contract.ts";
import {
  ConnectionOpenerDescriptor as ConnectionOpenerDescriptorSchema,
  subscriptionConfigurationForDelivery,
  subscriptionConfiguredPayloadFromReducedState,
} from "./core-processor-contract.ts";
import { compileEventFilter, type CompiledEventFilter } from "./event-filter.ts";
import {
  StreamConnections,
  type ConnectionRuntimeState,
  type ExpectedDeliveryState,
  type ExpectedHostedDeliveryState,
  type StreamConnection,
} from "./stream-connections.ts";
import {
  boundedErrorMessage,
  DEFAULT_DELIVERY_TIMEOUT_MS,
  errorMessage,
  hasStructuredIdPrefix,
  internalStreamId,
  internalStreamIdPrefix,
  withDeliveryTimeout,
} from "./stream-delivery-utils.ts";
import type { SizedStreamEvent, SubscriptionCursorStore } from "./stream-storage.ts";
import type { RetainedProcessorWakeResponse } from "./retained-event-callbacks.ts";
import {
  computeBackoffMs,
  deliveryId,
  DELIVERY_BATCH_BYTE_LIMIT,
  DELIVERY_BATCH_LIMIT,
  halveBatchLimit,
  initialCursorFor,
  MAX_FAILING_EVENT_SKIPS_SINCE_LAST_SUCCESS,
  MAX_DELIVERY_ATTEMPTS,
  FAILING_EVENT_CONFIRM_ATTEMPTS,
} from "./delivery-math.ts";
import { isRetryableDurableObjectAvailabilityError } from "./stream-unavailable.ts";

/** Short, bounded retry when a Durable Object lifecycle turn interrupts a required event append. */
const LIFECYCLE_RETRY_DELAY_MS = 1_000;

/** Serializable debug view of one stored subscription's cursor row, for `runtimeState()`. */
export type SubscriptionRuntimeState = {
  /** Exclusive. Source-owned acknowledged offset or hosted processor's last reported checkpoint. */
  acknowledgedOffset: number;
  /** Selected source events acknowledged since the current configuration event. */
  acknowledgedEvents: number;
  /** `maxOffset - acknowledgedOffset`, per subscription. */
  lag: number;
  attempt: number;
  nextAttemptAt: number | null;
  inFlightDeadlineAt: number | null;
  lastError: string | null;
  /** Serialized payload bytes delivered by cross-post, ITX-call, and webhook subscriptions. */
  bytesSent?: number;
  /** Commit-to-acked latency (stream clock): newest event `createdAt` → awaited delivery resolved. */
  completionLatencyMs?: LatencyStats;
  /** Duration of the awaited cross-post, ITX, or webhook call itself. */
  deliveryDurationMs?: LatencyStats;
};

/**
 * A complete cross-post list may reach a new receiver before the old receiver has
 * recorded its removal. That is safe only while matching-event delivery stays
 * stopped. The last acknowledged key list in core state makes this check
 * replayable and per-key, avoiding global ordering between unrelated list
 * copies.
 */
function subscriptionStillRecordedByAnotherStream(
  state: CoreProcessorState,
  subscriptionKey: string,
  currentReceivingStreamPath?: string,
): boolean {
  return Object.entries(state.crossPostListDeliveriesByReceivingStream).some(
    ([otherReceivingStreamPath, list]) =>
      otherReceivingStreamPath !== currentReceivingStreamPath &&
      list.subscriptionKeysRecordedByReceiver.includes(subscriptionKey),
  );
}

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
  /** Deliver a batch to a stream, which appends source.crossPostedFrom to each event. */
  crossPostToStream(path: string, batch: StreamDeliveryBatch): Promise<CrossPostReceipt>;
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
   * Run durable delivery in its alarm-owned invocation. The production Stream
   * DO schedules an immediate alarm when called from an append and runs the
   * closure only when delivery is already running inside that alarm turn.
   */
  runDurable(work: () => Promise<unknown>): void;
  /** Keep the Durable Object alive through background delivery work. */
  keepAlive(promise: Promise<unknown>): void;
};

export class StreamEventSender {
  readonly #hooks: StreamEventSenderHooks;
  readonly #connections: StreamConnections;

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
  /** Bisect state for onFailingEvent:"skip" — current batch ceiling per key. */
  readonly #batchLimits = new Map<string, number>();
  /**
   * Per-subscription delivery metrics for cross-post, ITX-call, and webhook
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
    this.#connections = new StreamConnections({
      idleTeardownMs: args.idleTeardownMs,
      hooks: {
        readBatch: (afterOffset, beforeOffset, limit) =>
          this.#readBatch(afterOffset, beforeOffset, limit),
        coreState: args.hooks.coreState,
        store: args.hooks.store,
        appendDeliveryEvent: args.hooks.appendDeliveryEvent,
        recordEgress: args.hooks.recordEgress,
        runtimeChanged: args.hooks.runtimeChanged,
        now: args.hooks.now,
        armAlarm: args.hooks.armAlarm,
        keepAlive: args.hooks.keepAlive,
        hostedDeliveryStillMatches: (subscriptionKey, expectedDelivery) =>
          this.#deliveryStillMatches(subscriptionKey, expectedDelivery),
        onHostedDeliveryFailure: (subscriptionKey, error) =>
          this.#onDeliveryFailure(subscriptionKey, error),
        sendDueSubscriptions: () => this.sendDue(),
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
   * pending cross-post, ITX-call, or webhook events. Never throws; never blocks the append.
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
      this.#connections.closeStaleHosted((connectionKey) =>
        state.subscriptions.outbound.byKey[connectionKey] === undefined
          ? "subscription-removed"
          : "replaced",
      );
      this.#connections.sendQueued();
      if (this.#connections.isTearingDown) {
        this.#armAlarmFromStore();
        this.#consecutiveSendStartFailures = 0;
        return true;
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
    this.#rememberIdleHostedCallbacks(this.#connections.onAlarm());
    this.#failExpiredHostedDeliveries();
    return this.sendDue();
  }

  // ===========================================================================
  // Live session connections (the `openConnection()` verb).
  // ===========================================================================

  openSession(args: {
    connectionKey: string;
    processEventBatch: ProcessEventBatch;
    replayAfterOffset?: number;
    expectedStreamId?: string | null;
    maxReplayOffsetGap?: number;
    filter?: CompiledEventFilter;
    events?: boolean;
    openedBy?: ConnectionOpenerDescriptor;
    getRuntimeState?: GetProcessorRuntimeState;
    ping?: StreamConnectionPing;
  }): StreamConnection {
    return this.#connections.openSession(args);
  }

  // ===========================================================================
  // Durable sending: hosted-processor wake, cross-post/ITX/webhook sends, retries,
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
      this.#batchLimits.delete(row.subscriptionKey);
      this.#subscriptionMetrics.delete(row.subscriptionKey);
      this.#hostedIdledAtOffset.delete(row.subscriptionKey);
    }

    for (const [subscriptionKey, entry] of Object.entries(state.subscriptions.outbound.byKey)) {
      const config = entry.configuration;
      const configOffset = entry.configuredAtOffset;

      // The receiver-specific initial-cursor policy lives in ONE place
      // (delivery-math.initialCursorFor) so boot recovery and ordinary
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

      if (this.#endSubscriptionIfSatisfied(subscriptionKey)) continue;
      this.#armSubscriptionDeadline(config);

      // Do not send matching source events until the receiving stream has durably
      // recorded this source's current list. End conditions still run while it is
      // unavailable, so an expired subscription is removed from that set.
      if (config.receiver.action === "cross-post") {
        const list =
          state.crossPostListDeliveriesByReceivingStream[config.receiver.receivingStreamPath];
        if (list === undefined || list.status !== "confirmed") continue;
      }
      if (
        subscriptionStillRecordedByAnotherStream(
          state,
          subscriptionKey,
          config.receiver.action === "cross-post" ? config.receiver.receivingStreamPath : undefined,
        )
      ) {
        continue;
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
          this.#connections.has(subscriptionKey) ||
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
   * after its subscription was replaced (or switched to cross-post, ITX-call, or webhook),
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
        const connection = this.#connections.openHosted({
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
      }
    });
  }

  /**
   * Send pending events for one cross-post, ITX-call, or webhook configuration:
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
          if (receiver.action === "cross-post") {
            const list =
              state.crossPostListDeliveriesByReceivingStream[receiver.receivingStreamPath];
            if (list === undefined || list.status !== "confirmed") return;
          }
          if (
            subscriptionStillRecordedByAnotherStream(
              state,
              subscriptionKey,
              receiver.action === "cross-post" ? receiver.receivingStreamPath : undefined,
            )
          ) {
            return;
          }
          const row = this.#hooks.store.get(subscriptionKey);
          if (row === undefined) return;
          if (row.nextAttemptAt !== null && row.nextAttemptAt > this.#hooks.now()) return;
          const expectedDelivery = {
            configuredAtOffset: entry.configuredAtOffset,
            cursorChangedAtOffset: row.cursorChangedAtOffset,
          };
          activeDeliveryState = expectedDelivery;

          // Webhook delivery pins the common durable-subscription send loop to batch size 1: external
          // receivers get single-event POSTs, each ack covers exactly one
          // offset (mid-batch resume for free), the failing event machinery always
          // sees the true delivery unit (bisecting is structurally moot), and
          // the per-iteration staleness checks above run per EVENT — a
          // removed/replaced webhook can never keep POSTing a stale batch to
          // the old URL. The cost is one row/config re-read per event on a
          // backlog, noise against the HTTP POST itself.
          let limit =
            receiver.action === "webhook-post"
              ? 1
              : Math.min(
                  this.#batchLimits.get(subscriptionKey) ?? DELIVERY_BATCH_LIMIT,
                  DELIVERY_BATCH_LIMIT,
                );
          let beforeOffset = Number.MAX_SAFE_INTEGER;
          for (const condition of config.endWhen?.any ?? []) {
            if (condition.kind === "acknowledged-events") {
              // The end condition is a hard dispatch boundary, not a check
              // after an arbitrarily large batch has already crossed it.
              limit = Math.min(limit, condition.count - row.acknowledgedEvents);
            } else if (condition.kind === "source-offset-acknowledged") {
              // Storage range bounds are exclusive; include the terminal
              // source offset itself and never read any row after it.
              beforeOffset = Math.min(beforeOffset, condition.offset + 1);
            }
          }
          if (limit <= 0) {
            this.#endSubscriptionIfSatisfied(subscriptionKey);
            return;
          }

          const sized = this.#readBatch(row.acknowledgedOffset, beforeOffset, limit);
          const lastOffset = sized.at(-1)?.event.offset;
          if (lastOffset === undefined) {
            // The allocator's maximum offset can be greater than the last surviving row after
            // ephemeral eviction. An empty range read proves that whole suffix
            // contains no durable work, so advance the durable cursor through
            // it instead of reporting permanent phantom lag.
            const boundedMaxOffset = Math.min(state.maxOffset, beforeOffset - 1);
            if (row.acknowledgedOffset < boundedMaxOffset) {
              this.#hooks.store.ack(subscriptionKey, boundedMaxOffset, {
                cursorChangedAtOffset: row.cursorChangedAtOffset,
                preserveFailingEventSkips: true,
              });
              this.#endSubscriptionIfSatisfied(subscriptionKey);
            }
            return;
          }
          const byteLengthByOffset = new Map(
            sized.map((entry) => [entry.event.offset, entry.byteLength]),
          );

          // Durable delivery skips ephemeral rows unless the subscription
          // explicitly opts in. The cursor still advances over skipped rows.
          const visible = receiver.delivery.includeEphemeral
            ? sized.map((entry) => entry.event)
            : sized.filter((entry) => entry.event.ephemeral !== true).map((entry) => entry.event);
          const deliverable = visible.filter((event) => {
            // This source-private acknowledgement must not consume a finite
            // send count or reach any receiver through a wildcard filter.
            if (event.type === "events.iterate.com/stream/cross-post-list-confirmed") {
              return false;
            }
            // A receiver writes this audit event without `source.crossPostedFrom`.
            // Copying it to another stream would start a fresh provenance chain;
            // a wildcard cycle could then manufacture drop records forever.
            return !(
              receiver.action === "cross-post" &&
              event.type === "events.iterate.com/stream/cross-posted-events-dropped"
            );
          });
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
            this.#endSubscriptionIfSatisfied(subscriptionKey);
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
          let acknowledgedEvents = matched.length;
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
                  event: matched[0]!,
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
                events: matched,
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
              if (receiver.action === "cross-post") {
                const receipt = await withDeliveryTimeout(
                  this.#hooks.receiverCalls.crossPostToStream(receiver.receivingStreamPath, batch),
                  `stream ${subscriptionKey}`,
                );
                const droppedOffsets = Array.isArray(receipt.dropped)
                  ? receipt.dropped.map((entry) => entry.offset)
                  : [];
                if (
                  !Number.isSafeInteger(receipt.accepted) ||
                  receipt.accepted < 0 ||
                  !Array.isArray(receipt.dropped) ||
                  new Set(droppedOffsets).size !== droppedOffsets.length ||
                  receipt.dropped.some(
                    (entry) =>
                      (entry.reason !== "cycle" && entry.reason !== "hop-limit") ||
                      !Number.isSafeInteger(entry.offset) ||
                      !matched.some((event) => event.offset === entry.offset),
                  ) ||
                  receipt.accepted + receipt.dropped.length !== matched.length
                ) {
                  throw new Error(
                    `cross-post receiver returned an invalid receipt for ${matched.length} delivered events`,
                  );
                }
                // Appended events and cycle/hop-limit drops are both terminal
                // acknowledgements: they advance the cursor and consume a
                // finite event-count boundary exactly once.
                acknowledgedEvents = receipt.accepted + receipt.dropped.length;
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
            // (halved the bisect window or stepped over confirmed failing event) and
            // the loop should try again NOW; anything else backs off or halts
            // and the alarm/resume owns the future.
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
            acknowledgedEvents,
          });
          if (this.#endSubscriptionIfSatisfied(subscriptionKey)) return;
          this.#batchLimits.delete(subscriptionKey);
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
   * A cross-post, ITX-call, or webhook delivery failed. `halt` policy (and every hosted wake
   * failure) goes through the shared backoff/halt machine. `skip` policy first bisects the batch to
   * isolate the failing event, requires FAILING_EVENT_CONFIRM_ATTEMPTS consecutive
   * failures of that lone event before stepping over it, and still halts when
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
    // A receiver that declared itself unavailable, or a receiver call rejected
    // by workerd because its Durable Object is temporarily unavailable, is
    // down rather than unable to digest one event. Never turn infrastructure
    // overload into a permanent skip verdict.
    //
    // The same batch backs off and redelivers whole, and sustained
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
    // A stream transform is evaluated by the receiving stream so the source
    // cannot know the failing offset up front. Narrow a failed batch until
    // healthy prefixes commit and the exact poison event is the only retry
    // left. Cross-post subscriptions halt rather than skip once that event is isolated.
    if (
      config.receiver.action === "cross-post" &&
      config.receiver.transform !== undefined &&
      matched.length > 1
    ) {
      this.#bisectBatch(subscriptionKey, matched.length);
      return "continue";
    }
    if (
      config.receiver.action !== "processor-wake" &&
      config.receiver.delivery.onFailingEvent === "skip"
    ) {
      if (matched.length > 1) {
        // Bisect immediately; the receiver proved it is alive enough to reject.
        this.#bisectBatch(subscriptionKey, matched.length);
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
      // Step over the confirmed failing event and reset the bisect window +
      // failure streak: the receiver is alive, it just cannot digest that one.
      if (row === undefined) return "stop";
      this.#hooks.store.ackFailingEventSkipped(
        subscriptionKey,
        failingEvent.offset,
        row.cursorChangedAtOffset,
      );
      this.#endSubscriptionIfSatisfied(subscriptionKey);
      this.#batchLimits.delete(subscriptionKey);
      return "continue";
    }

    const row = this.#hooks.store.get(subscriptionKey);
    this.#onDeliveryFailure(subscriptionKey, error, row?.attempt ?? 0);
    return "stop";
  }

  #bisectBatch(subscriptionKey: string, failedBatchSize: number): void {
    const current = this.#batchLimits.get(subscriptionKey) ?? DELIVERY_BATCH_LIMIT;
    this.#batchLimits.set(subscriptionKey, halveBatchLimit(Math.min(current, failedBatchSize)));
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
    this.#batchLimits.delete(subscriptionKey);
  }

  #armAlarmFromStore(): void {
    // Not a bare MIN over the rows: halted rows keep their cursor but must
    // not arm the alarm, and a row whose retry is in flight this very turn
    // still carries its (past) due time until the attempt settles — re-arming
    // from either spins the alarm at zero delay.
    const state = this.#hooks.coreState();
    let next: number | null = null;
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
      if (row.nextAttemptAt === null) continue;
      if (next === null || row.nextAttemptAt < next) next = row.nextAttemptAt;
    }
    for (const entry of Object.values(state.subscriptions.outbound.byKey)) {
      for (const condition of entry.configuration.endWhen?.any ?? []) {
        if (condition.kind !== "time") continue;
        const deadline = Date.parse(condition.at);
        if (Number.isFinite(deadline) && deadline > this.#hooks.now()) {
          if (next === null || deadline < next) next = deadline;
        }
      }
    }
    if (next !== null) this.#hooks.armAlarm(next);
    this.#connections.rearmIdleAlarm();
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

  /** Append the ordinary removal event once any durable end condition is true. */
  #endSubscriptionIfSatisfied(subscriptionKey: string): boolean {
    const entry = this.#hooks.coreState().subscriptions.outbound.byKey[subscriptionKey];
    const conditions = entry?.configuration.endWhen?.any;
    if (entry === undefined || conditions === undefined) return false;
    const row = this.#hooks.store.get(subscriptionKey);
    const now = this.#hooks.now();
    const expired = conditions.some(
      (condition) => condition.kind === "time" && Date.parse(condition.at) <= now,
    );
    const completed = conditions.some((condition) => {
      if (condition.kind === "acknowledged-events") {
        return (row?.acknowledgedEvents ?? 0) >= condition.count;
      }
      if (condition.kind === "source-offset-acknowledged") {
        return (row?.acknowledgedOffset ?? 0) >= condition.offset;
      }
      return false;
    });
    if (!expired && !completed) return false;

    const appended = this.#hooks.appendDeliveryEvent({
      type: "events.iterate.com/stream/subscription-removed",
      idempotencyKey: internalStreamId(
        "subscription-ended",
        subscriptionKey,
        entry.configuredAtOffset,
      ),
      payload: {
        subscriptionKey,
        reason: expired ? "expired" : "completed",
      },
    });
    // A lifecycle interruption means the ordinary removal is still owed.
    // Keep delivery stopped in this incarnation and durably arrange another
    // retry instead of silently converting a finite subscription
    // into an unbounded one.
    if (!appended) this.#hooks.armAlarm(now + LIFECYCLE_RETRY_DELAY_MS);
    return true;
  }

  #armSubscriptionDeadline(config: SubscriptionConfiguredPayload): void {
    for (const condition of config.endWhen?.any ?? []) {
      if (condition.kind !== "time") continue;
      const deadline = Date.parse(condition.at);
      if (Number.isFinite(deadline) && deadline > this.#hooks.now()) {
        this.#hooks.armAlarm(deadline);
      }
    }
  }

  // ===========================================================================
  // ===========================================================================
  // Live callback connections delegate to their own runtime state machine.
  // ===========================================================================

  onHostedDeliveryError(
    subscriptionKey: string,
    error: unknown,
    expectedDelivery: ExpectedHostedDeliveryState,
  ): void {
    this.#connections.onHostedDeliveryError(subscriptionKey, error, expectedDelivery);
  }

  close(subscriptionKey: string, reason: ConnectionCloseReason): void {
    this.#connections.close(subscriptionKey, reason);
  }

  hasConnection(subscriptionKey: string): boolean {
    return this.#connections.has(subscriptionKey);
  }

  connectionKind(connectionKey: string): StreamConnection["kind"] | undefined {
    return this.#connections.connectionKind(connectionKey);
  }

  getProcessorRuntimeState(subscriptionKey: string): Promise<ProcessorRuntimeState | null> {
    return this.#connections.getProcessorRuntimeState(subscriptionKey);
  }

  samplePingsSoon(): void {
    this.#connections.samplePingsSoon();
  }

  connectionRuntimeState(): Record<string, ConnectionRuntimeState> {
    return this.#connections.runtimeState();
  }
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
            acknowledgedEvents: row?.acknowledgedEvents ?? 0,
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

  armOrClearIdleAlarm(): void {
    this.#connections.armOrClearIdleAlarm();
  }

  runIdleTeardownNow(): void {
    this.#rememberIdleHostedCallbacks(this.#connections.runIdleTeardownNow());
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
