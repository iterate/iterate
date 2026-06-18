// Implements the built-in "core" processor.
//
// The Stream Durable Object runs this processor inline during append instead
// of through a subscription runner, because stream bookkeeping must be updated
// before committed events are delivered to subscribers. Apart from that
// co-location, core has the same shape as any other processor: reduced state
// (stream identity, subscriptions, the presence roster) plus non-serializable
// runtime state it reconciles against — the live delivery connections.
//
// `processEvent` is the reconciler. Its two operations are the universal ones:
// append events (subscriber-connected/disconnected presence facts, ancestor
// announcements) and mutate runtime state (dial configured-but-unconnected
// outbound subscribers, close connections whose configuration disappeared).

import type { StreamEvent, StreamEventInput } from "../../shared/event.ts";
import type { ConsumedEvent } from "../../shared/stream-processors.ts";
import type {
  LiveStreamSubscriberDescriptor,
  ProcessEventBatch,
  ProcessorRuntimeState,
} from "../../types.ts";
import { StreamProcessor } from "../../stream-processor.ts";
import {
  disposeIgnoredRpcResult,
  retainGetProcessorRuntimeState,
  retainProcessEventBatch,
} from "../../workers/rpc-lifecycle.ts";
import {
  CoreProcessorContract,
  ProcessorContractAnnouncement as ProcessorContractAnnouncementSchema,
  type CoreProcessorState,
  type ProcessorContractAnnouncement,
  type StreamSubscriberDescriptor,
  type StreamSubscriberDisconnectReason,
} from "./contract.ts";

export type CoreProcessorContract = typeof CoreProcessorContract;

/**
 * Runtime hooks the hosting Stream DO provides. The split keeps the DO the
 * owner of storage and RPC mechanics while core owns the decisions: core
 * decides WHEN to dial or close, the DO knows HOW to read committed events and
 * dispatch a subscriber's Callable.
 *
 * Optional so reduce-only usage (tests, state rebuilds) can construct the
 * processor without a live stream behind it; connection methods assert.
 */
export type CoreProcessorDeps = {
  /** Read committed events for the delivery pump. */
  getEvents?: (args: { afterOffset: number; limit: number }) => StreamEvent[];
  /** The live reduced core state (owned by the Stream DO between appends). */
  currentState?: () => CoreProcessorState;
  /** Dispatch one configured outbound subscriber's Callable with the handshake. */
  dial?: (args: {
    configured: CoreProcessorState["subscriptionsByKey"][string];
    subscriptionKey: string;
  }) => Promise<void>;
};

export class CoreStreamProcessor extends StreamProcessor<CoreProcessorContract, CoreProcessorDeps> {
  readonly contract = CoreProcessorContract;

  /**
   * Live delivery connections, keyed by subscriptionKey — the runtime state
   * this processor reconciles. The reduced-state mirror is
   * `state.connectionsByKey`, maintained from the presence facts this class
   * appends in `#openConnection`/`close`. Outbound connections are recreated
   * from `state.subscriptionsByKey`, inbound from a fresh subscribe().
   */
  #connections = new Map<string, Connection>();
  // subscriptionKeys with an outbound handshake in flight, so concurrent
  // reconciliation runs never dial the same subscriber twice.
  #connecting = new Set<string>();

