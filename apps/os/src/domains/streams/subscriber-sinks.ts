// RPC stub retention for stream delivery sinks — the ONLY streams file that
// knows transports exist.
//
// A sink is the live callback the stream invokes to deliver batches. It
// arrives in one of two ways: an ephemeral subscriber passes it as a
// `subscribe()` PARAMETER, and a durable subscriber RETURNS it from the
// `wakeStreamSubscriber` poke. Either way the stream keeps a relationship to
// the callback after the RPC method that carried it returns, which is exactly
// what "retaining" means: duplicate the stub when the transport exposes
// `.dup()`, dispose the duplicate on close.
//
// Ownership rules differ by direction, and this module is where that
// knowledge is quarantined:
// - Parameters: Workers RPC duplicates stubs in call parameters as of the
//   2026-01-20 `rpc_params_dup_stubs` compatibility change, matching Cap'n
//   Web's ownership model — so we dup defensively and dispose our duplicate.
//   https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/#stubs-received-as-parameters-in-an-rpc-call
//   https://github.com/cloudflare/capnweb#resource-management-and-disposal
// - Return values: ownership transfers to the caller (us). We retain what the
//   poke returned and are responsible for disposing it.
//
// Delivery is fire-and-forget by design (the pump never awaits a batch); the
// asymmetry between ephemeral and durable subscribers is WHO PULLS THE RESULT:
// ephemeral batch results are disposed unpulled — zero subscriber-originated
// return frames on the wire — while durable batch results are pulled (never
// awaited) purely as the prompt dead-connection signal. See
// `retainProcessEventBatch` below and the wire tests in
// stream-wire.e2e.test.ts.

import { evaluateItxExpression, type ItxExpression } from "../../itx/expression.ts";
import { disposeIgnoredRpcResult, isThenable } from "../../lib/rpc/retain.ts";
import { itxLoopbackStub } from "../itx/utils.ts";
import { projectEgressFetcher } from "../projects/utils.ts";
import type {
  GetProcessorRuntimeState,
  ProcessEventBatch,
  StreamPushEventBatch,
  StreamSubscriberWakeRequest,
  StreamSubscriberWakeResponse,
  StreamWebhookDelivery,
} from "./rpc-types.ts";
import type { SubscriberDial } from "./stream-subscribers.ts";

/** An RPC callback after retention: callable, disposable, with optional broken-transport signal. */
type RetainedRpcCallback<T extends (...args: any[]) => unknown> = T &
  Partial<Disposable> & {
    onRpcBroken?(callback: (error: unknown) => void): void;
  };

/** The pump-facing delivery callback: fire-and-forget, disposable, broken-transport aware. */
export type RetainedProcessEventBatch = ((batch: Parameters<ProcessEventBatch>[0]) => void) &
  Disposable & {
    onRpcBroken?(callback: (error: unknown) => void): void;
    /**
     * Dispatched-but-unsettled deliveries (durable lane only, where results
     * are pulled). Idle teardown consults this: a sink with an unsettled
     * batch belongs to a wedged subscriber, and its watermark must not be
     * advanced as if the batch were digested.
     */
    pendingDeliveries?(): number;
  };

function retainRpcCallback<T extends (...args: any[]) => unknown>(
  callback: T,
): RetainedRpcCallback<T> {
  const retainable = callback as T & Partial<Disposable> & { dup?(): RetainedRpcCallback<T> };
  return retainable.dup?.() ?? retainable;
}

/**
 * Retains a delivery sink and wraps it in the pump's fire-and-forget calling
 * convention.
 *
 * Without `onDeliveryError` (ephemeral subscribers) the batch result is
 * disposed WITHOUT ever being pulled, so the remote never ships a resolution —
 * frames flow in one direction only. With it (durable subscribers) the result
 * is pulled — never awaited, never gating the pump — because a dead stub
 * rejects every call, and observing that rejection is the only reliable,
 * PROMPT "this connection is a corpse" signal (`onRpcBroken` is best-effort
 * and can be a pipelined fake). One resolve frame per batch is the price of
 * millisecond-grade dead-connection detection on the lane voice rides.
 */
export function retainProcessEventBatch(
  processEventBatch: ProcessEventBatch,
  opts: {
    onDeliveryError?: (error: unknown) => void;
    /**
     * Runs after the retained stub is disposed — the hook that lets a caller
     * tie OTHER stubs' lifetimes to this sink's (the wake dial parks the
     * loopback chain that carried the sink here, so the chain outlives every
     * batch call but not the connection).
     */
    onDisposed?: () => void;
  } = {},
): RetainedProcessEventBatch {
  const retained = retainRpcCallback(processEventBatch);
  const dispose = retained[Symbol.dispose]?.bind(retained);
  const onDeliveryError = opts.onDeliveryError;
  let pendingDeliveries = 0;
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
        pendingDeliveries += 1;
        void Promise.resolve(result)
          .then(undefined, (error: unknown) => onDeliveryError(error))
          .finally(() => {
            pendingDeliveries -= 1;
            disposeIgnoredRpcResult(result);
          });
        return;
      }
      disposeIgnoredRpcResult(result);
    },
    {
      pendingDeliveries: () => pendingDeliveries,
      [Symbol.dispose]() {
        try {
          dispose?.();
        } finally {
          opts.onDisposed?.();
        }
      },
    },
  );
  // Cap'n Web stubs intercept `onRpcBroken` locally but expose no own property
  // descriptors, so an `Object.hasOwn` guard never wires it. `typeof` is also
  // unreliable in the other direction: property access on a Workers RPC stub
  // can fabricate a pipelined method that rejects at call time. Wire whatever
  // the stub claims to have, defensively. For durable subscribers, the
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

