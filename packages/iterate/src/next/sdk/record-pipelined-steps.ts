// sdk/record-pipelined-steps.ts — the one thing `StreamProcessorDurableObject.withItx` needs to RELEASE
// a Workers-RPC round trip completely: every call it made, not only the last. No workerd import, so
// the unit tests run it in node (record-pipelined-steps.test.ts); on native RpcPromises it is proven by
// every os-next e2e row that reaches a facet, and pinned by apps/os-next/e2e/context-residency.e2e.test.ts
// ("… does not outlive …": a facet that kept one value from its context stayed running, billed).

/** `stub` as the caller sees it, except that every CALL made through it — at any depth, on the stub or
 *  on a call's result — is pushed onto `steps`, so the caller can dispose each one: a Workers-RPC
 *  call's result is a stub-bearing promise that keeps its session open until disposed, awaited or not.
 *  `then`/`catch`/`finally` and symbol members (`Symbol.dispose`) are the value's own, bound to it,
 *  so awaiting and disposing behave exactly as on the bare stub; an argument that is itself a recorded
 *  value crosses the wire as the stub it wraps. */
export function recordPipelinedSteps<T>(stub: T, steps: unknown[]): T {
  const wrapped = new WeakMap<object, object>();
  const record = (value: unknown, receiver: unknown): unknown => {
    // oxlint-disable-next-line iterate/simple-truthiness-check -- a Proxy target must be an object or a function: a call may answer any value, and only those two can be wrapped
    if (!value || (typeof value !== "object" && typeof value !== "function")) return value;
    const proxy = new Proxy(value, {
      get(target, key) {
        const member: unknown = Reflect.get(target, key);
        if (typeof key === "symbol" || key === "then" || key === "catch" || key === "finally")
          return typeof member === "function" ? member.bind(target) : member;
        return record(member, target);
      },
      apply(target, _proxyReceiver, args: unknown[]) {
        // Only a callable target reaches this trap; the call runs on the unwrapped receiver, as
        // `stub.method(…)` would have.
        const result: unknown = Reflect.apply(
          target as (...args: unknown[]) => unknown,
          receiver,
          // `Object(arg)` is a fresh wrapper for a primitive, so only a recorded value is found.
          args.map((arg) => wrapped.get(Object(arg)) ?? arg),
        );
        steps.push(result);
        return record(result, undefined);
      },
    });
    wrapped.set(proxy, value);
    return proxy;
  };
  // The proxy answers every member the stub does (it forwards each one), so it is the stub's type.
  return record(stub, undefined) as T;
}
