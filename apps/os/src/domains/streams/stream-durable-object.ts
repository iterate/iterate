import { DurableObject } from "cloudflare:workers";
import jsonata from "@mmkal/jsonata/sync";
import { z } from "zod";
import type { Env } from "../../env.ts";
import type { Stream } from "../../itx-api.generated.ts";
import { StreamSubscriptionRpcTarget } from "../../rpc-targets.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { DynamicWorkerRunner } from "../workers/worker-runner.ts";
import type { DynamicWorkerRef } from "../workers/schemas.ts";
import { defaultProjectWorkerRef } from "../repos/utils.ts";
import { indexStreamEventBatch } from "../search/search-index.ts";
import { buildCrossPostAppendInput, type CrossPostProvenanceChain } from "./cross-post.ts";
import type { ProcessorRuntimeState, StreamSubscriptionHandle } from "./rpc-types.ts";
import type { StreamEvent, StreamEventInput } from "./schemas.ts";
import { StreamEventInput as StreamEventInputSchema } from "./schemas.ts";
import type { StreamSubscriberWakeRequest } from "./stream-processor-host.ts";
import { StreamEventLog } from "./stream-storage.ts";
import { StreamConnections, type ConnectionRuntimeState } from "./stream-connections.ts";
import {
  ProjectWorkerDelivery,
  type ProjectWorkerDeliveryRuntimeState,
} from "./project-worker-delivery.ts";
import type { StreamEventBatch } from "./rpc-types.ts";
import {
  CORE_STATE_VERSION,
  CoreProcessorContract,
  StreamSubscriberDescriptor as StreamSubscriberDescriptorSchema,
  type ConfiguredSubscriberDurableObjectType,
  type CoreProcessorState,
  type ConfiguredStreamSubscriber,
  type LiveStreamSubscriberDescriptor,
  type StreamSubscriptionType,
} from "./core-processor-contract.ts";

const DEFAULT_GET_EVENTS_LIMIT = 500;
const MAX_GET_EVENTS_LIMIT = 500;

/** DO-KV key holding the project worker delivery checkpoint (see ProjectWorkerDelivery). */
const WORKER_DELIVERY_CHECKPOINT_KEY = "project-worker-delivery:checkpoint";

/** DO-KV key holding the search-index delivery checkpoint (SPIKE — see domains/search). */
const SEARCH_INDEX_DELIVERY_CHECKPOINT_KEY = "search-index-delivery:checkpoint";

// A delivery that needs a cold worker build gives up after this long and
// retries later; the build itself survives via waitUntil, so the retry hits
// the warm cache (see withBuildBudget in worker-loader.ts).
const WORKER_DELIVERY_BUILD_BUDGET_MS = 15_000;

/**
 * Backstop cap on a cross-post provenance chain. The structural cycle guard
 * (never post into a stream already on the chain) is the real protection; the
 * cap only bounds acyclic rule graphs nobody should build (a 5-hop relay is a
 * design smell, not a use case).
 */
const MAX_CROSS_POST_HOPS = 5;

// Compiled-condition cache: rules re-evaluate on every matching append, and a
// stream's rule set is small and stable, so compile-once is the sensible
// steady state. Bounded so a pathological churn of rule expressions cannot
// grow the map without limit (clearing wholesale is fine — recompiling is
// cheap, correctness never depends on the cache).
const compiledConditions = new Map<string, jsonata.Expression>();
const MAX_COMPILED_CONDITIONS = 200;

