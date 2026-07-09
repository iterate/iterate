// Every subscriber, one module: the stream's delivery machinery.
//
// A SUBSCRIBER gives the stream exactly one thing — a sink, `(batch:
// StreamEventBatch) => unknown` — and the three lanes differ only in how the
// sink reaches the stream and what happens to the call result:
//
// | lane       | sink arrives as                    | call result            |
// |------------|------------------------------------|------------------------|
// | ephemeral  | `subscribe()` parameter            | disposed unpulled — zero return frames |
// | wake       | returned from the poke             | pulled, never awaited — prompt corpse detection |
// | push       | named by a persisted itx expression| awaited — the ack that advances the cursor |
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
// This module is transport-free and clock-free: everything it touches arrives
// through `StreamSubscribersHooks` (storage, log reads, the dial, time, the
// alarm), so the whole state machine runs in plain-node vitest against an
// in-memory store and a scripted dial (stream-subscribers.test.ts). The only
// streams file that knows RPC exists is subscriber-sinks.ts.

import type { ItxExpression } from "../../itx/expression.ts";
import type { StreamEvent, StreamEventInput } from "./schemas.ts";
import type {
  GetProcessorRuntimeState,
  ProcessEventBatch,
  ProcessorRuntimeState,
  StreamEventBatch,
  StreamPushEventBatch,
  StreamSubscriberWakeRequest,
} from "./rpc-types.ts";
import type {
  CoreProcessorState,
  StreamSubscriberDescriptor,
  StreamSubscriberDisconnectReason,
  StreamSubscriptionType,
  SubscriptionConfiguredPayload,
  WakeDeliveryTarget,
} from "./core-processor-contract.ts";
import { StreamSubscriberDescriptor as StreamSubscriberDescriptorSchema } from "./core-processor-contract.ts";
import { compileEventSelector, type CompiledEventSelector } from "./event-selector.ts";
import type { SubscriptionCursorStore } from "./stream-storage.ts";
import {
  retainGetProcessorRuntimeState,
  retainProcessEventBatch,
  type RetainedProcessEventBatch,
} from "./subscriber-sinks.ts";
import {
  computeBackoffMs,
  deliveryId,
  DELIVERY_BATCH_BYTE_LIMIT,
  DELIVERY_BATCH_LIMIT,
  halveBatchLimit,
  initialCursor,
  MAX_CONSECUTIVE_SKIPS,
  MAX_DELIVERY_ATTEMPTS,
  SKIP_CONFIRM_ATTEMPTS,
} from "./subscriber-math.ts";

/** Serializable debug view of one live connection, for `runtimeState()`. */
export type ConnectionRuntimeState = {
  subscriptionType: StreamSubscriptionType;
  startedAt: string;
  cursor: number;
  batchesSent: number;
  eventsSent: number;
  lastDeliveredAt?: string;
};

/** Serializable debug view of one durable subscription's spine row, for `runtimeState()`. */
export type SubscriptionRuntimeState = {
  mode: "wake" | "push";
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
};

/**
 * A live delivery connection from the stream to one sink. Not persisted; the
 * sink and pump state live in the `open()` closure, so this is just metrics
 * counters plus two control verbs.
 */
type Connection = {
  readonly subscriptionType: StreamSubscriptionType;
  readonly startedAt: string;
  /** Highest offset delivered to the sink; also the pump's resume cursor. */
  readonly cursor: number;
  batchesSent: number;
  eventsSent: number;
  lastDeliveredAt?: string;
  getProcessorRuntimeState?: GetProcessorRuntimeState & Disposable;
  /** Re-arm the delivery pump after events are committed. Idempotent while draining. */
  wake(): void;
  /** `true` until close() runs — backs the subscription handle's `ping()`. */
  isLive(): boolean;
  /** Stop the pump, dispose the sink, append the disconnect fact, drop from the table. */
  close(reason: StreamSubscriberDisconnectReason): void;
};

