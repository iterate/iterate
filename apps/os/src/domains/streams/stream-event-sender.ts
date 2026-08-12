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
// Session connections are forgotten when they close (a stream-subscriber-pager-backed
// session's dormancy lives on in its socket attachment — stream-subscriber-pager.ts —
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
import { eventCanWakeDormantSubscriber } from "./stream-subscriber-pager.ts";

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
/** Briefly coalesce active bursts, then release every callback that can be re-paged or re-woken. */
const IDLE_CONNECTION_TEARDOWN_MS = 5_000;

/** Soft cap on a delivery batch's payload bytes (large events shrink the batch). */
const DELIVERY_BATCH_BYTE_LIMIT = 1024 * 1024;

/**
 * Incarnation/connection lifecycle facts withheld from COPY receivers. Every
 * boot appends a fresh unkeyed `stream/woken`, and a copy delivery can itself
 * boot the hibernated peer — with the circuit breaker deliberately ignoring
 * control events, a reciprocal wildcard copy pair would manufacture wake (and
 * hosted-lane connection) events forever. Local readers of the source stream
 * are unaffected; only cross-stream copy delivery skips them.
 */
const COPY_WITHHELD_LIFECYCLE_EVENT_TYPES = new Set<string>([
  "events.iterate.com/stream/woken",
  "events.iterate.com/stream/connection-opened",
  "events.iterate.com/stream/connection-closed",
]);

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
  return config.receiver.action === "facet-processor" || config.receiver.action === "wake-processor"
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
  name: string,
  cursorChangedAtSourceOffset: number,
  firstOffset: number,
  lastOffset: number,
) {
  return structuredId(
    "delivery",
    streamId,
    name,
    cursorChangedAtSourceOffset,
    firstOffset,
    lastOffset,
  );
}

/** Short, bounded retry when a Durable Object lifecycle turn interrupts a required event append. */
const LIFECYCLE_RETRY_DELAY_MS = 1_000;

