// Canonical retention for RPC callback stubs — the one place that knows a sink
// might be a remote Cap'n Web / Workers RPC stub rather than a local function.
//
// A "sink" is a callback the server keeps calling AFTER the RPC method that
// carried it returned (a live subscription's push). Retaining it means: dup the
// underlying stub while the transport supports it, and dispose the dup on close.
// The stream event-delivery lane (`retainProcessEventBatch`) and the live-state
// publisher both build on these primitives instead of re-deriving the dance.

/** An RPC callback after retention: still callable, plus disposable and (best-effort) broken-transport aware. */
export type RetainedCallback<Arg> = ((arg: Arg) => unknown) &
  Disposable & { onRpcBroken?(handler: (error: unknown) => void): void };

/**
 * Retain a single-argument RPC callback so it survives past the call that
 * carried it. `dup()` duplicates the underlying remote stub (that dup is what
 * `[Symbol.dispose]` releases); `onRpcBroken` is forwarded defensively — Cap'n
 * Web stubs expose no own property descriptors and a Workers RPC property access
 * can fabricate a pipelined method that rejects at call time, so we wire whatever
 * the stub claims and swallow registration failures. `onRpcBroken` is only a
 * prompt hint; observing a delivery rejection is the reliable death signal.
 */
export function retainCallback<Arg>(callback: (arg: Arg) => unknown): RetainedCallback<Arg> {
  const retainable = callback as ((arg: Arg) => unknown) &
    Partial<Disposable> & {
      dup?(): (arg: Arg) => unknown;
      onRpcBroken?(handler: (error: unknown) => void): void;
    };
  const retained = (retainable.dup?.() ?? retainable) as typeof retainable;
  const dispose = retained[Symbol.dispose]?.bind(retained);
  // Idempotent by contract: owners often dispose from several paths (publisher
  // drop + connection teardown), and a double release of the underlying dup
  // would free someone else's reference.
  let disposed = false;
  const wrapped = Object.assign((arg: Arg) => retained(arg), {
    [Symbol.dispose]() {
      if (disposed) return;
      disposed = true;
      dispose?.();
    },
  }) as RetainedCallback<Arg>;
  const onRpcBroken = retained.onRpcBroken;
  if (typeof onRpcBroken === "function") {
    wrapped.onRpcBroken = (handler: (error: unknown) => void) => {
      try {
        const result = onRpcBroken.call(retained, handler);
        if (isThenable(result)) void Promise.resolve(result).catch(() => {});
      } catch {
        // Registration is best-effort.
      }
    };
  }
  return wrapped;
}

/** Thenable probe: RPC stubs and their call results are thenable-shaped. */
export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as PromiseLike<unknown>).then === "function"
  );
}

/**
 * Dispose the result of an RPC call whose value the caller ignores. Reading a
 * Cap'n Web / Workers RPC method yields a disposable stub even when unused, and
 * dropping it without disposal leaks the remote reference.
 */
export function disposeIgnoredRpcResult(result: unknown): void {
  if (
    result !== null &&
    (typeof result === "object" || typeof result === "function") &&
    Symbol.dispose in result
  ) {
    (result as Disposable)[Symbol.dispose]();
  }
}