/** Everything `open()` needs to start one delivery connection. */
type OpenConnectionArgs = {
  subscriptionKey: string;
  subscriptionType: StreamSubscriptionType;
  /** Already-retained sink (subscriber-sinks.ts owns retention semantics). */
  sink: RetainedProcessEventBatch;
  replayAfterOffset?: number;
  selector?: CompiledEventSelector;
  /** `false` = state-only batches. Default `true`. */
  events?: boolean;
  /** Validated serializable identity, appended as the connected presence fact. */
  presence?: StreamSubscriberDescriptor;
  /** Live processor runtime-state capability, retained for the connection lifetime. */
  getRuntimeState?: GetProcessorRuntimeState;
};

/**
 * The transport quarantine's face: how the spine reaches subscribers. The DO
 * wires `poke` to the target Durable Object's `wakeStreamSubscriber` (with
 * sink retention applied to the response) and `push` to an itx-expression
 * evaluation against the project-scoped `env.ITX` root.
 */
export type SubscriberDial = {
  poke(
    target: WakeDeliveryTarget,
    request: StreamSubscriberWakeRequest,
  ): Promise<{
    checkpointOffset: number;
    sink: RetainedProcessEventBatch;
    subscriber?: unknown;
    getRuntimeState?: GetProcessorRuntimeState;
  }>;
  /** Evaluate the expression to a sink and invoke it with the batch. Resolve = ack. */
  push(expression: ItxExpression, batch: StreamPushEventBatch): Promise<void>;
};