/** Serializable debug view of one stored subscription's cursor row, for `runtimeState()`. */
export type SubscriptionRuntimeState = {
  /** Exclusive: the receiver durably claims through this offset. */
  confirmedOffset: number;
  /** `maxOffset - confirmedOffset`. */
  lag: number;
  /** Mirrored delivery status: `active` or `halted`. */
  status: "active" | "halted";
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
 * One explicit call per receiver variant. Hosted-processor wake dials by the
 * receiver's placement (parent→facet, or an ITX expression against the
 * stream's fresh authority root); only wake returns a callback to retain.
 */
export type SubscriptionReceiverCalls = {
  /** Start or revive a hosted processor and retain its returned callback. */
  wakeStreamProcessor(
    receiver: Extract<SubscriptionReceiver, { action: "facet-processor" | "wake-processor" }>,
    request: StreamProcessorWakeRequest,
    expectedDelivery: ExpectedHostedDeliveryState,
  ): Promise<RetainedProcessorWakeResponse>;
  /** Evaluate an ITX receiver expression and invoke it. Resolve = acknowledgement. */
  deliverToItx(expression: ItxExpression, batch: StreamDeliveryBatch): Promise<void>;
  /** Deliver a batch to a stream, which appends source.copiedFrom to each event. */
  copyToStream(path: string, batch: StreamDeliveryBatch): Promise<CopyReceipt>;
  /**
   * POST one event to the webhook URL. Resolve (2xx) = the whole
   * acknowledgement; non-2xx rejects. The response body is discarded.
   */
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
  /**
   * This incarnation's deploy version. Stamped on halts and compared against
   * the halt's recorded version: a mismatch is the antidote deploy and earns
   * one automatic resume (see {@link StreamEventSender.sendDue}'s halt check).
   */
  workerVersion(): string;
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
   * connectionKeys whose client has given this DO a live hibernatable
   * Subscriber Pager (stream-subscriber-pager.ts).
   * Only such session connections are idle-teardown-eligible: severing a
   * session callback with no Pager would strand the subscriber with
   * no way to learn about new events.
   */
  subscriberPagerConnectionKeys(): ReadonlySet<string>;
  /**
   * Idle teardown just closed these session connections; ensure this
   * teardown's own close facts can never wake the subscribers they closed.
   * Called AFTER the close-fact appends, mirroring the hosted cursor ack.
   */
  onSessionsIdleClosed(connectionKeys: readonly string[]): void;
  /**
   * Post-commit: offer just-committed events to dormant Pager-backed
   * subscribers (stream-subscriber-pager.ts). Edge-triggered by design — a Page lost to
   * a crash between commit and send is repaired by the next qualifying
   * append (or the relay's liveness probe), never by the repair alarm.
   */
  pageDormantSubscribers(justCommitted: SizedStreamEvent[]): void;
};

export class StreamEventSender {
  readonly #hooks: StreamEventSenderHooks;
  /** The live-callback state machine (session + hosted callbacks); see below. */
  readonly connections: StreamConnections;

  // In-memory state for durable sending. All of it is reconstructible: a DO eviction
  // resets these and the durable rows + folded config re-derive every decision
  // (at-least-once absorbs the repeats).
  readonly #hostedWakesInFlight = new Set<string>();
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
   * Halt instances already offered their antidote resume by THIS incarnation,
   * keyed exactly like the append's idempotency key. The stream's idempotency
   * dedupe is the durable guard; this set only keeps one incarnation's
   * level-triggered send checks from re-dialing the same no-op append.
   */
  readonly #antidoteResumesAttempted = new Set<string>();
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
  constructor(args: { hooks: StreamEventSenderHooks }) {
    this.#hooks = args.hooks;
    this.connections = new StreamConnections({
      hooks: {
        ...args.hooks,
        readBatch: (afterOffset, beforeOffset, limit) =>
          this.#readBatch(afterOffset, beforeOffset, limit),
        hostedDeliveryStillMatches: (name, expectedDelivery) =>
          this.#deliveryStillMatches(name, expectedDelivery),
        onHostedDeliveryFailure: (name, error) => this.#onDeliveryFailure(name, error),
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
        state.subscriptions.outbound.byName[connectionKey] === undefined
          ? "subscription-removed"
          : "replaced",
      );
      this.connections.sendQueued();
      if (this.connections.isTearingDown) {
        // Also guards the dormant-Page offer below: close-fact appends during
        // teardown must not fan back out to the subscribers they closed.
        this.#armAlarmFromStore();
        this.#consecutiveSendStartFailures = 0;
        return true;
      }
      if (justCommittedEvents !== undefined && justCommittedEvents.length > 0) {
        this.#hooks.pageDormantSubscribers(justCommittedEvents);
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
    this.connections.onAlarm();
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
    const configuredSubscriptionNames = new Set(Object.keys(state.subscriptions.outbound.byName));

    // Cursor rows and in-memory retry state are mutable projections of the
    // reduced configuration. Remove anything whose subscription no longer exists on
    // every send check, not only on the event edge or after an eviction.
    for (const row of this.#hooks.store.list()) {
      if (configuredSubscriptionNames.has(row.name)) continue;
      this.#hooks.store.delete(row.name);
      this.#limitNextReadToOne.delete(row.name);
      this.#subscriptionMetrics.delete(row.name);
    }

    for (const [name, entry] of Object.entries(state.subscriptions.outbound.byName)) {
      const config = entry.configuration;
      const configOffset = entry.configuredAtOffset;

      // The receiver-specific initial-cursor policy lives in ONE place
      // (initialCursorFor above) so boot recovery and ordinary
      // post-commit reconciliation cannot drift.
      this.#hooks.store.ensure(name, initialCursorFor(config, configOffset), configOffset);

      // A cursor-set event is durable intent. Apply the newest request whenever
      // reduced state is ahead of the mutable cursor row; this repairs an
      // interruption after the event committed and makes older seeks unable to
      // rewind a newer cursor generation.
      let row = this.#hooks.store.get(name);
      if (
        entry.cursorSet !== undefined &&
        config.receiver.action !== "facet-processor" &&
        config.receiver.action !== "wake-processor" &&
        row !== undefined &&
        row.cursorChangedAtOffset < entry.cursorSet.setAtSourceOffset
      ) {
        this.#hooks.store.setCursor(
          name,
          entry.cursorSet.afterOffset,
          entry.cursorSet.setAtSourceOffset,
        );
        row = this.#hooks.store.get(name);
      }

      // Mirror the reduced-state delivery status onto the row, level-triggered:
      // halted is event-sourced (the fold is authoritative); the row's copy
      // exists so cursor-row readers see one self-describing record.
      const desiredStatus =
        entry.deliveryHalted !== undefined ? ("halted" as const) : ("active" as const);
      if (row !== undefined && row.status !== desiredStatus) {
        this.#hooks.store.setStatus(name, desiredStatus);
        row = this.#hooks.store.get(name);
      }

      if (entry.deliveryHalted !== undefined) {
        this.#resumeHaltFromAntidoteDeploy(name, entry.configuredAtOffset, entry.deliveryHalted);
        continue;
      }

      if (row === undefined) continue; // unreachable after ensure; defensive
      if (row.inFlightDeadlineAt !== null) {
        this.#hooks.armAlarm(row.inFlightDeadlineAt);
        continue;
      }
      if (row.nextAttemptAt !== null && row.nextAttemptAt > now) continue; // alarm owns it
      if (
        config.receiver.action === "facet-processor" ||
        config.receiver.action === "wake-processor"
      ) {
        if (this.connections.has(name) || this.#hostedWakesInFlight.has(name)) {
          continue;
        }
        if (row.nextAttemptAt === null) {
          if (row.confirmedOffset >= state.maxOffset) continue;

          // The hosted cursor is the complete dormancy record. Idle teardown
          // advances it through its own close fact; a later incarnation may
          // add only `woken` before checking the subscription. Absorb that
          // lifecycle-only suffix durably instead of resurrecting the
          // processor. The explicit-filter carve-out matches session Pagers:
          // a subscriber that names a lifecycle type still wakes for it.
          const pending = this.#readBatch(
            row.confirmedOffset,
            Number.MAX_SAFE_INTEGER,
            HOSTED_SCAN_EVENT_LIMIT,
          );
          const completeSuffix =
            pending.length < HOSTED_SCAN_EVENT_LIMIT ||
            pending.at(-1)?.event.offset === state.maxOffset;
          const explicitTypes = config.filter?.eventTypes;
          const lifecycleOnly = pending.every(
            ({ event }) => !eventCanWakeDormantSubscriber(event.type, explicitTypes),
          );
          if (completeSuffix && lifecycleOnly) {
            this.#hooks.store.ack(name, state.maxOffset, {
              cursorChangedAtOffset: row.cursorChangedAtOffset,
            });
            continue;
          }
        }
        this.#wakeStreamProcessor(name, config.receiver, {
          configuredAtOffset: configOffset,
          cursorChangedAtOffset: row.cursorChangedAtOffset,
          connectionGeneration: ++this.#nextHostedConnectionGeneration,
        });
        continue;
      }

      if (row.confirmedOffset >= state.maxOffset) continue; // caught up; nothing to send

      if (this.#sourceOwnedSendsInFlight.has(name)) continue;
      this.#sendPendingSourceOwnedEvents(name);
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
    name: string,
    receiver: Extract<SubscriptionReceiver, { action: "facet-processor" | "wake-processor" }>,
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
      // Name IS the contract slug for processor-wake subscriptions (enforced
      // at configure time), so the request needs no separate slug field.
      name,
    };

    this.#hooks.runDurable(async () => {
      if (this.#hostedWakesInFlight.has(name)) return;
      this.#hostedWakesInFlight.add(name);
      try {
        if (!this.#deliveryStillMatches(name, expectedDelivery)) return;
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
          receiver,
          request,
          expectedDelivery,
        );
        const response = await withDeliveryTimeout(wakePromise, `wake hosted processor ${name}`, {
          onLateResolve: (late) => late.processEventBatch[Symbol.dispose](),
        });
        const current = this.#hooks.coreState().subscriptions.outbound.byName[name];
        if (
          !this.#deliveryStillMatches(name, expectedDelivery) ||
          (current?.configuration.receiver.action !== "facet-processor" &&
            current?.configuration.receiver.action !== "wake-processor")
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
        /*
         * NAMING THE TYPE IS THE OPT-IN, and it is the only one.
         *
         * An ephemeral event reaches a hosted processor when its contract
         * lists that exact type in `consumes` — never through the `"*"`
         * wildcard, which exists for durable facts and must not hand anyone a
         * microphone firehose they did not ask for. That single rule is why
         * ephemeral types live in `consumes` beside durable ones instead of in
         * a parallel list: one vocabulary, and the explicitness IS the
         * permission.
         *
         * A processor that announces nothing gets durable events only, which
         * is what every processor written before this did.
         */
        const explicitlyConsumed = new Set((consumes ?? []).filter((type) => type !== "*"));
        const connection = this.connections.openHosted({
          connectionKey: name,
          expectedHostedDelivery: expectedDelivery,
          processEventBatch: response.processEventBatch,
          replayAfterOffset: response.checkpointOffset,
          filter: {
            matches(event) {
              if (!configuredFilter.matches(event)) return false;
              if (event.ephemeral === true) return explicitlyConsumed.has(event.type);
              return announcedFilter === undefined || announcedFilter.matches(event);
            },
          },
          openedBy,
          getRuntimeState: response.getRuntimeState,
          ping: response.ping,
        });
        // The wake response's checkpoint IS a reported checkpoint: the far
        // side durably claims through it, so it lands in `processed_through_offset`.
        // While the connection streams, the stored confirmation deliberately
        // goes stale (batch acks settle the watchdog without confirming); its
        // job is deciding whether to wake the processor when no callback
        // exists, and a stale row costs one redundant wake. The confirm write
        // clears the retry schedule always, but the failure streak only on PROGRESS —
        // a successful wake proves the host is reachable, not that
        // deliveries succeed, and resetting the counter without progress is
        // what let a deterministically failing processor spin forever.
        this.#hooks.store.confirm(name, response.checkpointOffset, {
          cursorChangedAtOffset: expectedDelivery.cursorChangedAtOffset,
        });
        connection.sendQueued();
      } catch (error) {
        if (this.#deliveryStillMatches(name, expectedDelivery)) {
          this.#onDeliveryFailure(name, error);
        } else {
          queueMicrotask(() => this.sendDue());
        }
      } finally {
        this.#hostedWakesInFlight.delete(name);
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
  #sendPendingSourceOwnedEvents(name: string): void {
    this.#hooks.runDurable(async () => {
      if (this.#sourceOwnedSendsInFlight.has(name)) return;
      this.#sourceOwnedSendsInFlight.add(name);
      let activeDeliveryState: ExpectedDeliveryState | undefined;
      try {
        for (;;) {
          const state = this.#hooks.coreState();
          const entry = state.subscriptions.outbound.byName[name];
          if (entry === undefined || entry.deliveryHalted !== undefined) {
            return;
          }
          const config = entry.configuration;
          const receiver = config.receiver;
          if (receiver.action === "facet-processor" || receiver.action === "wake-processor") return;
          const row = this.#hooks.store.get(name);
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
            receiver.action === "webhook-post" || this.#limitNextReadToOne.has(name)
              ? 1
              : DELIVERY_BATCH_LIMIT;

          // The one scheduling rule: delivery resumes after `confirmed`.
          const sized = this.#readBatch(row.confirmedOffset, Number.MAX_SAFE_INTEGER, limit, {
            byteLimit: DELIVERY_BATCH_BYTE_LIMIT,
          });
          const lastOffset = sized.at(-1)?.event.offset;
          if (lastOffset === undefined) {
            // The allocator's maximum offset can be greater than the last surviving row after
            // ephemeral eviction. An empty range read proves that whole suffix
            // contains no durable work, so advance the durable cursor through
            // it instead of reporting permanent phantom lag.
            if (row.confirmedOffset < state.maxOffset) {
              this.#hooks.store.ack(name, state.maxOffset, {
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
          // Incarnation/connection lifecycle facts are withheld for the same
          // reason: every boot appends a fresh unkeyed `stream/woken`, a copy
          // delivery can itself wake (boot) the hibernated peer, and the
          // circuit breaker deliberately ignores control events — so a
          // reciprocal wildcard pair would manufacture wake events forever. A
          // foreign incarnation's lifecycle is not product data on the
          // receiver; local consumers on the source stream see it unchanged.
          const deliverable =
            receiver.action === "copy-to-stream"
              ? visible.filter(
                  (event) =>
                    !COPY_WITHHELD_LIFECYCLE_EVENT_TYPES.has(event.type) &&
                    !hasStructuredIdPrefix(
                      event.idempotencyKey,
                      internalStreamIdPrefix("copy-drop"),
                    ),
                )
              : visible;
          const { matched, failure: filterFailure } = this.#applyFilter(
            name,
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
                name,
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
            this.#hooks.store.ack(name, lastOffset, {
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
            throw new Error(`subscription "${name}" exists on an uninitialized stream`);
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
                    name,
                    receiver.jsonataTransform,
                    matched[0]!,
                  ),
                  // The subscription's opaque NAME.
                  name,
                  cursorChangedAtSourceOffset: row.cursorChangedAtOffset,
                  deliveryId: deliveryId(
                    streamId,
                    name,
                    row.cursorChangedAtOffset,
                    matched[0]!.offset,
                    deliveredThroughOffset,
                  ),
                  attempt: row.attempt + 1,
                  configuredEvent,
                }),
                `webhook ${name}`,
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
                        applyJsonataTransform("itx", name, receiver.jsonataTransform, event),
                      )
                    : matched,
                streamMaxOffset: state.maxOffset,
                // The subscription's opaque NAME.
                name,
                cursorChangedAtSourceOffset: row.cursorChangedAtOffset,
                deliveryId: deliveryId(
                  streamId,
                  name,
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
                  `stream ${name}`,
                );
              } else {
                await withDeliveryTimeout(
                  this.#hooks.receiverCalls.deliverToItx(receiver.expression, batch),
                  `itx expression ${name}`,
                );
              }
            }
          } catch (error) {
            // The receiverCalls yielded to the event loop. A cursor seek, removal, or
            // same-name replacement may have landed while the old receiver was
            // in flight. Its eventual rejection belongs to that older configuration
            // and must not back off, halt, or skip work for the new one.
            if (!this.#deliveryStillMatches(name, expectedDelivery)) continue;
            // "continue" = the failure handler already moved the goalposts
            // (dropped the next read straight to batch size 1 or stepped over
            // a confirmed failing event) and the loop should try again NOW;
            // anything else backs off or halts and the alarm/resume owns the
            // future.
            if (this.#onSourceOwnedFailure({ name, config, matched, error }) === "continue") {
              continue;
            }
            return;
          }
          // A successful call from an older configuration must not advance the
          // current cursor, metrics, or finite-delivery counters.
          if (!this.#deliveryStillMatches(name, expectedDelivery)) continue;
          // The awaited resolve above IS this receiver's acknowledgement — record
          // both the call duration (transport+receiver latency) and the
          // commit→acked age of the newest delivered event, all on the
          // stream's own clock.
          const completedAtMs = this.#hooks.now();
          const subscriptionMetrics = this.#subscriptionMetricsFor(name);
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
          this.#hooks.store.ack(name, deliveredThroughOffset, {
            cursorChangedAtOffset: row.cursorChangedAtOffset,
          });
          this.#limitNextReadToOne.delete(name);
        }
      } catch (error) {
        console.error("durable subscription send loop failed", { name, error });
        // An unexpected local delivery-loop failure is still a bounded, observable
        // delivery failure. Without this transition a quiet stream could keep
        // an active row forever with neither an alarm nor a halted event.
        const entry = this.#hooks.coreState().subscriptions.outbound.byName[name];
        if (
          activeDeliveryState !== undefined &&
          this.#deliveryStillMatches(name, activeDeliveryState) &&
          entry !== undefined &&
          entry.configuration.receiver.action !== "facet-processor" &&
          entry.configuration.receiver.action !== "wake-processor"
        ) {
          this.#onDeliveryFailure(name, error);
        } else {
          queueMicrotask(() => this.sendDue());
        }
      } finally {
        this.#sourceOwnedSendsInFlight.delete(name);
        this.reconcileAlarmAfterSettlement();
      }
    });
  }

  /**
   * A halted subscription's only automatic way back: the antidote deploy.
   * The halt records the deploy version that gave up; a send check under a
   * DIFFERENT version appends one `subscription-delivery-resumed`, giving the
   * receiver a fresh bounded ladder — a receiver fixed by the deploy recovers
   * with no operator, and a still-broken one re-halts under the new version
   * and stays quiet until the next deploy. Halts recorded before the version
   * stamp existed are grandfathered: without a recorded version, "same deploy
   * that just gave up" and "antidote deploy" are indistinguishable, and
   * guessing would loop a same-version halt — those still need the operator
   * doors. Mirrors the keepalive crash-loop breaker's version reset
   * (docs/writing-stream-processors.md): a halt is a breaker, and a version
   * change is the antidote that earns exactly one immediate retry.
   *
   * Without this, a halt was forever unless a human noticed the one red row:
   * the 2026-08-12 preview_8 media incident halted a project-worker feed
   * ~30 seconds after a redeploy and every later append stalled silently —
   * runtime state even looks clean because the halt clears the backoff ladder.
   */
  #resumeHaltFromAntidoteDeploy(
    name: string,
    configuredAtOffset: number,
    halt: { afterOffset: number; attempts: number; workerVersion?: string },
  ): void {
    const version = this.#hooks.workerVersion();
    if (halt.workerVersion === undefined || halt.workerVersion === version) return;
    const idempotencyKey = internalStreamId(
      "halt-antidote-resume",
      name,
      configuredAtOffset,
      halt.afterOffset,
      halt.attempts,
      version,
    );
    if (this.#antidoteResumesAttempted.has(idempotencyKey)) return;
    // Mark attempted only AFTER the append succeeds: the durable idempotency
    // key already makes repeats converge, so the set exists purely to spare
    // repeated no-op dials — an early mark on a FAILED append would poison
    // this incarnation's retry (e.g. a stream paused at boot rejects the
    // resume; the later unpause must still get one).
    let recorded: boolean;
    try {
      recorded = this.#hooks.appendDeliveryEvent({
        type: "events.iterate.com/stream/subscription-delivery-resumed",
        idempotencyKey,
        payload: { name },
      });
    } catch (error) {
      // A paused stream rejects the resume append (only halt/pause control
      // events commit while paused). Contained here so one halted
      // subscription cannot abort the whole send check; the unpause event's
      // own post-commit send check retries this branch.
      console.warn("halt antidote resume append failed; a later send check retries", {
        name,
        error,
      });
      return;
    }
    if (!recorded) {
      // Lifecycle teardown interrupted the append. A fresh incarnation owns
      // the retry (its attempted-set starts empty); arrange the wake it needs.
      this.#hooks.armAlarm(this.#hooks.now() + LIFECYCLE_RETRY_DELAY_MS);
      return;
    }
    this.#antidoteResumesAttempted.add(idempotencyKey);
  }

  /**
   * Whether this async call still belongs to the same configuration and cursor.
   * The configuration offset detects remove/recreate and same-key replacement;
   * the cursor-changing event offset detects a seek appended during the call.
   */
  #deliveryStillMatches(name: string, expectedDelivery: ExpectedDeliveryState): boolean {
    const entry = this.#hooks.coreState().subscriptions.outbound.byName[name];
    const row = this.#hooks.store.get(name);
    return (
      entry?.configuredAtOffset === expectedDelivery.configuredAtOffset &&
      row?.configuredAtOffset === expectedDelivery.configuredAtOffset &&
      row.cursorChangedAtOffset === expectedDelivery.cursorChangedAtOffset
    );
  }

  /**
   * Read up to `limit` events after `afterOffset`, shrinking under the byte
   * cap (at least one event is always kept so an oversized event cannot wedge
   * delivery). A
   * reader positioned exactly before the just-committed first event consumes the
   * handed-over fresh events instead of re-reading them from SQLite — the
   * committed objects are byte-for-byte what a read-back would parse (append
   * strict-parses the body and stamps `path` before commit).
   */
  #readBatch(
    afterOffset: number,
    beforeOffset: number,
    limit: number,
    options: { byteLimit?: number } = {},
  ): SizedStreamEvent[] {
    const byteLimit = options.byteLimit ?? DELIVERY_BATCH_BYTE_LIMIT;
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
      if (bytes > byteLimit && index > 0) {
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
    name: string,
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
            name,
          )
        ) {
          continue;
        }
        const filterError = new Error(
          `subscription "${name}" filter condition failed on offset ${event.offset}: ${errorMessage(error)}`,
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
                name,
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
    name: string;
    config: SubscriptionConfiguredPayload;
    matched: StreamEvent[];
    error: unknown;
  }): "continue" | "stop" {
    const { name, config, matched, error } = args;
    this.#limitNextReadToOne.add(name);
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
      this.#onDeliveryFailure(name, error);
      return "stop";
    }
    if (
      config.receiver.action !== "facet-processor" &&
      config.receiver.action !== "wake-processor" &&
      config.receiver.delivery.onFailingEvent === "skip"
    ) {
      if (matched.length > 1) {
        // Retry NOW at batch size 1; the receiver proved it is alive enough
        // to reject, and the healthy prefix should commit without backoff.
        return "continue";
      }
      const failingEvent = matched[0]!;
      const row = this.#hooks.store.get(name);
      const deliveryAttempt = (row?.attempt ?? 0) + 1;
      const failingEventAttempt =
        row?.failingEventOffset === failingEvent.offset ? row.failingEventAttempt + 1 : 1;
      if (failingEventAttempt < FAILING_EVENT_CONFIRM_ATTEMPTS) {
        this.#backoff(name, deliveryAttempt, error, {
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
        this.#halt(name, deliveryAttempt, error);
        return "stop";
      }
      const recorded = this.#hooks.appendDeliveryEvent({
        type: "events.iterate.com/stream/error-occurred",
        idempotencyKey: internalStreamId(
          "subscription-failing-event-skipped",
          name,
          failingEvent.offset,
          row?.cursorChangedAtOffset ?? 0,
        ),
        payload: {
          message: `subscription "${name}" skipped failing event at offset ${failingEvent.offset} after ${failingEventAttempt} event-specific attempts: ${errorMessage(error)}`,
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
        name,
        failingEvent.offset,
        row.cursorChangedAtOffset,
      );
      this.#limitNextReadToOne.delete(name);
      return "continue";
    }

    const row = this.#hooks.store.get(name);
    this.#onDeliveryFailure(name, error, row?.attempt ?? 0);
    return "stop";
  }

  /** Shared failure path for hosted wake and halt-policy delivery. */
  #onDeliveryFailure(name: string, error: unknown, previousAttempts?: number): void {
    const attempts = previousAttempts ?? this.#hooks.store.get(name)?.attempt ?? 0;
    const attempt = attempts + 1;
    // A receiver that reports its failure as deterministic (a worker source
    // build that cannot compile, `retryable: false`) will fail identically on
    // every retry; halt now with the exact error instead of burning the
    // attempt ladder against a foregone conclusion.
    if ((error as { retryable?: unknown } | null)?.retryable === false) {
      this.#halt(name, attempt, error);
      return;
    }
    if (attempt >= MAX_DELIVERY_ATTEMPTS) {
      this.#halt(name, attempt, error);
      return;
    }
    this.#backoff(name, attempt, error);
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
      const entry = this.#hooks.coreState().subscriptions.outbound.byName[row.name];
      if (
        entry === undefined ||
        entry.deliveryHalted !== undefined ||
        entry.configuredAtOffset !== row.configuredAtOffset ||
        (entry.configuration.receiver.action !== "facet-processor" &&
          entry.configuration.receiver.action !== "wake-processor")
      ) {
        this.#hooks.store.clearInFlight(row.name, {
          connectionGeneration: row.inFlightConnectionGeneration ?? -1,
          cursorChangedAtOffset: row.cursorChangedAtOffset,
        });
        continue;
      }
      this.#onDeliveryFailure(
        row.name,
        new Error(
          `hosted processor batch acknowledgement timed out after ${DEFAULT_DELIVERY_TIMEOUT_MS}ms; the source isolate no longer owns a live callback`,
        ),
        row.attempt,
      );
    }
  }

  #backoff(
    name: string,
    attempt: number,
    error: unknown,
    failingEvent?: { offset: number; attempt: number },
  ): void {
    const nextAttemptAt = this.#hooks.now() + computeBackoffMs(attempt, this.#hooks.random());
    this.#hooks.store.nack(name, {
      attempt,
      nextAttemptAt,
      error: errorMessage(error),
      ...(failingEvent === undefined ? {} : { failingEvent }),
    });
    this.#hooks.armAlarm(nextAttemptAt);
  }

  /**
   * Give up loudly: the halted event reduces into core state (delivery stops) and
   * shows red in the UI. Idempotent per (name, cursor) so redeliveries of the
   * failure cannot spam the log. `subscription-delivery-resumed` (or a fresh
   * `subscription-configured`) is the way back.
   */
  #halt(name: string, attempts: number, error: unknown): void {
    // State-guarded, not idempotency-keyed: a halt after resume at an unmoved
    // cursor is a NEW transition and must land as a new event (an idempotency
    // key derived from the cursor would swallow it and the subscription would
    // retry forever without ever turning red again). Duplicate dropping
    // comes from the fold: while halted, the send loop never runs this path.
    if (this.#hooks.coreState().subscriptions.outbound.byName[name]?.deliveryHalted !== undefined) {
      return;
    }
    const row = this.#hooks.store.get(name);
    const terminalError = boundedErrorMessage(error);
    const recorded = this.#hooks.appendDeliveryEvent({
      type: "events.iterate.com/stream/subscription-delivery-halted",
      payload: {
        name,
        reason: "delivery-failed",
        afterOffset: row?.confirmedOffset ?? 0,
        attempts,
        ...(terminalError === undefined ? {} : { error: terminalError }),
        // The antidote-retry comparison side: a send check under a LATER
        // version resumes this halt once (#resumeHaltFromAntidoteDeploy).
        workerVersion: this.#hooks.workerVersion(),
      },
    });
    if (!recorded) {
      // Halting is an appended event, not an in-memory state transition. Keep
      // the failed row retryable until that event commits so a lifecycle interruption can
      // neither strand the subscription nor erase the durable explanation.
      const nextAttemptAt = this.#hooks.now() + LIFECYCLE_RETRY_DELAY_MS;
      this.#hooks.store.nack(name, {
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
    // the attempts + error for the audit trail); an equal-offset ack is a
    // no-move under the monotonic max.
    if (row !== undefined) this.#hooks.store.ack(name, row.confirmedOffset);
    this.#limitNextReadToOne.delete(name);
  }

  #armAlarmFromStore(): void {
    // Not a bare MIN over the rows: halted rows keep their cursor but must
    // not arm the alarm, and a row whose retry is in flight this turn still
    // carries its (past) due time until the attempt settles — re-arming
    // from either spins the alarm at zero delay.
    const state = this.#hooks.coreState();
    let next: number | null = null;
    let lagWithoutSchedule = false;
    for (const row of this.#hooks.store.list()) {
      const key = row.name;
      const configured = state.subscriptions.outbound.byName[key];
      if (configured === undefined) {
        this.#hooks.store.delete(key);
        continue;
      }
      if (configured.deliveryHalted !== undefined) {
        continue;
      }
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
        if (row.confirmedOffset < state.maxOffset) lagWithoutSchedule = true;
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

  #subscriptionMetricsFor(name: string) {
    let metrics = this.#subscriptionMetrics.get(name);
    if (metrics === undefined) {
      metrics = {
        completionLatency: new LatencyRing(),
        deliveryDuration: new LatencyRing(),
        bytesSent: 0,
      };
      this.#subscriptionMetrics.set(name, metrics);
    }
    return metrics;
  }

  // ===========================================================================
  // Runtime debug state and idle teardown.
  // ===========================================================================

  subscriptionRuntimeState(): Record<string, SubscriptionRuntimeState> {
    const state = this.#hooks.coreState();
    const rows = new Map(this.#hooks.store.list().map((row) => [row.name, row]));
    return Object.fromEntries(
      Object.keys(state.subscriptions.outbound.byName).map((name) => {
        const row = rows.get(name);
        const confirmedOffset = row?.confirmedOffset ?? 0;
        const metrics = this.#subscriptionMetrics.get(name);
        const completionLatencyMs = metrics?.completionLatency.stats() ?? null;
        const deliveryDurationMs = metrics?.deliveryDuration.stats() ?? null;
        return [
          name,
          {
            confirmedOffset,
            lag: Math.max(0, state.maxOffset - confirmedOffset),
            status: row?.status ?? "active",
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
        name: string;
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
  /** `false` sends batches with `state: null` — set per session connection (#2384). */
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
  | "subscriberPagerConnectionKeys"
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
  readonly #connections = new Map<string, StreamConnection>();
  #idleTeardownAtMs: number | null = null;
  #tearingDown = false;
  #lastPingRoundAtMs: number | null = null;

  constructor(args: { hooks: StreamConnectionsHooks }) {
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
              ? { kind: "hosted" as const, name: connectionKey }
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
    // Pending connections are excluded from both activity derivation and
    // teardown — their in-flight watchdog owns their future. Letting stale
    // lastDeliveredAt drive a past-due idle deadline would arm an immediate
    // alarm every turn, while closing them would interrupt legitimate work.
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
      (lastActivityMs === 0 ? this.#hooks.now() : lastActivityMs) + IDLE_CONNECTION_TEARDOWN_MS;
    this.#hooks.armAlarm(Math.max(this.#hooks.now(), this.#idleTeardownAtMs));
  }

  runIdleTeardownNow(): string[] {
    this.#idleTeardownAtMs = null;
    const { hosted, session } = this.#idleEligibleConnectionKeys();
    // This alarm can be due because a quiet sibling armed it. Never let that
    // sibling's lease dispose a different callback whose batch is still live.
    const idleHosted = hosted.filter(
      (key) => this.#connections.get(key)?.hasPendingDelivery() === false,
    );
    const idleSessions = session.filter(
      (key) => this.#connections.get(key)?.hasPendingDelivery() === false,
    );
    const keys = [...idleHosted, ...idleSessions];
    this.#tearingDown = true;
    try {
      for (const connectionKey of keys) this.close(connectionKey, "idle");
    } finally {
      this.#tearingDown = false;
    }
    // Closing each callback appends its connection-closed fact synchronously.
    // A settled hosted processor has already handled everything that existed
    // before teardown, and waking it solely to consume those close facts would
    // create an immediate close -> wake -> open -> idle-close loop. Advance
    // the sending cursor through them on purpose: the row is only the source
    // stream's wake/delivery position, and the runner's OWN durable
    // checkpoint — which never advanced over the close facts — is what its
    // next real wake replays from, so a presence-consuming processor still
    // sees them then.
    const maxOffset = this.#hooks.coreState().maxOffset;
    for (const connectionKey of idleHosted) this.#hooks.store.ack(connectionKey, maxOffset);
    // Session connections have no cursor row; their equivalent of the ack
    // above is the stream-subscriber-pager attachment stamp, which must likewise land
    // AFTER the close facts so those facts can never wake the subscriber.
    if (idleSessions.length > 0) this.#hooks.onSessionsIdleClosed(idleSessions);
    this.#idleTeardownAtMs = null;
    return keys;
  }

  /**
   * Hosted connections are always idle-eligible (the durable subscription
   * re-wakes them). A session connection is eligible only when its owner's
   * client has given the Stream DO a live Subscriber Pager; every other
   * session connection keeps today's semantics — it lives (and pins) as long
   * as its session does.
   */
  #idleEligibleConnectionKeys(): { hosted: string[]; session: string[] } {
    const hosted: string[] = [];
    const session: string[] = [];
    let pagerKeys: ReadonlySet<string> | undefined;
    for (const [connectionKey, connection] of this.#connections) {
      if (connection.kind === "hosted") hosted.push(connectionKey);
      else if ((pagerKeys ??= this.#hooks.subscriberPagerConnectionKeys()).has(connectionKey)) {
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
              // Ephemeral events reach the filter for every connection kind;
              // for hosted ones the filter admits only types the processor
              // named explicitly in `consumes`. Session connections have
              // always received them — they own no durable cursor, so a hole
              // costs them nothing.
              const visible = readEvents;
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
            // `state: false` per-connection control: a constrained consumer
            // opts out of the reduced-state snapshot riding every batch.
            state: args.includeState === false ? null : currentState,
          } satisfies StreamEventBatch;
          if (kind === "hosted") {
            const expectedDelivery = args.expectedHostedDelivery!;
            const deliveryToken = Symbol("hosted stream delivery");
            hostedBatchPending = true;
            hostedBatchToken = deliveryToken;
            hostedBatchStartedAtMs = this.#hooks.now();
            hostedBatchDeadlineAtMs = hostedBatchStartedAtMs + DEFAULT_DELIVERY_TIMEOUT_MS;
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
                const parsed = parseWakeDeliveryResult(deliveryResult);
                if (
                  parsed.outcome === "ok" &&
                  connection.isLive() &&
                  this.#connections.get(connectionKey) === connection &&
                  this.#hooks.hostedDeliveryStillMatches(connectionKey, expectedDelivery)
                ) {
                  // The batch ack settles the watchdog and failure streak.
                  // The receiver's durable claim (processed_through_offset) only
                  // moves on reported checkpoints — the wake response's
                  // checkpoint — so an eviction redelivers anything
                  // unconfirmed (at-least-once).
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
      close: (reason, error) => {
        if (!open) return;
        open = false;
        hostedBatchPending = false;
        hostedBatchToken = null;
        hostedBatchStartedAtMs = null;
        hostedBatchDeadlineAtMs = null;
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