  /**
   * Pre-append gate, called by the Durable Object before an event is committed.
   * Core-only: no other processor can reject appends.
   *
   * The pause door is deliberately dumb: any processor can append
   * `stream/paused` / `stream/resumed`, which reduce into `state.paused`, so
   * complicated policies (loop detection, circuit breakers) live in those
   * processors rather than here. Resume/error/woken/presence events pass
   * through a paused stream so it can recover. This is also where append
   * permissions will eventually live, and `stream/paused` may grow more
   * expressive (e.g. blocking only certain events from certain processors).
   */
  validateAppend(args: { event: StreamEventInput; state: CoreProcessorState }): void {
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

  // The Stream Durable Object runs this processor inline during append with
  // externally-owned state (its own KV/SQL recovery path), so the two methods
  // below take and return state explicitly instead of using the batch/
  // checkpoint lifecycle that ordinary hosted processors get from the base
  // class.

  /** Reduce one committed event against caller-owned state. */
  reduceEvent(args: { event: StreamEvent; state: CoreProcessorState }): CoreProcessorState {
    return this.reduceRawEvent(args)?.state ?? args.state;
  }

  /**
   * Run `processEvent` side effects for one already-reduced event. Inline
   * appends are synchronous, so blocking work is unavailable here — side
   * effects must use `runInBackground` and be idempotent.
   */
  processReducedEvent(args: {
    event: StreamEvent;
    previousState: CoreProcessorState;
    state: CoreProcessorState;
  }): void {
    this.processEvent({
      event: args.event as ConsumedEvent<CoreProcessorContract>,
      previousState: args.previousState,
      state: args.state,
      checkpointOffset: args.event.offset,
      streamMaxOffset: args.event.offset,
      blockProcessorWhile: () => {
        throw new Error(
          "blockProcessorWhile is unavailable when processing a reduced event inline",
        );
      },
      runInBackground: (work) => this.runInBackground(work),
    });
  }

  // Reduce is on the synchronous DO append hot path and runs per event, so it
  // does NOT re-parse the whole state on the way out: `state` was already
  // validated at the trust boundary (the KV read in stream.ts and the
  // event-log recovery path both parse), and `args.event` is validated
  // upstream, so `next` is constructed entirely from already-typed values.
  // Re-validating the growing connectionsByKey/processorsBySlug/
  // subscriptionsByKey records on every appended event was quadratic work for
  // no added safety.
  override reduce(
    args: Parameters<StreamProcessor<CoreProcessorContract>["reduce"]>[0],
  ): CoreProcessorState {
    const state = args.state;
    let next: CoreProcessorState = {
      ...state,
      eventCount: state.eventCount + 1,
      maxOffset: args.event.offset,
    };

    switch (args.event.type) {
      case "events.iterate.com/stream/paused":
        next = {
          ...next,
          paused: true,
          pauseReason: args.event.payload.reason ?? null,
        };
        break;

      case "events.iterate.com/stream/resumed":
        next = {
          ...next,
          paused: false,
          pauseReason: null,
        };
        break;

      case "events.iterate.com/stream/created":
        if (args.event.offset !== 1) {
          throw new Error(
            "events.iterate.com/stream/created must be the first event and have offset 1",
          );
        }
        next = {
          ...next,
          projectId: args.event.payload.projectId,
          path: args.event.payload.path,
          createdAt: args.event.createdAt,
        };
        break;

      case "events.iterate.com/stream/woken":
        // A new stream incarnation means every previous delivery connection
        // died with the old one. Clearing the roster here is what keeps it
        // truthful without heartbeats: surviving subscribers re-dial and their
        // fresh subscriber-connected events re-land below.
        next = {
          ...next,
          incarnationId: args.event.payload.incarnationId,
          connectionsByKey: {},
        };
        break;

      case "events.iterate.com/stream/subscriber-connected": {
        const { subscriptionKey, direction, subscriber } = args.event.payload;
        next = {
          ...next,
          connectionsByKey: {
            ...next.connectionsByKey,
            [subscriptionKey]: {
              direction,
              connectedAtOffset: args.event.offset,
              ...(subscriber === undefined ? {} : { subscriber }),
            },
          },
        };
        // A processor announcement on the connect event feeds the stream's
        // contract documentation registry (replaces processor-registered).
        const announcement = processorAnnouncementFromSubscriber(subscriber);
        if (announcement !== undefined) {
          next = {
            ...next,
            processorsBySlug: {
              ...next.processorsBySlug,
              [announcement.slug]: {
                announcedAtOffset: args.event.offset,
                announcement,
              },
            },
          };
        }
        break;
      }

      case "events.iterate.com/stream/subscriber-disconnected": {
        const { [args.event.payload.subscriptionKey]: _closed, ...connectionsByKey } =
          next.connectionsByKey;
        next = { ...next, connectionsByKey };
        break;
      }

      case "events.iterate.com/stream/configured":
        next = {
          ...next,
          config: {
            ...next.config,
            ...args.event.payload.config,
          },
        };
        break;

      case "events.iterate.com/stream/metadata-updated":
        next = {
          ...next,
          metadata: args.event.payload.metadata,
        };
        break;

      case "events.iterate.com/stream/child-stream-created": {
        const announcedPath = args.event.payload.childPath;
        let childPath: string | null;
        if (announcedPath === state.path) {
          childPath = null;
        } else if (state.path === "/") {
          const [firstSegment] = announcedPath.split("/").filter(Boolean);
          childPath = firstSegment === undefined ? null : `/${firstSegment}`;
        } else {
          const parentPrefix = `${state.path}/`;
          if (!announcedPath.startsWith(parentPrefix)) {
            childPath = null;
          } else {
            const [firstSegment] = announcedPath
              .slice(parentPrefix.length)
              .split("/")
              .filter(Boolean);
            childPath = firstSegment === undefined ? null : `${state.path}/${firstSegment}`;
          }
        }

        if (childPath !== null && !next.childPaths.includes(childPath)) {
          next = { ...next, childPaths: [...next.childPaths, childPath] };
        }
        break;
      }

      case "events.iterate.com/stream/subscription-configured":
        next = {
          ...next,
          subscriptionsByKey: {
            ...next.subscriptionsByKey,
            [args.event.payload.subscriptionKey]: {
              latestConfiguredEvent: {
                offset: args.event.offset,
                type: args.event.type,
                payload: args.event.payload,
                createdAt: args.event.createdAt,
              },
            },
          },
        };
        break;

      case "events.iterate.com/stream/subscription-removed": {
        const { [args.event.payload.subscriptionKey]: _removed, ...subscriptionsByKey } =
          next.subscriptionsByKey;
        next = { ...next, subscriptionsByKey };
        break;
      }

      default:
        break;
    }
    return next;
  }

  /**
   * Core's reconciler. Runs post-commit on the live append path only —
   * historical catch-up reduces state without re-running side effects.
   *
   * - `created`: announce this stream to every ancestor (idempotency-keyed).
   * - `woken`: a fresh stream incarnation has no connections; restore the
   *   outbound ones the reduced state says should exist. This replaces the
   *   old constructor-time reconcile call — boot recovery is now just an
   *   ordinary consequence of the woken fact.
   * - `subscription-configured`: the desired connection set changed.
   */
  protected override processEvent(
    args: Parameters<StreamProcessor<CoreProcessorContract>["processEvent"]>[0],
  ): undefined {
    switch (args.event.type) {
      case "events.iterate.com/stream/woken":
      case "events.iterate.com/stream/subscription-configured":
      case "events.iterate.com/stream/subscription-removed":
        this.reconcileConnections();
        return;
      case "events.iterate.com/stream/created":
        this.#announceToAncestors(args);
        return;
      default:
        return;
    }
  }

  #announceToAncestors(
    args: Parameters<StreamProcessor<CoreProcessorContract>["processEvent"]>[0],
  ): void {
    if (args.state.path === "/") return;

    const pathSegments = args.state.path.split("/").filter(Boolean);
    const ancestorPaths = ["/"];
    for (let index = 1; index < pathSegments.length; index += 1) {
      ancestorPaths.push(`/${pathSegments.slice(0, index).join("/")}`);
    }

    const path = args.state.path;
    args.runInBackground(async () => {
      await Promise.all(
        ancestorPaths.map((ancestorPath) =>
          this.ctx.stream.append({
            streamPath: ancestorPath,
            event: {
              type: "events.iterate.com/stream/child-stream-created",
              idempotencyKey: `child-stream-created:${ancestorPath}:${path}`,
              payload: { childPath: path },
            },
          }),
        ),
      );
    });
  }

