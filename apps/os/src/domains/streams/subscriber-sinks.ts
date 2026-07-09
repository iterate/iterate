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
import { itxLoopbackStub } from "../itx/utils.ts";
import type {
  GetProcessorRuntimeState,
  ProcessEventBatch,
  StreamPushEventBatch,
  StreamSubscriberWakeRequest,
  StreamSubscriberWakeResponse,
} from "./rpc-types.ts";
import type { WakeDeliveryTarget } from "./core-processor-contract.ts";
import type { SubscriberDial } from "./stream-subscribers.ts";
import { disposeIgnoredRpcResult, isThenable } from "./stream-processor.ts";

/** An RPC callback after retention: callable, disposable, with optional broken-transport signal. */
type RetainedRpcCallback<T extends (...args: any[]) => unknown> = T &
  Partial<Disposable> & {
    onRpcBroken?(callback: (error: unknown) => void): void;
  };

/** The pump-facing delivery callback: fire-and-forget, disposable, broken-transport aware. */
export type RetainedProcessEventBatch = ((batch: Parameters<ProcessEventBatch>[0]) => void) &
  Disposable & {
    onRpcBroken?(callback: (error: unknown) => void): void;
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

/** The one RPC method a wake-target Durable Object stub must expose. */
export type WakeTargetStub = {
  wakeStreamSubscriber(request: StreamSubscriberWakeRequest): Promise<StreamSubscriberWakeResponse>;
};

/**
 * Builds the spine's {@link SubscriberDial} from the Stream Durable Object's
 * authority: a namespace resolver for wake pokes (policy — which namespaces
 * exist, target validation — stays with the DO) and the project-scoped itx
 * loopback for push expressions. Everything transport-shaped — retention of
 * returned sinks, per-delivery stub lifecycles, expression walking over RPC —
 * lives here, keeping this file the ONLY streams module that knows transports
 * exist.
 */
export function createSubscriberDial(deps: {
  /** The stream's projectId; push requires a project scope. */
  projectId: string | null;
  /** The Durable Object's `ctx.exports` (the in-worker loopback registry). */
  exports: unknown;
  /** Validate + resolve a wake target to its Durable Object stub (DO policy). */
  wakeTargetStub(target: WakeDeliveryTarget): WakeTargetStub;
  /** Where durable-sink delivery rejections land (spine: close → re-poke). */
  onDurableDeliveryError(subscriptionKey: string, error: unknown): void;
}): SubscriberDial {
  return {
    /**
     * One poke: `wakeStreamSubscriber` on the target Durable Object. The
     * response IS the whole handshake — checkpoint plus a live sink whose
     * ownership transfers to this stream (returned-stub semantics:
     * https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/).
     * The sink is retained here with the durable lane's result-pulling
     * liveness policy attached.
     */
    async poke(target, request) {
      const response = await deps.wakeTargetStub(target).wakeStreamSubscriber(request);
      return {
        checkpointOffset: response.checkpointOffset,
        sink: retainProcessEventBatch(response.sink, {
          onDeliveryError: (error) => deps.onDurableDeliveryError(request.subscriptionKey, error),
        }),
        subscriber: response.subscriber,
        getRuntimeState: response.getRuntimeState,
      };
    },

    /**
     * One push delivery: evaluate the expression to a sink and invoke it with
     * the batch. The root is the project-scoped itx every dynamic worker sees
     * as `env.ITX` (the scheduler's script lane uses the identical recipe), so
     * `["worker", "processEventBatch"]` reaches the project worker and
     * `["streams", ["get", path], "ingest"]` reaches a sibling stream through
     * exactly the calls ordinary user code would make. The awaited resolve is
     * the ack; a reject propagates to the spine's retry/park machine. Both
     * per-delivery stubs (the loopback binding and the itx root it minted) are
     * disposed — dropping either unpulled leaks the remote reference for the
     * isolate's lifetime.
     */
    async push(expression: ItxExpression, batch: StreamPushEventBatch) {
      const projectId = deps.projectId;
      if (projectId === null) {
        throw new Error("push subscriptions require a project-scoped stream");
      }
      // The expression's final step MUST be a property step naming the sink
      // method; the dial turns it into a CALL step so the invocation happens
      // receiver-bound on the remote side. Reading the method as a property
      // and applying it locally worked in-process but DETACHED the method from
      // `this` across the real loopback RPC hop on deployed workerd (thermo
      // round 2, blocker 1: every ingest delivery failed with
      // "Cannot read properties of undefined (reading 'auth')").
      const tail = expression.at(-1);
      if (typeof tail !== "string") {
        throw new Error(
          "push subscription expression must end in a property step naming the sink method",
        );
      }
      const invocation: ItxExpression = [...expression.slice(0, -1), [tail, batch]];
      const binding = itxLoopbackStub(deps.exports, { projectId, path: "/" });
      try {
        const itx = await binding.get();
        try {
          await evaluateItxExpression(itx, invocation);
        } finally {
          (itx as Partial<Disposable>)?.[Symbol.dispose]?.();
        }
      } finally {
        binding[Symbol.dispose]?.();
      }
    },
  };
}
