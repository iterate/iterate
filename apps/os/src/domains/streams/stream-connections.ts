// Live delivery connections for one Stream Durable Object.
//
// A connection is the stream's half of a live-capability handshake — the same
// shape as an itx live capability (see `domains/capability-host/live-capability.ts`): the
// subscriber hands the stream a live `processEventBatch` callback, the stream
// duplicates and retains that stub past the RPC call that delivered it, invokes
// it for every committed batch, and disposes it on close. Connections are
// incarnation-local runtime state; their durable mirror is the core reduced
// state's presence roster (`connectionsByKey`), fed by the presence facts this
// module asks the stream to append.
//
// This module owns the connection table, the per-connection delivery pump, RPC
// stub retention/disposal, and the idle teardown timer. Policy — which
// subscribers to wake, what a lost configured connection means — stays in the
// Stream Durable Object, reached through the constructor hooks.

import type {
  GetProcessorRuntimeState,
  ProcessEventBatch,
  ProcessorRuntimeState,
  StreamEvent,
} from "../../types.ts";
import type {
  CoreProcessorState,
  StreamSubscriberDescriptor,
  StreamSubscriberDisconnectReason,
  StreamSubscriptionType,
} from "./core-processor-contract.ts";
import { disposeIgnoredRpcResult, isThenable } from "./stream-processor.ts";

/** Serializable debug view of one live connection, for `runtimeState()`. */
export type ConnectionRuntimeState = {
  subscriptionType: StreamSubscriptionType;
  startedAt: string;
  cursor: number;
  batchesSent: number;
  eventsSent: number;
  lastDeliveredAt?: string;
};

/**
 * A live delivery connection from the stream to one subscriber callback. Not
 * persisted; the callback and pump state live in the `open()` closure, so this
 * is just metrics counters plus two control verbs.
 */
type Connection = {
  readonly subscriptionType: StreamSubscriptionType;
  readonly startedAt: string;
  /** Highest offset delivered to the callback; also the pump's resume cursor. */
  readonly cursor: number;
  batchesSent: number;
  eventsSent: number;
  lastDeliveredAt?: string;
  getProcessorRuntimeState?: GetProcessorRuntimeState & Disposable;
  /** Re-arm the delivery pump after events are committed. Idempotent while draining. */
  wake(): void;
  /** `true` until close() runs — backs the subscription handle's `ping()`. */
  isLive(): boolean;
  /** Stop the pump, dispose the callback, append the disconnect fact, drop from the table. */
  close(reason: StreamSubscriberDisconnectReason): void;
};

/** Everything `StreamConnections.open` needs to start one delivery connection. */
type OpenConnectionArgs = {
  subscriptionKey: string;
  subscriptionType: StreamSubscriptionType;
  processEventBatch: ProcessEventBatch;
  replayAfterOffset?: number;
  eventTypes?: readonly string[];
  /** `false` = state-only batches. Default `true`. */
  events?: boolean;
  /** Validated serializable identity, appended as the connected presence fact. */
  presence?: StreamSubscriberDescriptor;
  /** Live processor runtime-state capability, retained for the connection lifetime. */
  getRuntimeState?: GetProcessorRuntimeState;
};

/** The policy/storage seams the owning Stream Durable Object provides. */
type StreamConnectionsHooks = {
  /** Synchronous committed-event range read from stream storage. */
  readEvents(args: { afterOffset: number; limit: number }): StreamEvent[];
  /** Current core reduced state, read in the same synchronous block as each delivery. */
  coreState(): CoreProcessorState;
  /** Append a subscriber-connected presence fact. Must not throw. */
  appendConnectedFact(args: {
    subscriptionKey: string;
    subscriptionType: StreamSubscriptionType;
    subscriber?: StreamSubscriberDescriptor;
  }): void;
  /** Append a subscriber-disconnected presence fact. Must not throw. */
  appendDisconnectedFact(args: {
    subscriptionKey: string;
    reason: StreamSubscriberDisconnectReason;
  }): void;
  /** A configured connection died unexpectedly; the stream may re-wake its subscriber. */
  onConfiguredConnectionLost(): void;
};

