import type { GetProcessorRuntimeState, ProcessEventBatch } from "../../../../../types.ts";

type RetainedRpcCallback<T extends (...args: any[]) => unknown> = T &
  Partial<Disposable> & {
    onRpcBroken?(callback: (error: unknown) => void): void;
  };

type FireAndForgetRetainedRpcCallback<T extends (...args: any[]) => unknown> = ((
  ...args: Parameters<T>
) => void) &
  Partial<Disposable> & {
    onRpcBroken?(callback: (error: unknown) => void): void;
  };

type RetainableRpcCallback<T extends (...args: any[]) => unknown> = T &
  Partial<Disposable> & {
    dup?(): RetainedRpcCallback<T>;
    onRpcBroken?(callback: (error: unknown) => void): void;
  };

type RetainedProcessEventBatch = FireAndForgetRetainedRpcCallback<ProcessEventBatch> & Disposable;

type RetainedGetProcessorRuntimeState = RetainedRpcCallback<GetProcessorRuntimeState> & Disposable;

/**
 * Retains an RPC callback stub by duplicating it when the transport exposes
 * `.dup()`.
 *
 * Use this when this isolate keeps any relationship to the callback after the
 * RPC method that received it returns, such as the Stream Durable Object's live
 * connection table. Transparent forwarding layers should not use this helper:
 * Workers RPC duplicates stubs in call parameters as of the 2026-01-20
 * `rpc_params_dup_stubs` compatibility change, matching Cap'n Web's ownership
 * model:
 * https://developers.cloudflare.com/workers/configuration/compatibility-flags/#duplicate-stubs-in-rpc-params-instead-of-transferring-ownership
 *
 * Any duplicate retained past the receiving RPC call must later be disposed:
 * https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/#stubs-received-as-parameters-in-an-rpc-call
 * https://github.com/cloudflare/capnweb#resource-management-and-disposal
 */
export function retainRpcCallback<T extends (...args: any[]) => unknown>(
  callback: T,
): RetainedRpcCallback<T> {
  const retainable = callback as RetainableRpcCallback<T>;
  return retainable.dup?.() ?? retainable;
}

export function retainProcessEventBatch(
  processEventBatch: ProcessEventBatch,
  opts: {
    /**
     * Observes a rejected batch delivery for outbound subscriber connections.
     * Both Workers RPC and Cap'n Web reject the call result when the remote stub
     * is broken, so this is how a stream notices a dead DO-to-DO connection even
     * when `onRpcBroken` is unavailable. Inbound browser/client subscriptions do
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
        //
        // Observing the result is not free: pulling a Cap'n Web promise makes
        // the remote send a resolve frame per delivery. Callers that don't
        // pass onDeliveryError keep the zero-return-traffic fast path. Inbound
        // browser/client subscriptions use explicit unsubscribe plus the
        // transport's best-effort onRpcBroken signal.
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
  // the stub claims to have, defensively. For outbound subscribers, the
  // onDeliveryError path still observes broken stubs even if this registration
  // was only a pipelined fake; inbound subscribers remain explicit-unsubscribe
  // plus best-effort onRpcBroken.
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

export function retainGetProcessorRuntimeState(
  getRuntimeState: GetProcessorRuntimeState | undefined,
): RetainedGetProcessorRuntimeState | undefined {
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

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as PromiseLike<unknown>).then === "function"
  );
}

export function disposeIgnoredRpcResult(result: unknown): void {
  if (
    result !== null &&
    (typeof result === "object" || typeof result === "function") &&
    Symbol.dispose in result
  ) {
    (result as Disposable)[Symbol.dispose]();
  }
}
