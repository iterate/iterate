import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import type { Env } from "../../env.ts";
import type { Stream } from "../../itx-api.generated.ts";
import { StreamSubscriptionRpcTarget } from "../../rpc-targets.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { buildAcceptCrossPostAppendInputs } from "./cross-post.ts";
import type {
  ProcessorRuntimeState,
  StreamPushEventBatch,
  StreamSubscriptionHandle,
} from "./rpc-types.ts";
import type { StreamEvent, StreamEventInput } from "./schemas.ts";
import { StreamEventInput as StreamEventInputSchema } from "./schemas.ts";
import { compileEventSelector } from "./event-selector.ts";
import {
  reconcileSubscriptionCursorRows,
  SqliteSubscriptionCursorStore,
  StreamEventLog,
} from "./stream-storage.ts";
import {
  StreamSubscribers,
  type ConnectionRuntimeState,
  type SubscriptionRuntimeState,
} from "./stream-subscribers.ts";
import { createSubscriberDial } from "./subscriber-sinks.ts";
import {
  CORE_STATE_VERSION,
  CoreProcessorContract,
  StreamSubscriberDescriptor as StreamSubscriberDescriptorSchema,
  type CoreProcessorState,
  type SubscriptionConfiguredPayload,
} from "./core-processor-contract.ts";

const DEFAULT_GET_EVENTS_LIMIT = 500;
const MAX_GET_EVENTS_LIMIT = 500;

/**
 * The subscription key of the birth-certificate worker feed every
 * project-scoped stream configures on itself (see the constructor). Userspace
 * overrides it by re-appending `subscription-configured` with this same key.
 */
const PROJECT_WORKER_SUBSCRIPTION_KEY = "project-worker";

/**
 * Durable stream storage plus the stream's own ("core") processor.
 *
 * The pieces, in the order they appear below:
 *
 * 1. `append(...)` — the synchronous commit point. Offsets are assigned, the
 *    core state is reduced, and event rows are persisted in one await-free
 *    turn; everything after that is post-commit fan-out.
 * 2. The core processor — the same `validateAppend` → `reduce` → `processEvent`
 *    shape every hosted `StreamProcessor` subclass has, with contract/schemas
 *    in `core-processor-contract.ts`. It runs inline instead of behind a
 *    subscription because it holds the two powers no hosted processor has: it
 *    is synchronous with the commit, and `validateAppend` can REJECT an event
 *    before it becomes a durable fact.
 * 3. Its checkpoint — reduced state in DO KV, rebuilt from the SQL event log
 *    (`stream-storage.ts`) when missing or version-skewed.
 * 4. Delivery — every lane (ephemeral connections, wake pokes, push drains)
 *    lives in `stream-subscribers.ts`, dialing transports through
 *    `subscriber-sinks.ts`; this class only decides policy (who may
 *    subscribe, what a config event means, which facts to append).
 *
 * HTTP/WebSocket Cap'n Web termination belongs at the fronting Worker, which
 * exposes this DO through `StreamRpcTarget`. This class is deliberately NOT
 * `implements Stream`: `Stream` is the public async capability; the methods
 * here are storage/runtime implementation methods, and the append/read methods
 * that touch SQLite/KV must remain synchronous.
 */