  // ---------------------------------------------------------------------------
  // Connection runtime state. The Stream DO delegates subscribe/subscribeOutbound
  // here and calls wakeConnections() after each commit.
  // ---------------------------------------------------------------------------

  /** Re-arm every live connection's delivery pump after a commit. */
  wakeConnections(): void {
    for (const connection of this.#connections.values()) connection.wake();
  }

  /** True if any live connection delivers outbound into a subscriber DO. */
  hasLiveOutboundConnections(): boolean {
    for (const connection of this.#connections.values()) {
      if (connection.direction === "outbound") return true;
    }
    return false;
  }

  /**
   * Deliberately drops every live OUTBOUND delivery connection so a quiet stream
   * stops pinning subscriber DOs (and, via the hibernation cascade, itself) with
   * idle cross-isolate RPC sessions. Disposes each retained callback stub
   * (`connection.close` → `processEventBatch[Symbol.dispose]`) and appends a
   * `subscriber-disconnected("idle")` fact. The durable `subscriptionsByKey`
   * config is untouched, so the next append (`needsOutboundReconcile`) or a wake
   * re-dials the subscriber, which re-handshakes from its durable checkpoint and
   * replays anything the cursor advanced past. Returns the severed keys.
   */
  closeIdleOutboundConnections(): string[] {
    const severed: string[] = [];
    // Snapshot first: close() mutates #connections.
    for (const [subscriptionKey, connection] of [...this.#connections]) {
      if (connection.direction !== "outbound") continue;
      severed.push(subscriptionKey);
      connection.close("idle");
    }
    return severed;
  }

  /**
   * True if a configured outbound subscription currently has no live or
   * in-flight connection — i.e. one was severed (idle teardown here or on the
   * subscriber, a clean unsubscribe, etc.) and needs re-dialing. Cheap
   * O(subscriptions) scan; a no-op in steady state when everything is connected.
   */
  needsOutboundReconcile(): boolean {
    const state = this.#currentState();
    for (const subscriptionKey of Object.keys(state.subscriptionsByKey)) {
      if (!this.#connections.has(subscriptionKey) && !this.#connecting.has(subscriptionKey)) {
        return true;
      }
    }
    return false;
  }

  /** Serializable debug view of the live connections, for runtimeState(). */
  connectionsRuntimeState(): Record<
    string,
    {
      direction: "inbound" | "outbound";
      startedAt: string;
      cursor: number;
      batchesSent: number;
      eventsSent: number;
      lastDeliveredAt?: string;
    }
  > {
    return Object.fromEntries(
      [...this.#connections].map(([subscriptionKey, connection]) => [
        subscriptionKey,
        {
          direction: connection.direction,
          startedAt: connection.startedAt,
          cursor: connection.cursor,
          batchesSent: connection.batchesSent,
          eventsSent: connection.eventsSent,
          lastDeliveredAt: connection.lastDeliveredAt,
        },
      ]),
    );
  }

  async getProcessorRuntimeState(args: {
    subscriptionKey: string;
  }): Promise<ProcessorRuntimeState | null> {
    const connection = this.#connections.get(args.subscriptionKey);
    return (await connection?.getProcessorRuntimeState?.()) ?? null;
  }

  /** Fire-and-forget outbound reconciliation; never blocks the append path. */
  reconcileConnections(): void {
    try {
      this.#reconcileOutboundConnections();
    } catch (error) {
      console.error("Stream outbound reconciliation failed", error);
    }
  }

  /**
   * Makes runtime outbound connections match the persisted subscription config:
   * closes connections whose config disappeared, dials a subscriber for each
   * configured subscription that has none. Triggered by the woken and
   * subscription-configured facts (see `processEvent`) and on outbound
   * connection loss — never per-append.
   */
  #reconcileOutboundConnections(): void {
    const state = this.#currentState();
    for (const [subscriptionKey, connection] of this.#connections) {
      if (
        connection.direction === "outbound" &&
        state.subscriptionsByKey[subscriptionKey] === undefined
      ) {
        connection.close("subscription-removed");
      }
    }

    for (const [subscriptionKey, configured] of Object.entries(state.subscriptionsByKey)) {
      if (this.#connections.has(subscriptionKey) || this.#connecting.has(subscriptionKey)) continue;

      // Reserve the key before any await so a concurrent reconcile can't dial twice.
      this.#connecting.add(subscriptionKey);
      this.runInBackground(async () => {
        try {
          await this.#requireDep("dial")({ configured, subscriptionKey });
        } catch (error) {
          console.error("Stream outbound connection failed", { error, subscriptionKey });
        } finally {
          this.#connecting.delete(subscriptionKey);
        }
      });
    }
  }

  /**
   * Opens (or replaces) a live delivery connection for one subscriptionKey,
   * appending the subscriber-connected presence fact that mirrors it into
   * reduced state. The append happens after the connection is registered and
   * after the replay cursor is fixed, so the connected event's offset exceeds
   * every replayed event — it is always the tail of any batch it shares,
   * which is what makes per-event reconciliation checks in subscribers safe.
   *
   * A connection is just a pump: it delivers everything after `cursor` in offset
   * order, then parks. There is no catch-up-vs-live distinction — replay and live
   * are the same `getEvents(afterOffset: cursor)` loop. The Stream DO re-arms the
   * pump after each commit via `wakeConnections()`; the `draining` guard makes
   * that idempotent and race-free.
   *
   * What actually happens (stream has offsets 1..3, subscribe with `replayAfterOffset: 0`):
   * - open: `cursor = 0`, `wake()` -> pump reads `(>0)` -> delivers `[1, 2, 3]`,
   *   `cursor = 3` → reads `(>3)` → empty → parks.
   * - append offset 4 → `wake()` → pump reads `(>3)` → delivers `[4]`, `cursor = 4`
   *   → empty → parks. One batch per append while the subscriber keeps up.
   *
   * The `draining` guard is what removes the old catch-up/live race. If an append's
   * `wake()` lands while a slow pump is still mid-drain, it early-returns; the
   * in-flight loop's next `getEvents` sees the just-committed rows (commit happens
   * before `wake()`), so the event is delivered exactly once — never dropped, never
   * doubled, no matter the interleaving. A backlog (subscriber fell behind, or first
   * replay of 10k events) drains 100 at a time, yielding between batches so other
   * connections and incoming appends still make progress.
   *
   * Two protocol additions ride the same pump:
   * - Every batch carries `state` (the core reduced state, read at delivery
   *   time alongside `streamMaxOffset` — the two always correspond).
   * - The first drain always delivers at least one batch (the "initial push"):
   *   if replay produced events, that batch is it; otherwise an `events: []`
   *   batch with the current state goes out, so even a live-only subscription
   *   hears something immediately instead of waiting for the next append.
   *
   * `events: false` (state-only) keeps the cursor at the state's maxOffset
   * and sends one `events: []` batch per drain — consecutive appends a slow
   * subscriber missed coalesce into a single state delivery.
   */
  openConnection(args: {
    direction: "inbound" | "outbound";
    subscriptionKey: string;
    processEventBatch: ProcessEventBatch;
    replayAfterOffset?: number;
    eventTypes?: readonly string[];
    /** `false` = state-only batches. Default `true`. */
    events?: boolean;
    subscriber?: LiveStreamSubscriberDescriptor;
    onClose?: () => void;
  }): { subscriptionKey: string; streamMaxOffset: number; unsubscribe(): void } {
    const subscriptionKey = args.subscriptionKey.trim();
    if (subscriptionKey.length === 0) throw new Error("subscriptionKey must not be blank.");
    const getEvents = this.#requireDep("getEvents");

    // Replacing any existing connection for this key.
    this.#connections.get(subscriptionKey)?.close("replaced");

    // Optional event-type filter (processor hosts pass their contract's
    // `consumes`). The cursor still advances past non-matching events — they
    // are skipped, not deferred — so a subscriber's resume offset can sit on a
    // filtered-out event without ever re-delivering it.
    const eventTypeFilter =
      args.eventTypes === undefined || args.eventTypes.includes("*")
        ? undefined
        : new Set(args.eventTypes);

    const deliverEvents = args.events !== false;
    // State-only subscriptions are implicitly live-from-now: replay without
    // events is meaningless, so replayAfterOffset is ignored in that mode.
    let cursor = deliverEvents
      ? (args.replayAfterOffset ?? this.#currentState().maxOffset)
      : this.#currentState().maxOffset;
    // The initial push: the first drain must deliver at least one batch so a
    // subscriber paints its first render from `state` without waiting for an
    // append. Cleared by whichever batch goes out first.
    let initialBatchPending = true;
    let draining = false;
    let open = true;

    // Workers RPC disposes parameter stubs when an RPC method returns unless the
    // callee duplicates them. Keep a retained callback because this stream calls
    // it later from the pump, after subscribe() has returned:
    // https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/
    // Outbound connections (native Workers RPC into a subscriber host DO)
    // observe each delivery's result: a rejected delivery means the stub is
    // dead (callee evicted/redeployed/aborted), so drop the connection and
    // re-dial — the subscriber re-handshakes from its durable checkpoint and
    // replay covers whatever the cursor already advanced past. Without this a
    // dead stub stayed in the connection map for the rest of the incarnation
    // and reconciliation skipped its key, stalling delivery forever.
    //
    // Inbound connections (capnweb via the fronting worker) deliberately do
    // NOT observe results: pulling them would make every browser tab send a
    // resolve frame per batch, and their liveness is already covered by
    // onRpcBroken on the terminated socket.
    const processEventBatch = retainProcessEventBatch(
      args.processEventBatch,
      args.direction === "outbound"
        ? {
            onDeliveryError: (error) => {
              if (!open) return;
              console.error("Stream event batch delivery failed; dropping connection for re-dial", {
                subscriptionKey,
                direction: args.direction,
                error,
              });
              connection.close("delivery-failed");
              this.reconcileConnections();
            },
          }
        : {},
    );

    const pump = async () => {
      if (draining) return;
      draining = true;
      try {
        while (open) {
          let events: StreamEvent[] = [];
          if (deliverEvents) {
            const readEvents = getEvents({ afterOffset: cursor, limit: 100 }); // limit hardcoded for now
            const lastOffset = readEvents.at(-1)?.offset;
            if (lastOffset === undefined) {
              // Caught up; the next append wakes us again. The first drain
              // still owes the initial state batch — fall through to send it.
              if (!initialBatchPending) return;
            } else {
              cursor = lastOffset;
              events =
                eventTypeFilter === undefined
                  ? readEvents
                  : readEvents.filter((event) => eventTypeFilter.has(event.type));
              // Whole batch filtered out; keep draining (unless the initial
              // push is still owed, in which case this delivery doubles as it).
              if (events.length === 0 && !initialBatchPending) continue;
            }
          } else {
            // State-only: one `events: []` batch per state advance. Reading
            // maxOffset and parking on it coalesces appends a slow subscriber
            // missed into a single delivery of the latest state.
            const stateMaxOffset = this.#currentState().maxOffset;
            if (stateMaxOffset <= cursor && !initialBatchPending) return;
            cursor = stateMaxOffset;
          }
          initialBatchPending = false;
          connection.batchesSent += 1;
          connection.eventsSent += events.length;
          connection.lastDeliveredAt = new Date().toISOString();
          // Batch-first, fire-and-forget: never await the remote result. Both
          // Workers RPC and Cap'n Web return disposable thenables for remote calls;
          // dispose ignored results so we do not retain return capabilities.
          // https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/
          // https://github.com/cloudflare/capnweb#memory-management
          const currentState = this.#currentState();
          const pendingBatch = processEventBatch({
            projectId: currentState.projectId,
            path: currentState.path,
            events,
            streamMaxOffset: currentState.maxOffset,
            // Read in the same synchronous block as streamMaxOffset, so the
            // two always correspond (state-at-streamMaxOffset; see types.ts).
            state: currentState,
          });
          disposeIgnoredRpcResult(pendingBatch);
          await Promise.resolve();
        }
      } finally {
        draining = false;
      }
    };

    const connection: Connection = {
      direction: args.direction,
      startedAt: new Date().toISOString(),
      getProcessorRuntimeState: retainGetProcessorRuntimeState(
        args.subscriber?.processor?.getRuntimeState,
      ),
      get cursor() {
        return cursor;
      },
      batchesSent: 0,
      eventsSent: 0,
      wake: () => void pump(),
      close: (reason) => {
        if (!open) return;
        open = false;
        if (this.#connections.get(subscriptionKey) === connection) {
          this.#connections.delete(subscriptionKey);
        }
        processEventBatch[Symbol.dispose]();
        connection.getProcessorRuntimeState?.[Symbol.dispose]();
        this.#appendPresenceFact({
          type: "events.iterate.com/stream/subscriber-disconnected",
          payload: { subscriptionKey, reason },
        });
        args.onClose?.();
      },
    };

    this.#connections.set(subscriptionKey, connection);
    // The presence fact lands after the connection is registered (so an inline
    // reconcile triggered mid-append sees it as connected) and after `cursor`
    // is fixed (so the connected event itself gets delivered to the new
    // subscriber as the tail of its first batch).
    this.#appendPresenceFact({
      type: "events.iterate.com/stream/subscriber-connected",
      payload: {
        subscriptionKey,
        direction: args.direction,
        ...(args.subscriber === undefined
          ? {}
          : { subscriber: serializableSubscriber(args.subscriber) }),
      },
    });
    processEventBatch.onRpcBroken?.(() => {
      connection.close("rpc-broken");
      if (args.direction === "outbound") this.reconcileConnections();
    });
    connection.wake();

    return {
      subscriptionKey,
      streamMaxOffset: this.#currentState().maxOffset,
      unsubscribe: () => connection.close("unsubscribed"),
    };
  }

  /**
   * Presence facts are observations appended exactly once per actual
   * open/close, so they carry no idempotency keys. Close paths run during
   * teardown (broken RPC sessions, dying instances) where an append can fail —
   * that must never mask the close itself, so failures are logged, not thrown.
   */
  #appendPresenceFact(event: StreamEventInput): void {
    try {
      void this.ctx.stream.append({ event });
    } catch (error) {
      console.error("stream presence fact append failed", { type: event.type, error });
    }
  }

  #currentState(): CoreProcessorState {
    return this.#requireDep("currentState")();
  }

  #requireDep<Name extends keyof CoreProcessorDeps>(
    name: Name,
  ): NonNullable<CoreProcessorDeps[Name]> {
    const dep = this.deps[name];
    if (dep === undefined) {
      throw new Error(
        `CoreStreamProcessor connection management requires the "${name}" dep; this instance was constructed for reduce-only use`,
      );
    }
    return dep;
  }
}