/** Retains a hosted processor's live runtime-state capability for the connection lifetime. */
export function retainGetProcessorRuntimeState(
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

// =============================================================================
// The dial: how the spine reaches subscribers over real transports.
// =============================================================================

/**
 * Builds the spine's {@link SubscriberDial}. Wake and push share ONE lane: the
 * persisted itx expression is evaluated against the stream's authority root —
 * the itx loopback that mints the project-scoped root every dynamic worker
 * sees as `env.ITX`, or the trusted deployment root for a global
 * (`projectId: null`) stream. Everything transport-shaped — root minting,
 * retention of returned sinks, per-delivery stub lifecycles, expression
 * walking over RPC — lives here, keeping this file the ONLY streams module
 * that knows transports exist.
 */
export function createSubscriberDial(deps: {
  /** The stream's projectId; `null` = global stream (deployment authority root). */
  projectId: string | null;
  /** The Durable Object's `ctx.exports` (the in-worker loopback registry). */
  exports: unknown;
  /** Where durable-sink delivery rejections land (spine: close → re-poke). */
  onDurableDeliveryError(subscriptionKey: string, error: unknown): void;
}): SubscriberDial {
  /**
   * Mints the stream's authority root for one expression evaluation. Both the
   * loopback binding and the root it returned are per-acquisition stubs —
   * dropping either unpulled leaks the remote reference for the isolate's
   * lifetime, so the caller MUST run `dispose` (push: right after the call;
   * wake: when the connection's sink is disposed, because the returned sink
   * proxies through this chain and must not outlive it).
   */
  const acquireAuthorityRoot = async () => {
    const binding = itxLoopbackStub(deps.exports, { projectId: deps.projectId, path: "/" });
    try {
      const root = await binding.get();
      return {
        root,
        dispose: () => {
          (root as Partial<Disposable>)[Symbol.dispose]?.();
          binding[Symbol.dispose]?.();
        },
      };
    } catch (error) {
      binding[Symbol.dispose]?.();
      throw error;
    }
  };

  /**
   * The push lane's CACHED authority root. The authority is the ambient
   * trusted context at the stream's own fixed scope — there is nothing
   * per-delivery to re-derive — so re-minting the loopback chain (an awaited
   * RPC round trip plus target-graph construction) on every batch bought
   * nothing and sat directly on the ack latency path; at trickle rates every
   * append paid it. Any delivery failure disposes the chain and the next
   * attempt re-mints (bounds a wedged chain); the chain is same-isolate, so
   * holding it pins memory, not cross-isolate duration. The WAKE lane stays
   * per-acquisition: its chain's lifetime is tied to the sink the poke
   * returns (see `onDisposed` below).
   */
  let pushRoot: Promise<{ root: unknown; dispose: () => void }> | undefined;
  const acquirePushRoot = () => {
    if (pushRoot === undefined) {
      const acquiring = acquireAuthorityRoot();
      pushRoot = acquiring;
      // A failed mint must not cache a forever-rejected promise.
      acquiring.catch(() => {
        if (pushRoot === acquiring) pushRoot = undefined;
      });
    }
    return pushRoot;
  };
  const invalidatePushRoot = (chain: Promise<{ root: unknown; dispose: () => void }>) => {
    if (pushRoot === chain) pushRoot = undefined;
    void chain.then((acquired) => acquired.dispose()).catch(() => {});
  };

  /** The webhook lane's cached project-egress fetcher (same policy as `pushRoot`). */
  let webhookEgress: ReturnType<typeof projectEgressFetcher> | undefined;

  return {
    /**
     * One poke: evaluate the wake expression to the handshake response —
     * checkpoint plus a live sink whose ownership transfers to this stream
     * (returned-stub semantics:
     * https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/).
     * The sink is retained with the durable lane's result-pulling liveness
     * policy attached, and the loopback chain that carried it stays alive
     * until the sink is disposed.
     */
    async poke(expression: ItxExpression, request: StreamSubscriberWakeRequest) {
      const { root, dispose } = await acquireAuthorityRoot();
      let response: StreamSubscriberWakeResponse;
      try {
        const { value } = await evaluateItxExpression(root, toInvocation(expression, request));
        response = parseWakeHandshake(value);
      } catch (error) {
        // Disposing the chain releases whatever the failed/misshapen
        // evaluation exported along the way.
        dispose();
        throw error;
      }
      return {
        checkpointOffset: response.checkpointOffset,
        sink: retainProcessEventBatch(response.sink, {
          onDeliveryError: (error) => deps.onDurableDeliveryError(request.subscriptionKey, error),
          onDisposed: dispose,
        }),
        subscriber: response.subscriber,
        getRuntimeState: response.getRuntimeState,
      };
    },

    /**
     * One push delivery: evaluate the expression to a sink and invoke it with
     * the batch — `["processEventBatch"]` reaches the project root's own
     * dispatch point (which delegates to the project worker) and
     * `["streams", ["get", path], "acceptCrossPost"]` reaches a sibling stream —
     * through exactly the calls ordinary user code would make. The
     * awaited resolve is the ack; a reject propagates to the spine's
     * retry/park machine. The authority root is cached across deliveries and
     * dropped on failure (see `acquirePushRoot`).
     */
    async push(expression: ItxExpression, batch: StreamPushEventBatch) {
      const chain = acquirePushRoot();
      const { root } = await chain;
      try {
        await evaluateItxExpression(root, toInvocation(expression, batch));
      } catch (error) {
        // The failure may BE a broken chain; drop it so the retry re-mints.
        // A concurrent delivery mid-evaluate on the same chain fails with it
        // and retries on a fresh one — the spine's backoff owns both.
        invalidatePushRoot(chain);
        throw error;
      }
    },

    /**
     * One webhook delivery: POST the single-event envelope as JSON. A 2xx is
     * the ack; anything else (or a network failure) rejects into the spine's
     * retry/park machine. The receiver is outside the itx world — no root, no
     * stubs, just HTTP — but the request rides the PROJECT EGRESS lane, never
     * bare global fetch: webhook config is appendable by any project
     * principal (including agent scripts whose ordinary egress is jailed), so
     * an un-attributed fetch here would be a durable event-exfiltration
     * channel that bypasses egress policy (thermo round 3, blocker 1). Which
     * is also why webhooks require a project scope: a global stream has no
     * egress identity to attribute the POST to.
     */
    async webhook(url: string, delivery: StreamWebhookDelivery) {
      if (deps.projectId === null) {
        throw new Error("webhook subscriptions require a project-scoped stream");
      }
      // Cached like the push root (webhook drains deliver per EVENT, so a
      // per-POST loopback mint would be paid at the highest possible rate);
      // any failure drops it and the retry re-mints.
      webhookEgress ??= projectEgressFetcher(
        deps.exports as ExecutionContext["exports"],
        deps.projectId,
      );
      const egress = webhookEgress;
      try {
        const response = await egress.fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(delivery),
        });
        // The body is never read; cancel it so the connection is released.
        await response.body?.cancel();
        if (!response.ok) {
          throw new Error(`webhook responded ${response.status} ${response.statusText}`);
        }
      } catch (error) {
        if (webhookEgress === egress) webhookEgress = undefined;
        (egress as Partial<Disposable>)[Symbol.dispose]?.();
        throw error;
      }
    },
  };
}