/** The policy/storage seams the owning Stream Durable Object provides. */
type StreamSubscribersHooks = {
  /** Synchronous committed-event range read from stream storage. */
  readEvents(args: { afterOffset: number; limit: number }): StreamEvent[];
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
  /** Injected clock (epoch ms). */
  now(): number;
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

  constructor(args: { idleTeardownMs: number; hooks: StreamSubscribersHooks }) {
    this.#hooks = args.hooks;
    this.#idleTeardownMs = args.idleTeardownMs;
  }

  // ===========================================================================
  // The one wake-up: called post-commit and from the DO alarm.
  // ===========================================================================

  /**
   * Re-arm every live connection's pump and reconcile durable subscriptions
   * (poke lagging wake subscribers without a connection, drain lagging push
   * subscriptions that are due). Never throws; never blocks the append.
   */
  wake(): void {
    for (const connection of this.#connections.values()) connection.wake();
    if (this.#tearingDown) return;
    try {
      this.#reconcileDurable();
    } catch (error) {
      console.error("stream durable subscription reconcile failed", error);
    }
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

      // Wake rows start at 0 — the watermark means "poked about offsets
      // through N", and a never-poked subscriber has been poked about nothing.
      // Push rows start where the deliver policy says.
      this.#hooks.store.ensure(
        subscriptionKey,
        config.delivery.mode === "wake" ? 0 : initialCursor(config.deliver, configOffset),
      );

      if (entry.parkedAtOffset !== undefined) continue;

      const row = this.#hooks.store.get(subscriptionKey);
      if (row === undefined) continue; // unreachable after ensure; defensive
      if (row.nextAttemptAt !== null && row.nextAttemptAt > now) continue; // alarm owns it
      if (row.ackedOffset >= state.maxOffset) continue; // caught up; nothing to say

      if (config.delivery.mode === "wake") {
        if (this.#connections.has(subscriptionKey) || this.#pokesInFlight.has(subscriptionKey)) {
          continue;
        }
        this.#poke(subscriptionKey, config.delivery.target, configOffset);
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
  #poke(subscriptionKey: string, target: WakeDeliveryTarget, configOffset: number): void {
    const state = this.#hooks.coreState();
    if (state.projectId === undefined || state.path === undefined) return;
    const request: StreamSubscriberWakeRequest = {
      stream: { projectId: state.projectId, path: state.path, streamMaxOffset: state.maxOffset },
      subscriptionKey,
      ...(target.processorSlug === undefined ? {} : { processorSlug: target.processorSlug }),
    };

    this.#pokesInFlight.add(subscriptionKey);
    const work = (async () => {
      try {
        // A poke that outlives its timeout still eventually settles with a
        // RETAINED sink; dropping that undisposed would leak a session-pinning
        // stub on exactly the wedged-subscriber occasions the timeout exists
        // for. The late-settle hook disposes it (thermo round 2, blocker 4b).
        const pokePromise = this.#hooks.dial.poke(target, request);
        const response = await withDeliveryTimeout(pokePromise, `poke ${subscriptionKey}`, {
          onLateResolve: (late) => late.sink[Symbol.dispose](),
        });
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
        });
        // Observational watermark: the subscriber confirmed this checkpoint.
        // While the connection streams, the watermark deliberately goes stale;
        // its only job is deciding whether to poke when no connection exists.
        this.#hooks.store.ack(subscriptionKey, response.checkpointOffset);
      } catch (error) {
        this.#onDeliveryFailure(subscriptionKey, error);
      } finally {
        this.#pokesInFlight.delete(subscriptionKey);
      }
    })();
    this.#hooks.keepAlive(work);
  }

  /**
   * Drain one push subscription to the tail: read after the cursor, filter
   * through the selector (skip-not-defer — the cursor advances past
   * non-matching events), invoke the expression-named sink with the batch, and
   * advance the cursor on the awaited resolve. The awaited call IS the ack —
   * this is the one lane with acknowledgement semantics, which is exactly why
   * the stream can own its cursor.
   */
  #drainPush(subscriptionKey: string): void {
    this.#pushDrains.add(subscriptionKey);
    const work = (async () => {
      try {
        for (;;) {
          const state = this.#hooks.coreState();
          const entry = state.configuredSubscribersByKey[subscriptionKey];
          if (entry === undefined || entry.parkedAtOffset !== undefined) return;
          const config = entry.latestConfiguredEvent.payload;
          if (config.delivery.mode !== "push") return;
          const row = this.#hooks.store.get(subscriptionKey);
          if (row === undefined) return;
          if (row.nextAttemptAt !== null && row.nextAttemptAt > this.#hooks.now()) return;

          const limit = Math.min(
            this.#batchLimits.get(subscriptionKey) ?? DELIVERY_BATCH_LIMIT,
            DELIVERY_BATCH_LIMIT,
          );
          const events = this.#readBatch(row.ackedOffset, limit);
          const lastOffset = events.at(-1)?.offset;
          if (lastOffset === undefined) return; // caught up

          const { matched, conditionErrors } = this.#applySelector(subscriptionKey, config, events);
          for (const fact of conditionErrors) this.#hooks.appendFact(fact);

          if (matched.length === 0) {
            // Skip-not-defer: nothing here for this subscriber, but the cursor
            // must advance or the subscription re-reads these events forever.
            this.#hooks.store.ack(subscriptionKey, lastOffset);
            continue;
          }

          if (state.projectId === undefined || state.path === undefined) return;
          const batch: StreamPushEventBatch = {
            projectId: state.projectId,
            path: state.path,
            events: matched,
            streamMaxOffset: state.maxOffset,
            // Read in the same synchronous block as streamMaxOffset, so the
            // two always correspond (state-at-streamMaxOffset, exactly like
            // live subscription batches).
            state,
            subscriptionKey,
            deliveryId: deliveryId(subscriptionKey, matched[0]!.offset, lastOffset),
            attempt: row.attempt + 1,
            configuredEvent: {
              type: entry.latestConfiguredEvent.type,
              offset: entry.latestConfiguredEvent.offset,
              createdAt: entry.latestConfiguredEvent.createdAt,
              path: state.path,
              payload: entry.latestConfiguredEvent.payload,
            },
          };

          try {
            await withDeliveryTimeout(
              this.#hooks.dial.push(config.delivery.expression, batch),
              `push ${subscriptionKey}`,
            );
          } catch (error) {
            // "continue" = the failure handler already moved the goalposts
            // (halved the bisect window or stepped over confirmed poison) and
            // the loop should try again NOW; anything else backs off or parks
            // and the alarm/resume owns the future.
            if (this.#onPushFailure({ subscriptionKey, config, matched, error }) === "continue") {
              continue;
            }
            return;
          }
          this.#hooks.store.ack(subscriptionKey, lastOffset);
          this.#batchLimits.delete(subscriptionKey);
          this.#consecutiveSkips.delete(subscriptionKey);
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

  /** Read up to `limit` events after `afterOffset`, shrinking under the byte cap. */
  #readBatch(afterOffset: number, limit: number): StreamEvent[] {
    const events = this.#hooks.readEvents({ afterOffset, limit });
    if (events.length <= 1) return events;
    let bytes = 0;
    for (let index = 0; index < events.length; index += 1) {
      bytes += JSON.stringify(events[index]).length;
      if (bytes > DELIVERY_BATCH_BYTE_LIMIT && index > 0) return events.slice(0, index);
    }
    return events;
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
    const nextAttemptAt = this.#hooks.now() + computeBackoffMs(attempt, Math.random());
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
    this.#consecutiveSkips.delete(subscriptionKey);
    this.#batchLimits.delete(subscriptionKey);
  }

  #armAlarmFromStore(): void {
    const next = this.#hooks.store.minNextAttemptAt();
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
    if (payload.delivery.mode === "wake") {
      this.#hooks.store.ensure(key, 0);
    } else {
      const cursor = initialCursor(payload.deliver, eventOffset);
      this.#hooks.store.ensure(key, cursor);
      // An explicit deliver policy on a REPLACEMENT config is a seek; without
      // one the existing cursor is kept (config update ≠ replay request).
      if (payload.deliver !== undefined) this.#hooks.store.setCursor(key, cursor);
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
  }

  /** A `subscription-cursor-set` fact committed: the audited seek. */
  onCursorSet(subscriptionKey: string, afterOffset: number): void {
    this.#hooks.store.setCursor(subscriptionKey, afterOffset);
    this.wake();
  }

  /** A `subscription-resumed` fact committed: un-park (the fold already cleared it) and kick. */
  onResumed(subscriptionKey: string, afterOffset?: number): void {
    if (afterOffset !== undefined) {
      this.#hooks.store.setCursor(subscriptionKey, afterOffset);
    } else {
      const row = this.#hooks.store.get(subscriptionKey);
      if (row !== undefined) this.#hooks.store.ack(subscriptionKey, row.ackedOffset);
    }
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

    // Replacing any existing connection for this key.
    this.#connections.get(subscriptionKey)?.close("replaced");

    const deliverEvents = args.events !== false;
    // State-only subscriptions are implicitly live-from-now: replay without
    // events is meaningless, so replayAfterOffset is ignored in that mode.
    let cursor = deliverEvents
      ? (args.replayAfterOffset ?? this.#hooks.coreState().maxOffset)
      : this.#hooks.coreState().maxOffset;
    let initialBatchPending = true;
    let draining = false;
    let open = true;

    const pump = async () => {
      if (draining) return;
      draining = true;
      try {
        while (open) {
          let events: StreamEvent[] = [];
          if (deliverEvents) {
            const readEvents = this.#hooks.readEvents({ afterOffset: cursor, limit: 100 });
            const lastOffset = readEvents.at(-1)?.offset;
            if (lastOffset === undefined) {
              // Caught up; the next append wakes us again. The first drain
              // still owes the initial state batch.
              if (!initialBatchPending) return;
            } else {
              cursor = lastOffset;
              events =
                args.selector === undefined
                  ? readEvents
                  : readEvents.filter((event) => selectorMatchesSafely(args.selector!, event));
              if (events.length === 0 && !initialBatchPending) continue;
            }
          } else {
            const stateMaxOffset = this.#hooks.coreState().maxOffset;
            if (stateMaxOffset <= cursor && !initialBatchPending) return;
            cursor = stateMaxOffset;
          }
          initialBatchPending = false;
          connection.batchesSent += 1;
          connection.eventsSent += events.length;
          connection.lastDeliveredAt = new Date().toISOString();
          const currentState = this.#hooks.coreState();
          if (currentState.projectId === undefined || currentState.path === undefined) {
            throw new Error(
              "Cannot deliver stream batch before stream coordinates are initialized.",
            );
          }
          sink({
            projectId: currentState.projectId,
            path: currentState.path,
            events,
            streamMaxOffset: currentState.maxOffset,
            // Read in the same synchronous block as streamMaxOffset, so the
            // two always correspond (state-at-streamMaxOffset; see rpc-types.ts).
            state: currentState,
          } satisfies StreamEventBatch);
          await Promise.resolve();
        }
      } finally {
        draining = false;
      }
    };

    const connection: Connection = {
      subscriptionType,
      startedAt: new Date().toISOString(),
      getProcessorRuntimeState: retainGetProcessorRuntimeState(args.getRuntimeState),
      get cursor() {
        return cursor;
      },
      batchesSent: 0,
      eventsSent: 0,
      wake: () => void pump(),
      isLive: () => open,
      close: (reason) => {
        if (!open) return;
        open = false;
        if (this.#connections.get(subscriptionKey) === connection) {
          this.#connections.delete(subscriptionKey);
        }
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

  /** Durable-sink delivery failures arrive here (see subscriber-sinks.ts): close → spine re-pokes. */
  onDurableDeliveryError(subscriptionKey: string, error: unknown): void {
    const connection = this.#connections.get(subscriptionKey);
    if (connection === undefined) return;
    console.error("stream durable sink delivery failed; dropping connection for re-poke", {
      subscriptionKey,
      error,
    });
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

  connectionRuntimeState(): Record<string, ConnectionRuntimeState> {
    return Object.fromEntries(
      [...this.#connections].map(([subscriptionKey, connection]) => [
        subscriptionKey,
        {
          subscriptionType: connection.subscriptionType,
          startedAt: connection.startedAt,
          cursor: connection.cursor,
          batchesSent: connection.batchesSent,
          eventsSent: connection.eventsSent,
          lastDeliveredAt: connection.lastDeliveredAt,
        },
      ]),
    );
  }

  subscriptionRuntimeState(): Record<string, SubscriptionRuntimeState> {
    const state = this.#hooks.coreState();
    const rows = new Map(this.#hooks.store.list().map((row) => [row.subscriptionKey, row]));
    return Object.fromEntries(
      Object.entries(state.configuredSubscribersByKey).map(([subscriptionKey, entry]) => {
        const row = rows.get(subscriptionKey);
        const ackedOffset = row?.ackedOffset ?? 0;
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
    this.#tearingDown = true;
    try {
      for (const subscriptionKey of keys) this.close(subscriptionKey, "idle");
    } finally {
      this.#tearingDown = false;
    }
    // Advance every torn-down watermark past the disconnect facts this loop
    // just appended, so the next reconcile is a no-op instead of an immediate
    // re-poke. Safe: the watermark is observational (the subscriber's own
    // checkpoint is the truth), and after >= idleTeardownMs of append silence
    // the pumps were long since drained, so maxOffset holds nothing the sink
    // has not already seen except our own facts.
    const maxOffset = this.#hooks.coreState().maxOffset;
    for (const subscriptionKey of keys) this.#hooks.store.ack(subscriptionKey, maxOffset);
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

async function withDeliveryTimeout<T>(
  promise: Promise<T>,
  label: string,
  opts: {
    /** Runs iff the underlying promise RESOLVES after the timeout already won
     * the race — the caller's chance to dispose late-arriving resources. */
    onLateResolve?: (value: T) => void;
  } = {},
): Promise<T> {
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
          reject(new Error(`${label} timed out after ${DELIVERY_TIMEOUT_MS}ms`));
        }, DELIVERY_TIMEOUT_MS);
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