/**
 * A live delivery connection from this stream to one subscriber callback. Not persisted;
 * the callback and pump state live in the `openConnection` closure, so this is just the
 * metrics counters plus the two control verbs.
 */
type Connection = {
  readonly direction: "inbound" | "outbound";
  readonly startedAt: string;
  /** Highest offset delivered to the callback; also the pump's resume cursor. */
  readonly cursor: number;
  batchesSent: number;
  eventsSent: number;
  lastDeliveredAt?: string;
  getProcessorRuntimeState?: (() => ProcessorRuntimeState | Promise<ProcessorRuntimeState>) &
    Disposable;
  /** Re-arm the delivery pump after events are committed. Idempotent while draining. */
  wake(): void;
  /** Stop the pump, dispose the callback, append the disconnect fact, drop from the map. Idempotent. */
  close(reason: StreamSubscriberDisconnectReason): void;
};

function serializableSubscriber(
  subscriber: LiveStreamSubscriberDescriptor,
): StreamSubscriberDescriptor {
  const processor =
    subscriber.processor === undefined
      ? undefined
      : { announcement: subscriber.processor.announcement };
  return {
    ...(subscriber.incarnationId === undefined ? {} : { incarnationId: subscriber.incarnationId }),
    ...(subscriber.description === undefined ? {} : { description: subscriber.description }),
    ...(processor === undefined ? {} : { processor }),
  };
}

function processorAnnouncementFromSubscriber(
  subscriber: StreamSubscriberDescriptor | undefined,
): ProcessorContractAnnouncement | undefined {
  const processor = subscriber?.processor;
  if (processor === undefined) return undefined;
  const candidate =
    isRecord(processor) && isRecord(processor.announcement) ? processor.announcement : processor;
  const parsed = ProcessorContractAnnouncementSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