/**
 * Converts a delivery expression into its invocation: the final step MUST be
 * a property step naming the method, and the dial turns it into a CALL step
 * so the invocation happens receiver-bound on the remote side. Reading the
 * method as a property and applying it locally worked in-process but DETACHED
 * the method from `this` across the real loopback RPC hop on deployed workerd
 * (thermo round 2, blocker 1: every cross-post delivery failed with "Cannot read
 * properties of undefined (reading 'auth')"). Config validation enforces the
 * tail shape at append time; this re-check protects hand-edited state.
 */
function toInvocation(expression: ItxExpression, payload: unknown): ItxExpression {
  const tail = expression.at(-1);
  if (typeof tail !== "string") {
    throw new Error("delivery expression must end in a property step naming the method to invoke");
  }
  return [...expression.slice(0, -1), [tail, payload]];
}

/**
 * Structural check on what a wake expression evaluated to. A configured
 * expression can name ANY reachable method; one that answers with something
 * other than the `{ checkpointOffset, sink }` handshake is a broken
 * subscription, and the spine should see an ordinary delivery failure
 * (backoff → park), not a crash deeper in the pump.
 */
function parseWakeHandshake(value: unknown): StreamSubscriberWakeResponse {
  const candidate = value as Partial<StreamSubscriberWakeResponse> | null | undefined;
  if (
    // A non-integer/NaN/negative checkpoint from a misbehaving (possibly
    // userspace) wake target would flow into the pump cursor and the
    // watermark row, where NaN binds as SQL NULL and produces a
    // live-looking subscription that silently delivers nothing forever.
    // Reject it here so it surfaces as an ordinary delivery failure
    // (backoff → park).
    !Number.isInteger(candidate?.checkpointOffset) ||
    (candidate!.checkpointOffset as number) < 0 ||
    typeof candidate!.sink !== "function"
  ) {
    throw new Error(
      "wake expression did not resolve to a wake handshake ({ checkpointOffset: int >= 0, sink })",
    );
  }
  return candidate as StreamSubscriberWakeResponse;
}
