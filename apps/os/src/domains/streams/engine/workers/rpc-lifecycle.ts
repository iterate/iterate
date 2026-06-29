import type { GetProcessorRuntimeState, ProcessEventBatch } from "../types.ts";

type RetainedProcessEventBatch = ProcessEventBatch &
  Disposable & {
    onRpcBroken?(callback: (error: unknown) => void): void;
  };

type RetainableProcessEventBatch = ProcessEventBatch &
  Partial<Disposable> & {
    dup?(): RetainedProcessEventBatch;
    onRpcBroken?(callback: (error: unknown) => void): void;
  };

export function retainProcessEventBatch(
  processEventBatch: ProcessEventBatch,
  opts: {
    /**
     * Observes a rejected batch delivery. Both Workers RPC and Cap'n Web reject
     * the call promise when the remote stub is broken (callee DO evicted,
     * redeployed, or aborted), so this is how a stream notices a dead
     * connection even when `onRpcBroken` is unavailable — see the re-dial
     * wiring in the Stream DO's `#openConnection`.
     */
    onDeliveryError?: (error: unknown) => void;
  } = {},
): RetainedProcessEventBatch {
  const retainable = processEventBatch as RetainableProcessEventBatch;
  const retained = retainable.dup?.() ?? retainable;
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
        // forever. Dispose only after settle — disposing a pending Cap'n Web
        // promise cancels the call.
        //
        // Observing the result is not free: pulling a Cap'n Web promise makes
        // the remote send a resolve frame per delivery. Callers that don't
        // pass onDeliveryError (inbound/browser connections, whose liveness
        // is covered by onRpcBroken on the terminated socket) keep the
        // zero-return-traffic fast path below.
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
  // the stub claims to have, defensively — a stub without a real onRpcBroken
  // is still covered by the onDeliveryError path above.
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

type RetainedGetProcessorRuntimeState = GetProcessorRuntimeState & Disposable;

type RetainableGetProcessorRuntimeState = GetProcessorRuntimeState &
  Partial<Disposable> & {
    dup?(): RetainedGetProcessorRuntimeState;
  };

export function retainGetProcessorRuntimeState(
  getRuntimeState: GetProcessorRuntimeState | undefined,
): RetainedGetProcessorRuntimeState | undefined {
  if (getRuntimeState === undefined) return undefined;
  const retainable = getRuntimeState as RetainableGetProcessorRuntimeState;
  const retained = retainable.dup?.() ?? retainable;
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