/** Parse a JSONata cross-post condition, throwing on invalid expressions. */
function compileCrossPostCondition(condition: string): jsonata.Expression {
  const cached = compiledConditions.get(condition);
  if (cached !== undefined) return cached;
  const compiled = jsonata(condition);
  if (compiledConditions.size >= MAX_COMPILED_CONDITIONS) compiledConditions.clear();
  compiledConditions.set(condition, compiled);
  return compiled;
}

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
 * 4. Subscriptions — live delivery connections managed by
 *    `stream-connections.ts`; this class only decides policy (who may
 *    subscribe, which configured subscribers to wake, what facts to append).
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
  readonly #connections = new StreamConnections({
    idleTeardownMs: idleTeardownMs(this.env),
    hooks: {
      readEvents: (args) => this.getEvents(args),
      coreState: () => this.#coreProcessorState,
      appendConnectedFact: (payload) =>
        this.#appendPresenceFact({
          type: "events.iterate.com/stream/subscriber-connected",
          payload,
        }),
      appendDisconnectedFact: (payload) =>
        this.#appendPresenceFact({
          type: "events.iterate.com/stream/subscriber-disconnected",
          payload,
        }),
      onConfiguredConnectionLost: () => this.#reconcileConnections(),
    },
  });
  /**
   * Checkpointed delivery of every committed event to the project's default
   * worker (`processEventBatch`). Derived, not configured: every project-scoped
   * stream has exactly this one delivery, so it needs no subscription event and
   * cannot drift. Global streams have no project worker to deliver to.
   */
  readonly #workerDelivery: ProjectWorkerDelivery | null =
    this.name.projectId === null
      ? null
      : new ProjectWorkerDelivery({
          readEvents: (args) => this.getEvents(args),
          coreState: () => this.#coreProcessorState,
          readCheckpoint: () =>
            this.ctx.storage.kv.get<number>(WORKER_DELIVERY_CHECKPOINT_KEY) ?? 0,
          writeCheckpoint: (offset) =>
            this.ctx.storage.kv.put(WORKER_DELIVERY_CHECKPOINT_KEY, offset),
          deliver: (batch) => this.#deliverToProjectWorker(batch),
        });
  /**
   * SPIKE: checkpointed delivery of every committed event into the search
   * index (domains/search/search-index.ts). Same derived-delivery shape as
   * `#workerDelivery` — the stream owns the checkpoint, so indexing is
   * at-least-once and a fresh checkpoint backfills the stream's whole
   * history. Segment documents are idempotent rewrites, so redelivery is
   * harmless. Global streams are not indexed (no project to scope them to).
   */
  readonly #searchIndexDelivery: ProjectWorkerDelivery | null =
    this.name.projectId === null
      ? null
      : new ProjectWorkerDelivery({
          label: "Search index",
          readEvents: (args) => this.getEvents(args),
          coreState: () => this.#coreProcessorState,
          readCheckpoint: () =>
            this.ctx.storage.kv.get<number>(SEARCH_INDEX_DELIVERY_CHECKPOINT_KEY) ?? 0,
          writeCheckpoint: (offset) =>
            this.ctx.storage.kv.put(SEARCH_INDEX_DELIVERY_CHECKPOINT_KEY, offset),
          deliver: (batch) =>
            indexStreamEventBatch({
              batch,
              readEvents: (args) => this.getEvents(args),
            }),
        });
  // subscriptionKeys with a configured subscriber wakeup in flight, so concurrent
  // reconciliation runs never wake the same subscriber twice.
  readonly #connecting = new Set<string>();
  // Retry bookkeeping for failed configured-subscriber wakes. Without a retry,
  // one transient RPC failure (subscriber cold start, cross-script hiccup)
  // silences the subscription until the NEXT qualifying append — which for
  // write-once streams like secrets may never come
  // (tasks/stream-subscriber-deliveries-stall-mid-turn.md). In-memory is
  // deliberate: an eviction drops the timers, but the durable subscription
  // config survives and the next append or subscriber read re-wakes.
  readonly #wakeRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #wakeRetryAttempts = new Map<string, number>();
  #coreProcessorState: CoreProcessorState;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#coreProcessorState = this.#readCoreProcessorState();

    // The first boot appends the `created` fact; every wake (fetch, RPC, alarm)
    // appends a `woken` fact. The woken fact is also what restores configured
    // connections: the core processor's reconciler runs as its post-commit side
    // effect, so a stream that wakes with configured subscriptions but no new
    // appends still reconnects.
    if (this.#coreProcessorState.eventCount === 0) {
      this.append({
        type: "events.iterate.com/stream/created",
        payload: { projectId: this.name.projectId, path: this.name.path },
      });
    }
    this.append({
      type: "events.iterate.com/stream/woken",
      payload: { incarnationId: crypto.randomUUID() },
    });
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
      const { offset: expectedOffset, ...body } = StreamAppendInput.strict().parse(eventInput);

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
      workingState = this.#reduce({ event: committed, state: previousState });

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
    // Keep this section await-free: event rows + core state are the append boundary.
    this.#log.insert(newEvents);
    this.#writeCoreProcessorState(workingState);
    this.#coreProcessorState = workingState;

    // 3. Post-commit fan-out. Core side effects are fire-and-forget where
    // async, so nothing here can fail the append.
    for (const reduced of reducedEvents) this.#processEvent(reduced);
    this.#connections.wake();
    this.#workerDelivery?.wake();
    this.#searchIndexDelivery?.wake();

    // Re-wake any configured subscription left without a live connection (idle
    // teardown, clean unsubscribe, …). The subscriber re-handshakes from its
    // durable checkpoint, so replay covers this very event; a no-op once
    // everything is connected.
    //
    // Exactly ONE event type is excluded as a re-wake trigger:
    // `subscriber-disconnected`. `connection.close()` appends one as it removes
    // the connection from the table, so at that instant `#needsConfiguredReconcile`
    // is transiently true for the just-closed key — reconciling on it would
    // immediately re-wake and undo every teardown. Re-wake must wait for the
    // next genuine append. Every other event is safe: `woken` /
    // `subscription-configured` / `subscriber-connected` all reach this line
    // with the check already a no-op.
    const hasRewakeTriggeringAppend = newEvents.some(
      (event) => event.type !== "events.iterate.com/stream/subscriber-disconnected",
    );
    if (hasRewakeTriggeringAppend && this.#needsConfiguredReconcile()) {
      this.#reconcileConnections();
    }

    // Re-arm (or clear) the idle timer against the post-append connection set,
    // so a stream that just went quiet sheds its configured delivery sessions
    // and lets both DOs hibernate.
    this.#connections.armOrClearIdleTimer();

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

  /** Synchronous committed-event range read. Keep await-free (see getEvent). */
  getEvents(
    args: {
      afterOffset?: number;
      beforeOffset?: number | null;
      eventTypes?: readonly string[];
      limit?: number;
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
    if (args.event.type === "events.iterate.com/stream/subscription-configured") {
      // Configured subscriptions are durable desired state. Once this event is
      // committed, the reducer stores it in `configuredSubscribersByKey` and the
      // stream is allowed to re-wake that subscriber forever. So target
      // validation must happen here, before offset assignment and storage — not
      // inside the later fire-and-forget wake path, where the invalid target
      // would already be durable state that every future append re-reconciles.
      // The lifecycle e2e tests ("configured durable object subscribers must
      // target the stream project" and friends) assert both the rejection and
      // that no event was committed.
      const event = CoreProcessorContract.parseEventInput(
        "events.iterate.com/stream/subscription-configured",
        args.event,
      );
      this.#validateConfiguredSubscriberTarget(event.payload.subscriber);
    }

    if (args.event.type === "events.iterate.com/stream/rule-configured") {
      const event = CoreProcessorContract.parseEventInput(
        "events.iterate.com/stream/rule-configured",
        args.event,
      );
      this.#validateStreamRuleTarget(event.payload);
      // A rule condition is durable desired state the cross-post path evaluates
      // on every future matching append, so an unparseable expression must be
      // rejected here — before it commits — not discovered as a per-event
      // error forever after.
      if (event.payload.condition !== undefined) {
        compileCrossPostCondition(event.payload.condition);
      }
    }

    if (!args.state.paused) return;

    // Presence facts pass through the pause door alongside resume/error/woken:
    // a paused stream still has subscribers attaching (e.g. an operator's
    // browser), and the roster must stay truthful for the stream to recover.
    switch (args.event.type) {
      case "events.iterate.com/stream/resumed":
      case "events.iterate.com/stream/error-occurred":
      case "events.iterate.com/stream/woken":
      case "events.iterate.com/stream/subscriber-connected":
      case "events.iterate.com/stream/subscriber-disconnected":
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
  #reduce(args: { event: StreamEvent; state: CoreProcessorState }): CoreProcessorState {
    const parse = CoreProcessorContract.parseEvent;
    let next: CoreProcessorState = {
      ...args.state,
      eventCount: args.state.eventCount + 1,
      maxOffset: args.event.offset,
    };

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

      case "events.iterate.com/stream/metadata-updated": {
        const event = parse("events.iterate.com/stream/metadata-updated", args.event);
        return this.#reduceCircuitBreaker({
          event: args.event,
          state: { ...next, metadata: event.payload.metadata },
        });
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
        // A processor announcement on the connect event feeds the stream's
        // contract documentation registry (`processorsBySlug`).
        const announcement = subscriber?.processor?.announcement;
        if (announcement !== undefined) {
          next = {
            ...next,
            processorsBySlug: {
              ...next.processorsBySlug,
              [announcement.slug]: { announcedAtOffset: event.offset, announcement },
            },
          };
        }
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
              [event.payload.subscriptionKey]: latestConfiguredEvent(event),
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

      case "events.iterate.com/stream/rule-configured": {
        const event = parse("events.iterate.com/stream/rule-configured", args.event);
        return this.#reduceCircuitBreaker({
          event: args.event,
          state: {
            ...next,
            rulesById: {
              ...next.rulesById,
              [event.payload.ruleId]: latestConfiguredEvent(event),
            },
          },
        });
      }

      case "events.iterate.com/stream/rule-removed": {
        const event = parse("events.iterate.com/stream/rule-removed", args.event);
        const { [event.payload.ruleId]: _removed, ...rulesById } = next.rulesById;
        return this.#reduceCircuitBreaker({
          event: args.event,
          state: { ...next, rulesById },
        });
      }

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

    switch (args.event.type) {
      case "events.iterate.com/stream/woken":
      case "events.iterate.com/stream/subscription-configured":
      case "events.iterate.com/stream/subscription-removed":
        this.#reconcileConnections();
        return;
      case "events.iterate.com/stream/rule-configured":
      case "events.iterate.com/stream/rule-removed":
        return;
      case "events.iterate.com/stream/created":
        this.#announceToAncestors(args);
        return;
      default:
        this.#crossPostMatchingRules(args);
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
          this.appendToStreamPath(ancestorPath, {
            type: "events.iterate.com/stream/child-stream-created",
            idempotencyKey: `child-stream-created:${ancestorPath}:${path}`,
            payload: { childPath: path },
          }),
        ),
      );
    });
  }

  /**
   * Copy an event into every stream a matching cross-post rule targets.
   *
   * Every hop appends itself to the event's `source.crossPostedFrom` chain, so
   * a multi-hop route stays legible end to end. Loop protection is structural:
   * a copy is never posted into a stream that is already on the chain (which
   * includes this stream, the newest hop), and the chain length is capped as a
   * backstop against pathological rule graphs.
   */
  #crossPostMatchingRules(args: ReducedCoreEvent): void {
    const chain = args.event.source?.crossPostedFrom ?? [];
    if (chain.length >= MAX_CROSS_POST_HOPS) return;

    const candidateRules = Object.values(args.state.rulesById)
      .map(({ latestConfiguredEvent }) => latestConfiguredEvent.payload)
      .filter((rule) => rule.eventTypes.includes(args.event.type));
    if (candidateRules.length === 0) return;

    const sourceProjectId = args.state.projectId ?? this.name.projectId;
    const sourcePath = args.state.path ?? this.name.path;
    const { createdAt, offset } = args.event;

    this.#runInBackground(async () => {
      await Promise.all(
        candidateRules.map(async (rule) => {
          const target = {
            path: rule.path,
            projectId: rule.projectId === undefined ? this.name.projectId : rule.projectId,
          };
          const hop = {
            ruleId: rule.ruleId,
            createdAt,
            offset,
            path: sourcePath,
            projectId: sourceProjectId,
            type: args.event.type,
          };
          const crossPostedFrom: CrossPostProvenanceChain = [...chain, hop];
          const targetOnChain = crossPostedFrom.some(
            (entry) => entry.projectId === target.projectId && entry.path === target.path,
          );
          if (targetOnChain) return;

          if (rule.condition !== undefined) {
            let matched: unknown;
            try {
              matched = compileCrossPostCondition(rule.condition).evaluate(args.event);
            } catch (error) {
              // The raw event stays authoritative; the durable error record
              // just makes the skipped rule observable. Idempotent per
              // (rule, offset) so redeliveries cannot spam it.
              this.append({
                type: "events.iterate.com/stream/error-occurred",
                idempotencyKey: `cross-post-condition-failed:${rule.ruleId}:${offset}`,
                payload: {
                  message: `cross-post rule "${rule.ruleId}" condition failed on offset ${offset}: ${String(error)}`,
                },
              });
              return;
            }
            if (matched !== true) return;
          }

          await this.#appendToStreamCoordinate(
            target,
            buildCrossPostAppendInput({
              event: args.event,
              crossPostedFrom,
              idempotencyKey: `cross-post:${rule.ruleId}:${sourceProjectId ?? "global"}:${sourcePath}:${offset}`,
            }),
          );
        }),
      );
    });
  }

  /** Fire-and-forget configured subscriber reconciliation; never blocks append. */
  #reconcileConnections(): void {
    try {
      this.#reconcileConfiguredConnections();
    } catch (error) {
      console.error("Stream configured subscriber reconciliation failed", error);
    }
  }

  /**
   * Makes runtime configured connections match the persisted subscription config:
   * closes connections whose config disappeared, wakes a subscriber for each
   * configured subscription that has none. Triggered by woken/config changes and
   * by configured connection loss, never per append.
   */
  #reconcileConfiguredConnections(): void {
    const configured = this.#coreProcessorState.configuredSubscribersByKey;
    for (const subscriptionKey of this.#connections.configuredKeys()) {
      if (configured[subscriptionKey] === undefined) {
        this.#connections.close(subscriptionKey, "subscription-removed");
      }
    }

    for (const [subscriptionKey, entry] of Object.entries(configured)) {
      if (
        this.#connections.hasConfigured(subscriptionKey) ||
        this.#connecting.has(subscriptionKey)
      ) {
        continue;
      }

      // Reserve the key before any await so a concurrent reconcile can't wake twice.
      this.#connecting.add(subscriptionKey);
      this.#runInBackground(async () => {
        try {
          await this.#wakeConfiguredSubscriber({ configured: entry, subscriptionKey });
        } catch (error) {
          console.error("Stream configured subscriber wakeup failed", { error, subscriptionKey });
          this.#scheduleConfiguredWakeRetry(subscriptionKey);
        } finally {
          this.#connecting.delete(subscriptionKey);
        }
      });
    }
  }

  /**
   * True if a configured subscription currently has no live or in-flight
   * connection and needs re-waking.
   */
  #needsConfiguredReconcile(): boolean {
    return Object.keys(this.#coreProcessorState.configuredSubscribersByKey).some(
      (subscriptionKey) =>
        !this.#connections.hasConfigured(subscriptionKey) && !this.#connecting.has(subscriptionKey),
    );
  }

  // Backoff retry for a failed configured-subscriber wake. Gives up after a
  // bounded number of attempts (the subscriber is then genuinely broken, and
  // every later append still re-triggers reconciliation).
  #scheduleConfiguredWakeRetry(subscriptionKey: string): void {
    const MAX_WAKE_RETRY_ATTEMPTS = 6;
    if (this.#wakeRetryTimers.has(subscriptionKey)) return;
    const attempt = (this.#wakeRetryAttempts.get(subscriptionKey) ?? 0) + 1;
    this.#wakeRetryAttempts.set(subscriptionKey, attempt);
    if (attempt > MAX_WAKE_RETRY_ATTEMPTS) {
      console.error("Stream configured subscriber wakeup retries exhausted", {
        subscriptionKey,
        attempts: attempt - 1,
      });
      return;
    }

    const delayMs = Math.min(30_000, 500 * 2 ** (attempt - 1));
    const timer = setTimeout(() => {
      this.#wakeRetryTimers.delete(subscriptionKey);
      if (!this.#needsConfiguredReconcile()) return;
      this.#reconcileConnections();
    }, delayMs);
    this.#wakeRetryTimers.set(subscriptionKey, timer);
  }

  /**
   * Ask a configured subscriber to subscribe back. This is the offer side of a
   * live-capability handshake: the wake carries only serializable coordinates,
   * and the woken subscriber responds with `subscribe({ configured: true })`,
   * handing this stream a live `processEventBatch` callback capability (see
   * `stream-processor-host.ts` for the subscriber side and
   * `domains/capability-host/live-capability.ts` for the same pattern in itx).
   */
  async #wakeConfiguredSubscriber(args: {
    configured: CoreProcessorState["configuredSubscribersByKey"][string];
    subscriptionKey: string;
  }): Promise<void> {
    const { maxOffset, path, projectId } = this.#coreProcessorState;
    if (projectId === undefined || path === undefined) {
      throw new Error(
        "Cannot wake configured subscriber before stream coordinates are initialized.",
      );
    }
    const subscriber = args.configured.latestConfiguredEvent.payload.subscriber;
    const request: StreamSubscriberWakeRequest = {
      stream: { projectId, path, streamMaxOffset: maxOffset },
      subscriptionKey: args.subscriptionKey,
    };

    // Belt-and-braces: normal writes are rejected in `validateAppend` before
    // they become durable state. Keeping the same validation on the wake path
    // protects older/broken persisted state and any future internal caller that
    // reaches this method without going through append first.
    this.#validateConfiguredSubscriberTarget(subscriber);

    if (subscriber.type === "worker") {
      await this.#wakeWorkerSubscriber(subscriber.workerRef, request);
      return;
    }
    const durableObjectName = DurableObjectNameCodec.stringify(subscriber.address, {
      allowNullProjectId: true,
    });
    await this.#configuredSubscriberDurableObject(
      subscriber.type,
      durableObjectName,
    ).wakeStreamSubscriber(request);
  }

  #configuredSubscriberDurableObject(
    type: ConfiguredSubscriberDurableObjectType,
    durableObjectName: string,
  ): ConfiguredSubscriberTarget {
    const namespace = {
      agent: this.env.AGENT,
      "capability-host": this.env.CAPABILITY_HOST,
      project: this.env.PROJECT,
      repo: this.env.REPO,
      scheduler: this.env.SCHEDULER,
      secret: this.env.SECRET,
    }[type];
    return namespace.getByName(durableObjectName) as unknown as ConfiguredSubscriberTarget;
  }

  async #wakeWorkerSubscriber(
    workerRef: DynamicWorkerRef,
    request: StreamSubscriberWakeRequest,
  ): Promise<void> {
    if (this.name.projectId === null) {
      throw new Error("configured worker subscribers require a project-scoped stream");
    }
    // The wake runs in the worker ref's own itx scope, carrying only
    // serializable data.
    await new DynamicWorkerRunner({
      exports: this.ctx.exports,
      projectId: this.name.projectId,
      scopePath: workerRef.path,
      waitUntil: (promise) => this.ctx.waitUntil(promise),
    }).invokeCapability({
      args: [request],
      path: ["wakeStreamSubscriber"],
      ref: workerRef,
    });
  }

  /**
   * One checkpointed delivery into the project's default worker. The batch is
   * plain serializable data and the call is ordinary capability dispatch, so
   * the worker sees exactly the envelope live subscribers get. Throws propagate
   * to ProjectWorkerDelivery, which holds the checkpoint and retries.
   */
  async #deliverToProjectWorker(batch: StreamEventBatch): Promise<void> {
    const projectId = this.name.projectId;
    if (projectId === null) {
      throw new Error("project worker delivery requires a project-scoped stream");
    }
    const ref = defaultProjectWorkerRef();
    await new DynamicWorkerRunner({
      exports: this.ctx.exports,
      projectId,
      scopePath: ref.path,
      waitUntil: (promise) => this.ctx.waitUntil(promise),
    }).invokeCapability({
      args: [batch],
      buildBudgetMs: WORKER_DELIVERY_BUILD_BUDGET_MS,
      path: ["processEventBatch"],
      ref,
    });
  }

  #validateConfiguredSubscriberTarget(subscriber: ConfiguredStreamSubscriber): void {
    if (subscriber.type === "worker") {
      // Worker subscribers carry no Durable Object address: the wake path builds
      // an itx/project scope from this stream's own projectId and invokes the
      // DynamicWorkerRef inside it. That is why workers are safe for project
      // streams without a separate target projectId field, and why global
      // streams must reject them — there is no project boundary to supply.
      if (this.name.projectId === null) {
        throw new Error("configured worker subscribers require a project-scoped stream");
      }
      return;
    }
    // Durable Object subscribers do carry an address. Its projectId must equal
    // the stream's projectId exactly; a global stream (`projectId: null`) may
    // only target a global address, a project stream only Durable Objects in
    // that same project. This is the configured-subscriber safety invariant:
    // durable wakeup state must never encode cross-project authority.
    const projectId = subscriber.address.projectId;
    if (projectId !== this.name.projectId) {
      throw new Error(
        `configured ${subscriber.type} subscriber projectId ${projectId ?? "null"} does not match stream projectId ${this.name.projectId ?? "null"}`,
      );
    }
    if (projectId === null && subscriber.type !== "repo") {
      throw new Error(`configured ${subscriber.type} subscribers must be project-scoped`);
    }
  }

  #validateStreamRuleTarget(rule: { projectId?: string | null }): void {
    // A cross-post writes into the target stream using THIS Stream DO's own
    // authority, so a rule may only target streams within the source stream's
    // own project scope (`undefined` = same project). Same cross-project safety
    // invariant as configured subscribers: durable rule state must never let a
    // project-scoped stream push events into a global or other-project stream,
    // which would be a privilege escalation — global streams are admin-only.
    const targetProjectId = rule.projectId === undefined ? this.name.projectId : rule.projectId;
    if (targetProjectId === this.name.projectId) return;

    throw new Error(
      `cross-post rule target projectId ${targetProjectId ?? "null"} does not match stream projectId ${this.name.projectId ?? "null"}`,
    );
  }

  #appendToStreamCoordinate(
    coordinate: { projectId: string | null; path: string },
    ...events: StreamEventInput[]
  ) {
    return this.env.STREAM.getByName(
      DurableObjectNameCodec.stringify(coordinate, { allowNullProjectId: true }),
    ).append(...events);
  }

  appendToStreamPath(path: string, ...events: StreamEventInput[]) {
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

  /**
   * Presence facts are observations appended exactly once per actual open/close,
   * so they carry no idempotency keys. Close paths run during teardown where an
   * append can fail; that must never mask the close itself, so failures log.
   */
  #appendPresenceFact(event: StreamEventInput): void {
    try {
      this.append(event);
    } catch (error) {
      console.error("stream presence fact append failed", { type: event.type, error });
    }
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

    if (!storedStateIsCurrent || state.maxOffset !== storedState.maxOffset) {
      this.#writeCoreProcessorState(state);
    }
    return state;
  }

  #writeCoreProcessorState(state: CoreProcessorState): void {
    this.ctx.storage.kv.put("state", state);
    this.ctx.storage.kv.put("stateVersion", CORE_STATE_VERSION);
  }

  /** Fold any event-log rows past the checkpoint into the state (no side effects). */
  #catchUpCoreProcessorState(state: CoreProcessorState): CoreProcessorState {
    const highestOffset = this.#log.highestOffset();
    let next = state;
    if (highestOffset <= next.maxOffset) return next;
    for (const event of this.#log.getRange({
      afterOffset: next.maxOffset,
      beforeOffset: highestOffset + 1,
      limit: highestOffset - next.maxOffset,
    })) {
      if (event.offset <= next.maxOffset) continue;
      next = this.#reduce({ event, state: next });
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
   * This is the ONLY way a delivery connection is opened. Ephemeral and
   * configured subscriptions share this verb and everything behind it; the
   * `configured: true` branch below is just a different admission rule for
   * the same connection machinery.
   */
  subscribe(args: Parameters<Stream["subscribe"]>[0]): StreamSubscriptionHandle {
    if (args.configured === true) {
      // The configured-subscriber handshake response: a woken subscriber calls
      // the same public verb with its durable subscriptionKey to hand the
      // stream its live `processEventBatch` callback (see
      // `#wakeConfiguredSubscriber`). `StreamRpcTarget` restricts
      // `configured: true` to trusted-internal callers.
      const subscriptionKey = args.subscriptionKey?.trim() ?? "";
      if (subscriptionKey.length === 0) throw new Error("subscriptionKey must not be blank.");
      if (this.#coreProcessorState.configuredSubscribersByKey[subscriptionKey] === undefined) {
        throw new Error(`configured subscriber "${subscriptionKey}" is not configured`);
      }
      return this.#openSubscription({ ...args, subscriptionKey, subscriptionType: "configured" });
    }

    const subscriptionKey = args.subscriptionKey?.trim() || crypto.randomUUID();
    if (this.#coreProcessorState.configuredSubscribersByKey[subscriptionKey] !== undefined) {
      throw new Error(
        `subscriptionKey "${subscriptionKey}" is reserved for a configured subscriber`,
      );
    }
    return this.#openSubscription({ ...args, subscriptionKey, subscriptionType: "ephemeral" });
  }

  #openSubscription(
    args: Parameters<Stream["subscribe"]>[0] & {
      subscriptionKey: string;
      subscriptionType: StreamSubscriptionType;
    },
  ): StreamSubscriptionHandle {
    // Validate the caller-supplied descriptor at the boundary. The public
    // `Stream.subscribe` contract types `subscriber` as `unknown`, so without
    // this check a malformed descriptor would only fail later, deep inside the
    // reducer, while appending the `subscriber-connected` presence fact. That
    // append is wrapped in a catch-and-log, so the connection would already be
    // live and delivering with NO entry on the presence roster — the runtime
    // connection table and its event-sourced mirror would silently disagree.
    // Parsing the serializable projection here rejects the subscribe call before
    // any connection is registered; the live `getRuntimeState` capability is not
    // part of the serializable descriptor and is passed through separately.
    const subscriber = args.subscriber as LiveStreamSubscriberDescriptor | undefined;
    const presence =
      subscriber === undefined ? undefined : StreamSubscriberDescriptorSchema.parse(subscriber);

    const connection = this.#connections.open({
      subscriptionKey: args.subscriptionKey,
      subscriptionType: args.subscriptionType,
      processEventBatch: args.processEventBatch,
      replayAfterOffset: args.replayAfterOffset,
      eventTypes: args.eventTypes,
      events: args.events,
      presence,
      getRuntimeState: subscriber?.processor?.getRuntimeState,
    });

    // A live connection resets the wake-retry ledger for its key.
    this.#wakeRetryAttempts.delete(args.subscriptionKey);
    const pendingRetry = this.#wakeRetryTimers.get(args.subscriptionKey);
    if (pendingRetry !== undefined) {
      clearTimeout(pendingRetry);
      this.#wakeRetryTimers.delete(args.subscriptionKey);
    }

    return new StreamSubscriptionRpcTarget({
      close: () => connection.close("unsubscribed"),
      isLive: () => connection.isLive(),
      subscriptionKey: args.subscriptionKey,
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
    return this.#connections.getProcessorRuntimeState(args.subscriptionKey);
  }

  runtimeState(): {
    coreProcessorState: CoreProcessorState;
    runtime: {
      connections: Record<string, ConnectionRuntimeState>;
      searchIndexDelivery: ProjectWorkerDeliveryRuntimeState | null;
      workerDelivery: ProjectWorkerDeliveryRuntimeState | null;
    };
  } {
    return {
      coreProcessorState: this.#coreProcessorState,
      runtime: {
        connections: this.#connections.runtimeState(),
        searchIndexDelivery: this.#searchIndexDelivery?.runtimeState() ?? null,
        workerDelivery: this.#workerDelivery?.runtimeState() ?? null,
      },
    };
  }

  // ===========================================================================
  // Operator/admin verbs.
  // ===========================================================================

  /** Sever every idle configured connection now — the idle timer's action, exposed for tests/operators. */
  runIdleTeardownNow(): void {
    this.#connections.runIdleTeardownNow();
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
const StreamAppendInput = StreamEventInputSchema.extend({
  offset: z.number().int().nonnegative().optional(),
});

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

/**
 * Builds the durable desired-state record the core reducer stores for
 * configured subscriptions and cross-post rules: the latest committed
 * configuration event, verbatim. Generic so the stored record keeps the
 * event's literal `type` (the state schema requires it).
 */
function latestConfiguredEvent<
  Event extends Pick<StreamEvent, "offset" | "type" | "payload" | "createdAt">,
>(
  event: Event,
): { latestConfiguredEvent: Pick<Event, "offset" | "type" | "payload" | "createdAt"> } {
  return {
    latestConfiguredEvent: {
      offset: event.offset,
      type: event.type,
      payload: event.payload,
      createdAt: event.createdAt,
    } as Pick<Event, "offset" | "type" | "payload" | "createdAt">,
  };
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
 * The one method a configured subscriber Durable Object must expose. Stubs are
 * cast to this shape because the generated DurableObjectStub types would
 * otherwise chase each target class's full internal surface.
 */
type ConfiguredSubscriberTarget = {
  wakeStreamSubscriber(request: StreamSubscriberWakeRequest): Promise<void>;
};

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