export class StreamConnections {
  readonly #hooks: StreamConnectionsHooks;
  /**
   * How long the stream may hold idle configured delivery connections before
   * severing them so it (and its subscribers) can hibernate instead of accruing
   * billable duration on cross-isolate RPC sessions that pin both DOs. Tracked
   * with an in-memory timer (NOT a DO alarm): the retained stubs we tear down
   * are in-memory and die on eviction anyway, the DO is always resident while it
   * holds them (so the timer is guaranteed to fire), and a durable alarm's only
   * extra power — waking a hibernated DO — is exactly what we must never do.
   */
  readonly #idleTeardownMs: number;
  readonly #connections = new Map<string, Connection>();
  #idleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(args: { idleTeardownMs: number; hooks: StreamConnectionsHooks }) {
    this.#hooks = args.hooks;
    this.#idleTeardownMs = args.idleTeardownMs;
  }

  /**
   * Registers a live connection and starts delivery: catch-up replay from the
   * requested cursor, then live batches after every commit. Every subscription —
   * with or without replay — immediately receives one batch on open so the
   * subscriber can paint its first render without a separate getState call.
   *
   * Ordering matters and is preserved by this method: the connection is
   * registered first, then the connected presence fact is appended (whose
   * commit wakes this very pump, so the connected fact rides the tail of any
   * first batch it shares with replayed events), then transport-broken
   * signals are wired, then the pump is woken explicitly.
   */
  open(args: OpenConnectionArgs): Connection {
    const { subscriptionKey, subscriptionType } = args;

    // Replacing any existing connection for this key.
    this.#connections.get(subscriptionKey)?.close("replaced");

    // Optional event-type filter. The cursor still advances past non-matching
    // events; they are skipped, not deferred.
    const eventTypeFilter =
      args.eventTypes === undefined || args.eventTypes.includes("*")
        ? undefined
        : new Set(args.eventTypes);

    const deliverEvents = args.events !== false;
    // State-only subscriptions are implicitly live-from-now: replay without
    // events is meaningless, so replayAfterOffset is ignored in that mode.
    let cursor = deliverEvents
      ? (args.replayAfterOffset ?? this.#hooks.coreState().maxOffset)
      : this.#hooks.coreState().maxOffset;
    let initialBatchPending = true;
    let draining = false;
    let open = true;

    const processEventBatch = retainProcessEventBatch(
      args.processEventBatch,
      subscriptionType === "configured"
        ? {
            onDeliveryError: (error) => {
              if (!open) return;
              console.error("Stream event batch delivery failed; dropping connection for re-wake", {
                subscriptionKey,
                subscriptionType,
                error,
              });
              connection.close("delivery-failed");
              this.#hooks.onConfiguredConnectionLost();
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
            const readEvents = this.#hooks.readEvents({ afterOffset: cursor, limit: 100 });
            const lastOffset = readEvents.at(-1)?.offset;
            if (lastOffset === undefined) {
              // Caught up; the next append wakes us again. The first drain
              // still owes the initial state batch.
              if (!initialBatchPending) return;
            } else {
              cursor = lastOffset;
              events =
                eventTypeFilter === undefined
                  ? readEvents
                  : readEvents.filter((event) => eventTypeFilter.has(event.type));
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
          processEventBatch({
            projectId: currentState.projectId,
            path: currentState.path,
            events,
            streamMaxOffset: currentState.maxOffset,
            // Read in the same synchronous block as streamMaxOffset, so the
            // two always correspond (state-at-streamMaxOffset; see types.ts).
            state: currentState,
          });
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
        processEventBatch[Symbol.dispose]();
        connection.getProcessorRuntimeState?.[Symbol.dispose]();
        this.#hooks.appendDisconnectedFact({ subscriptionKey, reason });
      },
    };

    this.#connections.set(subscriptionKey, connection);
    this.#hooks.appendConnectedFact({
      subscriptionKey,
      subscriptionType,
      ...(args.presence === undefined ? {} : { subscriber: args.presence }),
    });
    processEventBatch.onRpcBroken?.(() => {
      connection.close("rpc-broken");
      if (subscriptionType === "configured") this.#hooks.onConfiguredConnectionLost();
    });
    connection.wake();

    return connection;
  }

  /** Re-arm every live connection's delivery pump after a commit. */
  wake(): void {
    for (const connection of this.#connections.values()) connection.wake();
  }

  close(subscriptionKey: string, reason: StreamSubscriberDisconnectReason): void {
    this.#connections.get(subscriptionKey)?.close(reason);
  }

  /** True if this key currently has a live configured delivery connection. */
  hasConfigured(subscriptionKey: string): boolean {
    return this.#connections.get(subscriptionKey)?.subscriptionType === "configured";
  }

  /** Snapshot of subscriptionKeys with a live configured connection. */
  configuredKeys(): string[] {
    return [...this.#connections]
      .filter(([, connection]) => connection.subscriptionType === "configured")
      .map(([subscriptionKey]) => subscriptionKey);
  }

  async getProcessorRuntimeState(subscriptionKey: string): Promise<ProcessorRuntimeState | null> {
    const connection = this.#connections.get(subscriptionKey);
    return (await connection?.getProcessorRuntimeState?.()) ?? null;
  }

  runtimeState(): Record<string, ConnectionRuntimeState> {
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

  // Keep the in-memory idle timer armed only while configured delivery
  // connections exist (the thing that pins the DO resident). Reset on every
  // append; cleared once no configured connection remains. No storage writes,
  // and nothing scheduled against a hibernated DO.
  armOrClearIdleTimer(): void {
    if (this.#idleTimer !== undefined) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = undefined;
    }
    if (this.configuredKeys().length === 0) return;
    this.#idleTimer = setTimeout(() => this.runIdleTeardownNow(), this.#idleTeardownMs);
  }

  /**
   * Deliberately drops every live configured delivery connection so a quiet
   * stream stops pinning subscriber DOs with idle cross-isolate RPC sessions.
   * The durable subscription config is kept, so the next append re-wakes.
   * The idle timer's action, also exposed for tests / operator use.
   */
  runIdleTeardownNow(): void {
    this.#idleTimer = undefined;
    // Snapshot first: close() mutates the connection table.
    for (const subscriptionKey of this.configuredKeys()) this.close(subscriptionKey, "idle");
  }
}

// =============================================================================
// RPC callback retention.
//
// Retaining means duplicating a callback stub when the transport exposes
// `.dup()`. Required whenever this isolate keeps any relationship to the
// callback after the RPC method that received it returns — exactly what the
// connection table above does. Transparent forwarding layers must NOT retain:
// Workers RPC duplicates stubs in call parameters as of the 2026-01-20
// `rpc_params_dup_stubs` compatibility change, matching Cap'n Web's ownership
// model. Any duplicate retained past the receiving call must later be disposed:
// https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/#stubs-received-as-parameters-in-an-rpc-call
// https://github.com/cloudflare/capnweb#resource-management-and-disposal
// =============================================================================

/** An RPC callback after retention: callable, disposable, with optional broken-transport signal. */
type RetainedRpcCallback<T extends (...args: any[]) => unknown> = T &
  Partial<Disposable> & {
    onRpcBroken?(callback: (error: unknown) => void): void;
  };

/** The pump-facing delivery callback: fire-and-forget, disposable, broken-transport aware. */
type RetainedProcessEventBatch = ((batch: Parameters<ProcessEventBatch>[0]) => void) &
  Disposable & {
    onRpcBroken?(callback: (error: unknown) => void): void;
  };

function retainRpcCallback<T extends (...args: any[]) => unknown>(
  callback: T,
): RetainedRpcCallback<T> {
  const retainable = callback as T & Partial<Disposable> & { dup?(): RetainedRpcCallback<T> };
  return retainable.dup?.() ?? retainable;
}

function retainProcessEventBatch(
  processEventBatch: ProcessEventBatch,
  opts: {
    /**
     * Observes a rejected batch delivery for configured subscriber connections.
     * Both Workers RPC and Cap'n Web reject the call result when the remote stub
     * is broken, so this is how a stream notices a dead DO-to-DO connection even
     * when `onRpcBroken` is unavailable. Ephemeral browser/client subscriptions do
     * not pass this option: observing every delivery result would add a resolve
     * frame per batch, so those connections rely on explicit unsubscribe and the
     * transport's best-effort `onRpcBroken` signal.
     */
    onDeliveryError?: (error: unknown) => void;
  } = {},
): RetainedProcessEventBatch {
  const retained = retainRpcCallback(processEventBatch);
  const dispose = retained[Symbol.dispose]?.bind(retained);
  const onDeliveryError = opts.onDeliveryError;
  const callback: RetainedProcessEventBatch = Object.assign(
    (batch: Parameters<ProcessEventBatch>[0]) => {
      let result: unknown;
      try {
        result = retained(batch);
      } catch (error) {
        // A disposed/broken stub can throw synchronously at call time.
        onDeliveryError?.(error);
        return;
      }
      if (onDeliveryError !== undefined && isThenable(result)) {
        // Delivery stays fire-and-forget (the pump never awaits the remote
        // result), but the rejection must be observed: a dead stub rejects
        // every call, and swallowing that left broken connections in place
        // forever. Dispose only after settle; disposing before the result is
        // pulled opts out of observing the rejection signal this path needs.
        void Promise.resolve(result)
          .then(undefined, (error: unknown) => onDeliveryError(error))
          .finally(() => disposeIgnoredRpcResult(result));
        return;
      }
      disposeIgnoredRpcResult(result);
    },
    {
      [Symbol.dispose]() {
        dispose?.();
      },
    },
  );
  // Cap'n Web stubs intercept `onRpcBroken` locally but expose no own property
  // descriptors, so an `Object.hasOwn` guard never wires it. `typeof` is also
  // unreliable in the other direction: property access on a Workers RPC stub
  // can fabricate a pipelined method that rejects at call time. Wire whatever
  // the stub claims to have, defensively. For configured subscribers, the
  // onDeliveryError path still observes broken stubs even if this registration
  // was only a pipelined fake.
  const onRpcBroken = retained.onRpcBroken;
  if (typeof onRpcBroken === "function") {
    callback.onRpcBroken = (brokenCallback: (error: unknown) => void) => {
      try {
        const result = onRpcBroken.call(retained, brokenCallback) as unknown;
        if (isThenable(result)) {
          void Promise.resolve(result).catch(() => {
            // Pipelined fake: the remote has no onRpcBroken method.
          });
        }
      } catch {
        // Same: registration is best-effort.
      }
    };
  }
  return callback;
}

function retainGetProcessorRuntimeState(
  getRuntimeState: GetProcessorRuntimeState | undefined,
): (GetProcessorRuntimeState & Disposable) | undefined {
  if (getRuntimeState === undefined) return undefined;
  const retained = retainRpcCallback(getRuntimeState);
  const dispose = retained[Symbol.dispose]?.bind(retained);
  return Object.assign(
    () => {
      const result = retained();
      if (isThenable(result)) {
        return Promise.resolve(result).finally(() => disposeIgnoredRpcResult(result));
      }
      disposeIgnoredRpcResult(result);
      return result;
    },
    {
      [Symbol.dispose]() {
        dispose?.();
      },
    },
  );
}