export class StreamDurableObject extends DurableObject<Env> {
  readonly name = parseStreamDurableObjectName(this.ctx.id.name);
  readonly #log = new StreamEventLog(this.ctx.storage.sql, this.name.path);
  /**
   * The spine's durable cursor rows. A field (not inlined into the hooks)
   * because the core-state rebuild path also reconciles these rows against
   * the freshly folded config — see #readCoreProcessorState.
   */
  readonly #subscriptionCursorStore = new SqliteSubscriptionCursorStore(this.ctx.storage.sql);
  readonly #subscribers = new StreamSubscribers({
    idleTeardownMs: idleTeardownMs(this.env),
    hooks: {
      // Straight to the sized log read: the spine wants byte lengths for its
      // batch cap (getEvents would re-stringify to size a batch), and its
      // limits are already bounded well under the public read clamp.
      readEvents: (args) =>
        this.#log.getRangeSized({
          afterOffset: args.afterOffset,
          beforeOffset: Number.MAX_SAFE_INTEGER,
          limit: args.limit,
          // RAW, ephemeral included: the spine's cursors advance over every
          // offset (skip-not-defer, like selector-filtered events), and the
          // ephemeral lane delivers them; the durable lanes filter them from
          // DELIVERY in stream-subscribers.ts.
          includeEphemeral: true,
        }),
      coreState: () => this.#coreProcessorState,
      store: this.#subscriptionCursorStore,
      dial: createSubscriberDial({
        projectId: this.name.projectId,
        exports: this.ctx.exports,
        onDurableDeliveryError: (subscriptionKey, error) =>
          this.#subscribers.onDurableDeliveryError(subscriptionKey, error),
      }),
      appendFact: (event) => {
        // Facts the delivery machinery produces (presence, parked, poison
        // records) are observations; appending one must never mask the
        // delivery-path operation that produced it, so failures log.
        try {
          this.append(event);
        } catch (error) {
          console.error("stream delivery fact append failed", { type: event.type, error });
        }
      },
      now: () => Date.now(),
      random: () => Math.random(),
      armAlarm: (atMs) => void this.#armAlarmNoLaterThan(atMs),
      keepAlive: (promise) => this.#runInBackground(() => promise),
    },
  });
  #coreProcessorState: CoreProcessorState;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#coreProcessorState = this.#readCoreProcessorState();

    // The first boot appends the stream's birth certificate; every wake
    // (fetch, RPC, alarm) appends a `woken` fact, whose post-commit fan-out is
    // also what re-establishes durable deliveries after hibernation.
    //
    // For project-scoped streams the birth certificate includes the worker
    // feed: a `subscription-configured` push subscription to the project
    // worker's `processEventBatch`, appended by the stream TO ITSELF in the
    // same synchronous turn as `created`. Born-configured means zero wiring
    // window — the feed is armed before the first user event can land (a
    // voice stream streams from birth) — while remaining ordinary config:
    // one registry, one spine, overridable by re-appending the same key.
    if (this.#coreProcessorState.eventCount === 0) {
      this.append({
        type: "events.iterate.com/stream/created",
        payload: { projectId: this.name.projectId, path: this.name.path },
      });
      if (this.name.projectId !== null) {
        this.append({
          type: "events.iterate.com/stream/subscription-configured",
          payload: {
            subscriptionKey: PROJECT_WORKER_SUBSCRIPTION_KEY,
            delivery: { mode: "push", expression: ["processEventBatch"] },
            // Everything, from the beginning: the worker sees the stream's
            // full history once it first builds. No default selector —
            // selection is the worker's own code (or a same-key override).
            deliver: "all",
            // One poison event must not silence a project's entire feed.
            onPoison: "skip",
          } satisfies SubscriptionConfiguredPayload,
        });
      }
    }
    this.append({
      type: "events.iterate.com/stream/woken",
      payload: { incarnationId: crypto.randomUUID() },
    });
  }

  /** The DO alarm: the spine's durable retry timer. */
  alarm(): void {
    this.#alarmArmedForMs = null;
    // The constructor's `woken` append already ran `#subscribers.wake()` via
    // post-commit fan-out; this call re-arms the alarm for the next due retry
    // (wake() itself only attempts rows whose backoff has elapsed).
    this.#subscribers.onAlarm();
    this.#flushCoreProcessorState();
  }

  /**
   * The earliest alarm time armed this incarnation, tracked in memory so two
   * concurrent arms can't race each other through the async getAlarm/setAlarm
   * pair (both observing null and the LATER one winning). Reset when the
   * alarm fires; a stale-low value merely re-arms an already-set time.
   */
  #alarmArmedForMs: number | null = null;

  /** Move the DO alarm earlier, never later (many rows share one alarm). */
  async #armAlarmNoLaterThan(atMs: number): Promise<void> {
    if (this.#alarmArmedForMs !== null && this.#alarmArmedForMs <= atMs) return;
    this.#alarmArmedForMs = atMs;
    try {
      const current = await this.ctx.storage.getAlarm();
      if (current === null || atMs < current) await this.ctx.storage.setAlarm(atMs);
    } catch (error) {
      console.error("stream alarm arming failed", error);
    }
  }

  // ===========================================================================
  // Append: the commit point.
  // ===========================================================================

  /**
   * Synchronously assigns offsets, reduces, persists, then wakes delivery.
   *
   * DO NOT make this method async. Do not insert an `await` anywhere in the
   * offset/reduce/persist path it calls. This is the stream's commit point:
   * storage writes and core state changes must happen in one synchronous turn.
   *
   * What happens for `append(a, b)` on a stream at `maxOffset: 4`:
   * 1. `a` becomes offset 5, `b` becomes offset 6; each passes `validateAppend`
   *    and is folded through `reduce`. An event whose `idempotencyKey` already
   *    exists is skipped and the existing event is returned in its place (so
   *    the returned array stays input-aligned).
   * 2. Event rows + the new core state are written in one await-free turn.
   *    After this line the append has succeeded.
   * 3. Post-commit fan-out: core `processEvent` side effects run, every live
   *    connection's pump is woken, configured subscriptions without a live
   *    connection are re-woken. None of this can fail the append.
   *
   * Returns the persisted events (including offsets + `createdAt`) in input order.
   */
  append(...eventInputs: StreamEventInput[]): StreamEvent[] {
    let workingState = this.#coreProcessorState;
    const events: StreamEvent[] = [];
    const newEvents: StreamEvent[] = [];
    const reducedEvents: ReducedCoreEvent[] = [];
    const idempotencyHitsInBatch = new Map<string, StreamEvent>();

    // 1. Validate inputs, assign offsets, and reduce state.
    for (const eventInput of eventInputs) {
      // `offset` is an optional optimistic-concurrency assertion, not part of the
      // event body. Split it off immediately so it never reaches core-event
      // validation or the committed event: `validateAppend` strict-parses the
      // body against the contract schema, which has no `offset` key, so leaving
      // it attached made every asserted append of a core policy event fail with
      // a spurious "Unrecognized key: offset" instead of performing the assertion.
      const { offset: expectedOffset, ...body } = StreamAppendInput.parse(eventInput);

      if (body.idempotencyKey !== undefined) {
        // Same-batch idempotency should behave like already-persisted idempotency.
        const existing =
          idempotencyHitsInBatch.get(body.idempotencyKey) ??
          this.getEvent({ idempotencyKey: body.idempotencyKey });
        if (existing !== undefined) {
          if (expectedOffset !== undefined && expectedOffset !== existing.offset) {
            throw new Error(`idempotency hit at offset ${existing.offset}, got ${expectedOffset}`);
          }
          events.push(existing);
          continue;
        }
      }

      this.#validateAppend({ event: body, state: workingState });

      const committed: StreamEvent = {
        ...body,
        offset: workingState.maxOffset + 1,
        createdAt: new Date().toISOString(),
        path: this.name.path,
      };
      if (expectedOffset !== undefined && expectedOffset !== committed.offset) {
        throw new Error(`expected offset ${committed.offset}, got ${expectedOffset}`);
      }

      const previousState = workingState;
      workingState = this.#reduce({ event: committed, state: previousState }, "append");

      // Core side effects are deferred until after the commit below: they can
      // call back into stream runtime state, so running them mid-batch would
      // observe stale `this.#coreProcessorState`.
      reducedEvents.push({ event: committed, previousState, state: workingState });

      events.push(committed);
      newEvents.push(committed);
      if (committed.idempotencyKey !== undefined) {
        idempotencyHitsInBatch.set(committed.idempotencyKey, committed);
      }
    }

    if (newEvents.length === 0) return events;

    // 2. Persist event rows and reduced core state. Durable Object SQL storage
    // runs synchronously in the object's thread; each sql.exec() is atomic and
    // Output Gates hold responses until writes are durable:
    // https://developers.cloudflare.com/durable-objects/api/sql-storage/
    // https://blog.cloudflare.com/sqlite-in-durable-objects/
    // Keep this section await-free: event rows + core state are the append
    // boundary. The KV state checkpoint is DEBOUNCED (see
    // #checkpointCoreProcessorState) — event rows are the durable truth, and
    // boot catch-up folds past a lagging checkpoint by design.
    const byteLengths = this.#log.insert(newEvents);
    this.#coreProcessorState = workingState;
    this.#checkpointCoreProcessorState(newEvents.length);

    // 3. Post-commit fan-out. Core side effects are fire-and-forget where
    // async, so nothing here can fail the append. One wake covers every lane:
    // live connection pumps re-arm, lagging wake subscribers get poked,
    // lagging push subscriptions drain. The spine triggers on WATERMARK LAG,
    // never on event types — a subscriber-disconnected fact whose teardown
    // pre-advanced the watermark reconciles to a no-op instead of needing the
    // event-type carve-out the old reconciler carried. The wake hands over the
    // just-committed events (sized by the log write) so caught-up consumers
    // skip the per-lane SQLite re-read.
    for (const reduced of reducedEvents) this.#processEvent(reduced);
    this.#subscribers.wake(
      newEvents.map((event, index) => ({ event, byteLength: byteLengths[index]! })),
    );

    // Re-arm (or clear) the idle timer against the post-append connection set,
    // so a stream that just went quiet sheds its durable delivery sessions
    // and lets both DOs hibernate.
    this.#subscribers.armOrClearIdleTimer();

    return events;
  }

  /**
   * Synchronous committed-event read used by the append transaction and
   * delivery catch-up. Keep await-free; callers that cross an RPC seam get the
   * async shape from `StreamRpcTarget`, not from this storage method.
   */
  getEvent(
    args: { offset: number; idempotencyKey?: never } | { idempotencyKey: string; offset?: never },
  ): StreamEvent | undefined {
    if (args.idempotencyKey !== undefined)
      return this.#log.getByIdempotencyKey(args.idempotencyKey);
    return this.#log.getByOffset(args.offset);
  }

  /**
   * Synchronous committed-event range read. Keep await-free (see getEvent).
   * Ephemeral rows are excluded unless `includeEphemeral` — the second-class
   * contract: nothing reads them by accident, so the stream stays free to
   * evict them later.
   */
  getEvents(
    args: {
      afterOffset?: number;
      beforeOffset?: number | null;
      eventTypes?: readonly string[];
      limit?: number;
      includeEphemeral?: boolean;
    } = {},
  ): StreamEvent[] {
    const limit = args.limit;
    if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
      throw new Error("getEvents limit must be a positive integer.");
    }
    if (limit !== undefined && limit > MAX_GET_EVENTS_LIMIT) {
      throw new Error(`getEvents limit must be at most ${MAX_GET_EVENTS_LIMIT}.`);
    }
    return this.#log.getRange({
      afterOffset: args.afterOffset ?? 0,
      beforeOffset: args.beforeOffset ?? Number.MAX_SAFE_INTEGER,
      eventTypes: args.eventTypes,
      limit: limit ?? DEFAULT_GET_EVENTS_LIMIT,
      includeEphemeral: args.includeEphemeral,
    });
  }

  // ===========================================================================
  // The core processor.
  //
  // Rhymes with every hosted `StreamProcessor` subclass — a contract file
  // (core-processor-contract.ts) plus `reduce` (pure fold) and `processEvent`
  // (post-commit side effects) — with two extra powers that come from running
  // inline in the append turn instead of behind a subscription:
  //
  // - it is synchronous with the commit, so its state is never behind the log;
  // - `validateAppend` runs BEFORE the commit and can reject an event, which
  //   no subscription-fed processor can ever do.
  // ===========================================================================

  /**
   * Pre-append gate. Stream-owned policy, not a hosted-processor hook: only the
   * stream itself can reject an append based on core state.
   */
  #validateAppend(args: { event: StreamEventInput; state: CoreProcessorState }): void {
    if (args.event.ephemeral && args.event.type.startsWith("events.iterate.com/stream/")) {
      // Control facts fold into config/presence/park state and may never be
      // evicted; an ephemeral one would be a fact the stream is licensed to
      // forget.
      throw new Error("stream control events cannot be ephemeral");
    }

    // Control facts must be first-hand: a copied (cross-posted) stream/*
    // control event is stored and visible but must never fold or validate as
    // config — otherwise a cross-post subscription matching stream/* would
    // replicate CONFIGURATION into its target (config propagation by copy).
    // The reducer applies the same guard on the fold side.
    const isFirstHand = args.event.source?.crossPostedFrom === undefined;

    if (isFirstHand && args.event.type === "events.iterate.com/stream/subscription-configured") {
      // Durable subscriptions are desired state. Once this event is committed,
      // the reducer stores it and the spine is allowed to deliver against it
      // forever. So validation must happen here, before offset assignment and
      // storage — not inside the later fire-and-forget delivery path, where an
      // invalid target/expression would already be durable state every future
      // append re-reconciles. The lifecycle e2e tests assert both the
      // rejection and that no event was committed.
      // The contract schema already carries the structural delivery
      // validation (expression grammar + the property-step tail rule, webhook
      // URL shape); cross-project reach needs no check at all because
      // persisted expressions are NAMES — every delivery re-derives authority
      // from THIS stream's own itx root (project-scoped, or the deployment
      // root for projectId: null streams).
      const event = CoreProcessorContract.parseEventInput(
        "events.iterate.com/stream/subscription-configured",
        args.event,
      );
      if (event.payload.delivery.mode === "webhook" && this.name.projectId === null) {
        // Webhook POSTs ride the project egress lane (attribution +
        // interception); a global stream has no project to attribute them to.
        throw new Error("webhook subscriptions require a project-scoped stream");
      }
      // An unparseable selector condition must be rejected before it commits,
      // not discovered as a per-event error forever after. (compile throws.)
      compileEventSelector(event.payload.selector);
    }

    if (!args.state.paused) return;

    // Presence and park facts pass through the pause door alongside
    // resume/error/woken: a paused stream still has subscribers attaching
    // (e.g. an operator's browser) and deliveries failing, and both rosters
    // must stay truthful for the stream to recover.
    switch (args.event.type) {
      case "events.iterate.com/stream/resumed":
      case "events.iterate.com/stream/error-occurred":
      case "events.iterate.com/stream/woken":
      case "events.iterate.com/stream/subscriber-connected":
      case "events.iterate.com/stream/subscriber-disconnected":
      case "events.iterate.com/stream/subscription-parked":
        return;
      default:
        throw new Error(`stream paused: ${args.state.pauseReason ?? "unknown reason"}`);
    }
  }

  // Pure fold of one committed event into the next core state. Runs per event
  // on the synchronous append hot path. Known core event payloads are parsed
  // from the contract before state access; non-core events still count toward
  // the offset/event counters.
  //
  // Do NOT re-parse the whole state on the way out: `state` was already
  // validated at the trust boundary (the KV read and event-log recovery path
  // both parse). Re-validating the growing record fields on every append was
  // quadratic work for no added safety.
  /**
   * `mode` decides what a fold failure means. On the APPEND path a parse
   * failure must THROW — the fold is part of the pre-commit gate for every
   * core event #validateAppend does not special-case, and swallowing it would
   * let malformed facts commit (thermo round 2, blocker 2: live-proven on
   * preview). On the REPLAY path (state rebuild from the log) the same
   * failure folds as INERT — counters + breaker only — because the event is
   * already durable and throwing would brick the constructor forever (the
   * #1714 parse-poison posture; pre-v10 journal shapes are the expected case).
   */
  #reduce(
    args: { event: StreamEvent; state: CoreProcessorState },
    mode: "append" | "replay",
  ): CoreProcessorState {
    if (mode === "append") return this.#reduceCore(args);
    try {
      return this.#reduceCore(args);
    } catch (error) {
      console.error("stream core reduce skipped unparseable event", {
        offset: args.event.offset,
        type: args.event.type,
        error,
      });
      return this.#reduceCircuitBreaker({
        event: args.event,
        state: {
          ...args.state,
          eventCount: args.state.eventCount + 1,
          maxOffset: args.event.offset,
        },
      });
    }
  }

  #reduceCore(args: { event: StreamEvent; state: CoreProcessorState }): CoreProcessorState {
    const parse = CoreProcessorContract.parseEvent;
    let next: CoreProcessorState = {
      ...args.state,
      eventCount: args.state.eventCount + 1,
      maxOffset: args.event.offset,
    };

    // Control facts must be first-hand: a cross-posted copy of a stream/*
    // control event is stored and visible (it still counts toward offsets and
    // the circuit breaker) but INERT — it configures nothing, connects
    // nothing, parks nothing. This closes the config-propagation-by-copy hole
    // no matter what selectors people write. See #validateAppend for the
    // matching write-side guard on subscription-configured.
    if (
      args.event.type.startsWith("events.iterate.com/stream/") &&
      args.event.source?.crossPostedFrom !== undefined
    ) {
      return this.#reduceCircuitBreaker({ event: args.event, state: next });
    }

    switch (args.event.type) {
      case "events.iterate.com/stream/created": {
        const event = parse("events.iterate.com/stream/created", args.event);
        if (event.offset !== 1) {
          throw new Error(
            "events.iterate.com/stream/created must be the first event and have offset 1",
          );
        }
        return this.#reduceCircuitBreaker({
          event: args.event,
          state: {
            ...next,
            projectId: event.payload.projectId,
            path: event.payload.path,
            createdAt: event.createdAt,
          },
        });
      }

      case "events.iterate.com/stream/woken": {
        const event = parse("events.iterate.com/stream/woken", args.event);
        // A new stream incarnation means every previous delivery connection
        // died with the old one. Clearing the roster here is what keeps it
        // truthful without heartbeats: surviving subscribers reconnect and
        // their fresh subscriber-connected events re-land below.
        return { ...next, incarnationId: event.payload.incarnationId, connectionsByKey: {} };
      }

      case "events.iterate.com/stream/paused": {
        const event = parse("events.iterate.com/stream/paused", args.event);
        return {
          ...next,
          paused: true,
          pauseReason: event.payload.reason ?? null,
          circuitBreaker: resetCircuitBreaker(next.circuitBreaker, event.createdAt),
        };
      }

      case "events.iterate.com/stream/resumed": {
        const event = parse("events.iterate.com/stream/resumed", args.event);
        return {
          ...next,
          paused: false,
          pauseReason: null,
          circuitBreaker: resetCircuitBreaker(next.circuitBreaker, event.createdAt),
        };
      }

      case "events.iterate.com/stream/configured": {
        const event = parse("events.iterate.com/stream/configured", args.event);
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

      case "events.iterate.com/stream/subscriber-connected": {
        const event = parse("events.iterate.com/stream/subscriber-connected", args.event);
        const { subscriptionKey, subscriber, subscriptionType } = event.payload;
        next = {
          ...next,
          connectionsByKey: {
            ...next.connectionsByKey,
            [subscriptionKey]: {
              subscriptionType,
              connectedAtOffset: event.offset,
              ...(subscriber === undefined ? {} : { subscriber }),
            },
          },
        };
        return this.#reduceCircuitBreaker({ event: args.event, state: next });
      }

      case "events.iterate.com/stream/subscriber-disconnected": {
        const event = parse("events.iterate.com/stream/subscriber-disconnected", args.event);
        const { [event.payload.subscriptionKey]: _closed, ...connectionsByKey } =
          next.connectionsByKey;
        return this.#reduceCircuitBreaker({
          event: args.event,
          state: { ...next, connectionsByKey },
        });
      }

      case "events.iterate.com/stream/subscription-configured": {
        const event = parse("events.iterate.com/stream/subscription-configured", args.event);
        return this.#reduceCircuitBreaker({
          event: args.event,
          state: {
            ...next,
            configuredSubscribersByKey: {
              ...next.configuredSubscribersByKey,
              [event.payload.subscriptionKey]: {
                latestConfiguredEvent: {
                  offset: event.offset,
                  type: event.type,
                  payload: event.payload,
                  createdAt: event.createdAt,
                },
              },
            },
          },
        });
      }

      case "events.iterate.com/stream/subscription-removed": {
        const event = parse("events.iterate.com/stream/subscription-removed", args.event);
        const { [event.payload.subscriptionKey]: _removed, ...configuredSubscribersByKey } =
          next.configuredSubscribersByKey;
        return this.#reduceCircuitBreaker({
          event: args.event,
          state: { ...next, configuredSubscribersByKey },
        });
      }

      case "events.iterate.com/stream/subscription-parked": {
        const event = parse("events.iterate.com/stream/subscription-parked", args.event);
        const existing = next.configuredSubscribersByKey[event.payload.subscriptionKey];
        // A parked fact for a since-removed subscription folds to nothing.
        if (existing === undefined) {
          return this.#reduceCircuitBreaker({ event: args.event, state: next });
        }
        return this.#reduceCircuitBreaker({
          event: args.event,
          state: {
            ...next,
            configuredSubscribersByKey: {
              ...next.configuredSubscribersByKey,
              [event.payload.subscriptionKey]: {
                ...existing,
                parkedAtOffset: event.payload.atOffset,
              },
            },
          },
        });
      }

      case "events.iterate.com/stream/subscription-resumed": {
        const event = parse("events.iterate.com/stream/subscription-resumed", args.event);
        const existing = next.configuredSubscribersByKey[event.payload.subscriptionKey];
        if (existing === undefined) {
          return this.#reduceCircuitBreaker({ event: args.event, state: next });
        }
        const { parkedAtOffset: _cleared, ...resumed } = existing;
        return this.#reduceCircuitBreaker({
          event: args.event,
          state: {
            ...next,
            configuredSubscribersByKey: {
              ...next.configuredSubscribersByKey,
              [event.payload.subscriptionKey]: resumed,
            },
          },
        });
      }

      case "events.iterate.com/stream/subscription-cursor-set":
        // The seek itself is a side effect on the spine's cursor row (see
        // #processEvent); the fold only validates and counts the fact.
        parse("events.iterate.com/stream/subscription-cursor-set", args.event);
        return this.#reduceCircuitBreaker({ event: args.event, state: next });

      case "events.iterate.com/stream/child-stream-created": {
        const event = parse("events.iterate.com/stream/child-stream-created", args.event);
        if (next.path === undefined) {
          return this.#reduceCircuitBreaker({ event: args.event, state: next });
        }
        const childPath = immediateChildPath(next.path, event.payload.childPath);
        if (childPath === null || next.childPaths.includes(childPath)) {
          return this.#reduceCircuitBreaker({ event: args.event, state: next });
        }
        return this.#reduceCircuitBreaker({
          event: args.event,
          state: { ...next, childPaths: [...next.childPaths, childPath] },
        });
      }

      case "events.iterate.com/stream/error-occurred":
        parse("events.iterate.com/stream/error-occurred", args.event);
        return this.#reduceCircuitBreaker({ event: args.event, state: next });

      default:
        return this.#reduceCircuitBreaker({ event: args.event, state: next });
    }
  }

  /**
   * Post-commit side effects for one just-reduced event. Historical catch-up
   * only reduces state; it never replays side effects. Async work goes through
   * `#runInBackground`, so nothing here can fail the append that triggered it.
   */
  #processEvent(args: ReducedCoreEvent): void {
    this.#pauseIfCircuitBreakerTripped(args);

    // Copied control events folded to nothing (first-hand guard in #reduce);
    // they must produce no side effects either.
    if (
      args.event.type.startsWith("events.iterate.com/stream/") &&
      args.event.source?.crossPostedFrom !== undefined
    ) {
      return;
    }

    switch (args.event.type) {
      case "events.iterate.com/stream/subscription-configured": {
        const event = CoreProcessorContract.parseEvent(
          "events.iterate.com/stream/subscription-configured",
          args.event,
        );
        this.#subscribers.onSubscriptionConfigured(event.payload, event.offset);
        return;
      }
      case "events.iterate.com/stream/subscription-removed": {
        const event = CoreProcessorContract.parseEvent(
          "events.iterate.com/stream/subscription-removed",
          args.event,
        );
        this.#subscribers.onSubscriptionRemoved(event.payload.subscriptionKey);
        return;
      }
      case "events.iterate.com/stream/subscription-resumed": {
        const event = CoreProcessorContract.parseEvent(
          "events.iterate.com/stream/subscription-resumed",
          args.event,
        );
        this.#subscribers.onResumed(event.payload.subscriptionKey);
        return;
      }
      case "events.iterate.com/stream/subscription-cursor-set": {
        const event = CoreProcessorContract.parseEvent(
          "events.iterate.com/stream/subscription-cursor-set",
          args.event,
        );
        this.#subscribers.onCursorSet(event.payload.subscriptionKey, event.payload.afterOffset);
        return;
      }
      case "events.iterate.com/stream/woken":
        // Every incarnation re-announces this stream to its ancestors, not
        // just the birth one. The appends are idempotent (stable key per
        // ancestor/path pair, deduped in the ancestor's log), so re-announcing
        // is a cheap no-op once landed — and an announcement lost in flight
        // (isolate recycled by a deploy mid birth turn, transient ancestor
        // failure) heals on the next wake instead of orphaning the stream:
        // ancestors would otherwise never fold `child-stream-created`, leaving
        // listings blind and birth reactions unarmed forever. Fire-and-forget
        // by design — a newborn must never block its own boot on ancestor
        // health (the parent's processor may be mid-append INTO this stream,
        // so waiting on the parent's ack here is a reentrant deadlock).
        this.#announceToAncestors(args);
        return;
      default:
        return;
    }
  }

  #reduceCircuitBreaker(args: {
    event: StreamEvent;
    state: CoreProcessorState;
  }): CoreProcessorState {
    if (args.event.type === "events.iterate.com/stream/woken") return args.state;

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

  #pauseIfCircuitBreakerTripped(args: ReducedCoreEvent): void {
    if (args.state.circuitBreaker.trippedAtOffset !== args.event.offset) return;
    if (args.previousState.circuitBreaker.trippedAtOffset === args.event.offset) return;
    if (args.event.type === "events.iterate.com/stream/paused") return;
    this.append({
      type: "events.iterate.com/stream/paused",
      idempotencyKey: `stream-paused:${args.event.offset}`,
      payload: {
        reason: "circuit breaker tripped: burst rate limit exceeded",
      },
    });
  }

  /** Tell every ancestor stream (up to the root) that this stream exists. */
  #announceToAncestors(args: ReducedCoreEvent): void {
    const path = args.state.path;
    if (path === undefined || path === "/") return;

    const pathSegments = path.split("/").filter(Boolean);
    const ancestorPaths = ["/"];
    for (let index = 1; index < pathSegments.length; index += 1) {
      ancestorPaths.push(`/${pathSegments.slice(0, index).join("/")}`);
    }

    this.#runInBackground(async () => {
      await Promise.all(
        ancestorPaths.map((ancestorPath) =>
          this.#appendToStreamPath(ancestorPath, {
            type: "events.iterate.com/stream/child-stream-created",
            idempotencyKey: `child-stream-created:${ancestorPath}:${path}`,
            payload: { childPath: path },
          }),
        ),
      );
    });
  }

  /**
   * Cross-post receiving end — an ordinary push SINK on the target stream
   * (`(batch) => void`, the same shape every subscriber provides), reached by
   * a source stream's push subscription (sugar: `crossPostTo`). All
   * cross-post semantics — provenance, loop protection, idempotency keys,
   * the optional JSONata transform — live in `cross-post.ts`; this method
   * only appends the built inputs in its own synchronous turn.
   */
  acceptCrossPost(batch: StreamPushEventBatch): void {
    const inputs = buildAcceptCrossPostAppendInputs(batch, {
      projectId: this.name.projectId,
      path: this.name.path,
    });
    if (inputs.length > 0) this.append(...inputs);
  }

  #appendToStreamCoordinate(
    coordinate: { projectId: string | null; path: string },
    ...events: StreamEventInput[]
  ) {
    return this.env.STREAM.getByName(
      DurableObjectNameCodec.stringify(coordinate, { allowNullProjectId: true }),
    ).append(...events);
  }

  #appendToStreamPath(path: string, ...events: StreamEventInput[]) {
    return this.#appendToStreamCoordinate({ path, projectId: this.name.projectId }, ...events);
  }

  #runInBackground(work: () => Promise<unknown>): void {
    let promise: Promise<unknown>;
    try {
      promise = work();
    } catch (error) {
      console.error("stream core background work failed", error);
      return;
    }
    this.ctx.waitUntil(promise);
    void promise.catch((error: unknown) => {
      console.error("stream core background work failed", error);
    });
  }

  // ===========================================================================
  // Core state checkpoint: reduced state in KV, rebuilt from the event log.
  // ===========================================================================

  #readCoreProcessorState(): CoreProcessorState {
    const stored = this.ctx.storage.kv.get<unknown>("state");
    const storedVersion = this.ctx.storage.kv.get<unknown>("stateVersion") ?? 1;
    // State persisted by a reducer of a different version is incomplete (it
    // was reduced before newer derived fields existed), so it is discarded and
    // rebuilt from the event log rather than trusted.
    const storedStateIsCurrent = stored !== undefined && storedVersion === CORE_STATE_VERSION;
    const storedState = storedStateIsCurrent
      ? CoreProcessorContract.stateSchema.parse(stored)
      : this.#recoverCoreProcessorStateFromEventLog();
    if (storedState === undefined) return CoreProcessorContract.stateSchema.parse({});

    const state = this.#catchUpCoreProcessorState(storedState);

    if (!storedStateIsCurrent) {
      // A version-mismatch rebuild replayed the config from the log, but the
      // spine's SQLite cursor rows are storage and survived as-is — possibly
      // describing a world the new fold no longer derives (a subscription
      // whose config event no longer parses loses its config but kept its
      // row; a row's backoff may blame code the new version replaced). Drop
      // rows with no surviving config; keep progress (ackedOffset is
      // monotonic truth about the same immutable log) but clear failure state
      // so every survivor gets an immediate fresh try under the new fold.
      reconcileSubscriptionCursorRows(
        this.#subscriptionCursorStore,
        new Set(Object.keys(state.configuredSubscribersByKey)),
      );
    }

    if (!storedStateIsCurrent || state.maxOffset !== storedState.maxOffset) {
      this.#writeCoreProcessorState(state);
    }
    return state;
  }

  #stateVersionWritten = false;
  /** True while `#coreProcessorState` is ahead of the KV checkpoint. */
  #checkpointDirty = false;
  #eventsSinceCheckpoint = 0;
  #checkpointWrittenAtMs = 0;
  /** Debounce bounds: checkpoint at least every N events / T ms of appends. */
  static readonly #CHECKPOINT_EVERY_EVENTS = 64;
  static readonly #CHECKPOINT_MAX_LAG_MS = 1_000;

  /**
   * The debounced per-append checkpoint. Serializing the full core state into
   * KV on EVERY append is O(state) write amplification per event — on a busy
   * agent stream the state (config payloads, roster) easily outweighs the
   * event. Event rows are the commit boundary and the durable truth; the KV
   * checkpoint is a rebuild accelerator, and boot ALWAYS folds log rows past
   * it (`#catchUpCoreProcessorState`, paged) — so a checkpoint that lags by a
   * bounded window (64 events / 1s) costs a small constructor fold, never
   * correctness. Alarm and idle teardown flush so a stream going quiet
   * checkpoints before it hibernates.
   */
  #checkpointCoreProcessorState(newEventCount: number): void {
    this.#eventsSinceCheckpoint += newEventCount;
    const now = Date.now();
    if (
      this.#eventsSinceCheckpoint < StreamDurableObject.#CHECKPOINT_EVERY_EVENTS &&
      now - this.#checkpointWrittenAtMs < StreamDurableObject.#CHECKPOINT_MAX_LAG_MS
    ) {
      this.#checkpointDirty = true;
      return;
    }
    this.#writeCoreProcessorState(this.#coreProcessorState);
  }

  /** Write the checkpoint now if the in-memory state is ahead of it. */
  #flushCoreProcessorState(): void {
    if (this.#checkpointDirty) this.#writeCoreProcessorState(this.#coreProcessorState);
  }

  #writeCoreProcessorState(state: CoreProcessorState): void {
    this.ctx.storage.kv.put("state", state);
    this.#checkpointDirty = false;
    this.#eventsSinceCheckpoint = 0;
    this.#checkpointWrittenAtMs = Date.now();
    // The version is a constant per deploy; re-putting it on every append is
    // pure write amplification. Once per incarnation is exactly as durable.
    if (!this.#stateVersionWritten) {
      this.ctx.storage.kv.put("stateVersion", CORE_STATE_VERSION);
      this.#stateVersionWritten = true;
    }
  }

  /** Fold any event-log rows past the checkpoint into the state (no side effects). */
  #catchUpCoreProcessorState(state: CoreProcessorState): CoreProcessorState {
    const highestOffset = this.#log.highestOffset();
    let next = state;
    // PAGED, never one monolithic read: this is also the version-bump rebuild
    // path (replay from offset 0), and a capture stream's full log
    // materialized into one array can exceed the DO's 128MB heap — an OOM in
    // the CONSTRUCTOR, i.e. a stream bricked on every wake. The fold is
    // incremental; only the read needed paging.
    while (next.maxOffset < highestOffset) {
      const page = this.#log.getRange({
        afterOffset: next.maxOffset,
        beforeOffset: highestOffset + 1,
        limit: 500,
        // Ephemeral rows folded on append (counters + circuit breaker), so a
        // rebuild must re-fold them for the same state. Evicted rows simply
        // stop counting — fine, the fold is monotonic bookkeeping.
        includeEphemeral: true,
      });
      if (page.length === 0) break;
      for (const event of page) {
        if (event.offset <= next.maxOffset) continue;
        next = this.#reduce({ event, state: next }, "replay");
      }
    }
    return next;
  }

  /**
   * KV state is the fast path, but SQL rows are the durable source of truth.
   * If a deployed DO has rows but no (current-version) KV state, replay the
   * event log instead of treating the stream as empty and trying to insert
   * offset 1 again.
   */
  #recoverCoreProcessorStateFromEventLog(): CoreProcessorState | undefined {
    if (this.#log.highestOffset() === 0) return undefined;
    return this.#catchUpCoreProcessorState(CoreProcessorContract.stateSchema.parse({}));
  }

  // ===========================================================================
  // Subscriptions: the public delivery surface.
  // ===========================================================================

  /**
   * Subscribes to catch-up then live event batches.
   *
   * Synchronous because it mutates the in-memory connection table and returns
   * the live handle for the current Durable Object incarnation; cross-RPC
   * callers still observe an async call through their stub.
   *
   * `subscribe({ subscriptionKey: "s", processEventBatch })` live-tails by
   * default. `replayAfterOffset: 0` replays from the first event; `3` starts at
   * offset 4. Re-subscribing with the same key replaces the old connection.
   * Omit `subscriptionKey` for an anonymous subscription (the stream assigns a
   * random key). Call the returned `unsubscribe()` to stop delivery.
   *
   * Every batch carries the stream's core reduced `state` as of
   * `streamMaxOffset`, and every subscription — with or without replay —
   * immediately receives one batch on open so the subscriber can paint its
   * first render without a separate getState call. Pass `events: false` for a
   * state-only subscription: same batches, `events` always `[]`, consecutive
   * appends coalesced into one state delivery.
   *
   * This verb opens EPHEMERAL subscriptions only — session-scoped, forgotten
   * on disconnect, zero return frames on the wire. Durable subscriptions are
   * desired state (`subscription-configured` events); their connections are
   * created exclusively by the stream's own spine (a poke's returned sink),
   * never by an inbound subscribe call.
   */
  subscribe(args: Parameters<Stream["subscribe"]>[0]): StreamSubscriptionHandle {
    const subscriptionKey = args.subscriptionKey?.trim() || crypto.randomUUID();
    if (this.#coreProcessorState.configuredSubscribersByKey[subscriptionKey] !== undefined) {
      throw new Error(`subscriptionKey "${subscriptionKey}" is reserved for a durable subscriber`);
    }
    if (
      args.replayAfterOffset !== undefined &&
      (!Number.isInteger(args.replayAfterOffset) || args.replayAfterOffset < 0)
    ) {
      // NaN binds as SQL NULL downstream (`offset > NULL` matches nothing), so
      // an unvalidated cursor produces a live-looking subscription that
      // silently delivers nothing forever.
      throw new Error(`replayAfterOffset must be a non-negative integer`);
    }

    // Validate the caller-supplied descriptor at the boundary. The public
    // `Stream.subscribe` contract types `subscriber` as `unknown`, so without
    // this check a malformed descriptor would only fail later, deep inside the
    // reducer, while appending the `subscriber-connected` presence fact. That
    // append is wrapped in a catch-and-log, so the connection would already be
    // live and delivering with NO entry on the presence roster — the runtime
    // connection table and its event-sourced mirror would silently disagree.
    // The live `getRuntimeState` capability rides as a SIBLING argument (the
    // same position the wake handshake gives it), never inside the descriptor.
    const presence =
      args.subscriber === undefined
        ? undefined
        : StreamSubscriberDescriptorSchema.parse(args.subscriber);

    // One filter shape everywhere: `eventTypes` is sugar for the selector's
    // type list (compileEventSelector also validates any condition upfront).
    const selector = compileEventSelector({
      ...args.selector,
      ...(args.eventTypes === undefined ? {} : { eventTypes: [...args.eventTypes] }),
    });

    const connection = this.#subscribers.openEphemeral({
      subscriptionKey,
      sink: args.processEventBatch,
      replayAfterOffset: args.replayAfterOffset,
      selector,
      events: args.events,
      presence,
      getRuntimeState: args.getRuntimeState,
    });

    return new StreamSubscriptionRpcTarget({
      close: () => connection.close("unsubscribed"),
      isLive: () => connection.isLive(),
      subscriptionKey,
      streamMaxOffset: this.#coreProcessorState.maxOffset,
    });
  }

  /**
   * One-shot convenience over `subscribe()`: replay from the requested cursor,
   * then live-tail until a caller predicate accepts an event.
   *
   * Intentionally not a durable waiter. If the RPC caller or this DO
   * incarnation dies, the wait dies too; callers that need retry semantics
   * should call again with the same `afterOffset`.
   */
  async waitForEvent(args: Parameters<Stream["waitForEvent"]>[0]): Promise<StreamEvent> {
    if (args.eventTypes === undefined && args.predicate === undefined) {
      throw new Error("waitForEvent requires eventTypes or predicate.");
    }
    if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
      throw new Error("waitForEvent timeoutMs must be a positive number.");
    }
    if (
      args.afterOffset !== undefined &&
      (!Number.isInteger(args.afterOffset) || args.afterOffset < 0)
    ) {
      throw new Error("waitForEvent afterOffset must be a non-negative integer.");
    }

    const predicate = args.predicate ?? (() => true);
    const found = Promise.withResolvers<StreamEvent>();

    // Bound the memory a long wait on a busy stream can hold: keep a count and a
    // small ring of recent types for the timeout message rather than every seen
    // event (events can be multi-megabyte).
    let seenCount = 0;
    const recentTypes: string[] = [];

    // Scan delivered batches in order. Predicate work is chained instead of run
    // inline so an async predicate never blocks stream delivery, and a later
    // batch can never overtake an earlier one. The first match wins; a predicate
    // that throws rejects the wait.
    let scan: Promise<void> = Promise.resolve();
    const handle = this.subscribe({
      eventTypes: args.eventTypes,
      replayAfterOffset: args.afterOffset,
      subscriber: { description: "waitForEvent" },
      processEventBatch: ({ events }) => {
        scan = scan.then(async () => {
          for (const event of events) {
            seenCount += 1;
            recentTypes.push(event.type);
            if (recentTypes.length > 20) recentTypes.shift();
            if (await predicate(event)) found.resolve(event);
          }
        });
        void scan.catch((error: unknown) => found.reject(error));
      },
    });

    const timer = setTimeout(() => {
      found.reject(
        new Error(
          `Timed out waiting for stream event after ${args.timeoutMs}ms ` +
            `(saw ${seenCount} events; recent types: ${recentTypes.join(", ") || "none"}).`,
        ),
      );
    }, args.timeoutMs);

    try {
      return await found.promise;
    } finally {
      clearTimeout(timer);
      handle.unsubscribe();
    }
  }

  getProcessorRuntimeState(args: {
    subscriptionKey: string;
  }): Promise<ProcessorRuntimeState | null> {
    return this.#subscribers.getProcessorRuntimeState(args.subscriptionKey);
  }

  runtimeState(): {
    coreProcessorState: CoreProcessorState;
    runtime: {
      connections: Record<string, ConnectionRuntimeState>;
      subscriptions: Record<string, SubscriptionRuntimeState>;
    };
  } {
    return {
      coreProcessorState: this.#coreProcessorState,
      runtime: {
        connections: this.#subscribers.connectionRuntimeState(),
        subscriptions: this.#subscribers.subscriptionRuntimeState(),
      },
    };
  }

  // ===========================================================================
  // Operator/admin verbs.
  // ===========================================================================

  /** Sever every idle durable connection now — the idle timer's action, exposed for tests/operators. */
  runIdleTeardownNow(): void {
    this.#subscribers.runIdleTeardownNow();
    // A stream going quiet checkpoints before it hibernates, so the next wake
    // rebuilds from a fresh checkpoint instead of folding the debounce window.
    this.#flushCoreProcessorState();
  }

  /**
   * Wipes this stream's durable storage and aborts the current incarnation.
   * The next request boots a fresh stream (new `created` + `woken` events).
   */
  async reset(): Promise<void> {
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.sync();
    this.kill();
  }

  /** Kills the current Durable Object incarnation so experiments can observe restart behavior. */
  kill(): void {
    this.ctx.abort("kill requested");
  }
}

/**
 * What `append` accepts over the wire: a public event input plus the optional
 * `offset` optimistic-concurrency assertion (split off before validation).
 */
// Built ONCE: constructing a zod schema per appended event cost ~20µs/event
// inside the synchronous commit turn (~50x the hoisted parse).
const StreamAppendInput = StreamEventInputSchema.extend({
  offset: z.number().int().nonnegative().optional(),
}).strict();

/**
 * One committed event with the core state before and after reducing it — what
 * the append loop hands to `#processEvent` after the commit (the same shape
 * hosted processors receive per reduced event).
 */
type ReducedCoreEvent = {
  event: StreamEvent;
  previousState: CoreProcessorState;
  state: CoreProcessorState;
};

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

function parseStreamDurableObjectName(name: string | undefined) {
  if (!name) {
    throw new Error("Stream Durable Object must be addressed by name.");
  }
  return DurableObjectNameCodec.parse(name, { allowNullProjectId: true });
}

/**
 * The immediate child segment of `parentPath` that `announcedPath` descends
 * through, or null when the announcement is not beneath this stream.
 */
function immediateChildPath(parentPath: string, announcedPath: string): string | null {
  if (announcedPath === parentPath) return null;
  const parentPrefix = parentPath === "/" ? "/" : `${parentPath}/`;
  if (!announcedPath.startsWith(parentPrefix)) return null;
  const [firstSegment] = announcedPath.slice(parentPrefix.length).split("/").filter(Boolean);
  if (firstSegment === undefined) return null;
  return parentPath === "/" ? `/${firstSegment}` : `${parentPath}/${firstSegment}`;
}

/** How long a stream may hold idle configured delivery connections before severing them. */
function idleTeardownMs(env: Env): number {
  const raw = (env as { STREAM_IDLE_TEARDOWN_MS?: string | number }).STREAM_IDLE_TEARDOWN_MS;
  const parsed = typeof raw === "string" ? Number(raw) : raw;
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0 ? parsed : 5 * 60_000;
}
