// sdk/record-pipelined-steps.ts — `withItx`, THE one way code reaches its context: ONE round trip on
// `env.ITX`, then RELEASE a Workers-RPC round trip completely — the scope and every call it made, not
// only the last. Loaded code imports it from "./processor.js" (`withItx(this.env.ITX, (itx) => …)`); the
// SDK's hosts (`StreamProcessorDurableObject.withItx`, `ConfigWorker.withItx`) delegate to it. No
// workerd import, so the unit tests run it in node (record-pipelined-steps.test.ts) and the platform
// bundles it alone for a script's isolate (apps/os `runScriptModule`); on native RpcPromises it is
// proven by every apps/os e2e row that reaches a facet, and pinned by
// apps/os/e2e/context-residency.e2e.test.ts ("… does not outlive …": a facet that kept one value from
// its context stayed running, billed). Lint refuses the raw `env.ITX.get()` (iterate/no-raw-itx-get).

import { releaseRpcSessions } from "../lib.ts";

/** ONE round trip on `entrypoint.get()`, then RELEASE EVERYTHING IT REACHED: the scope and every call
 *  `call` made through it or through a handle it awaited, the last first. A release that throws is reported and the rest still run
 *  (lib.ts `releaseRpcSessions`), so the call's answer stands. Data it answers stays usable; a stub or
 *  handle it answers is released with the rest, so return data.
 *
 *    const { projectSlug } = await withItx(this.env.ITX, (itx) => itx.whoami());
 */
export async function withItx<Scope, T>(
  entrypoint: { get(): Scope },
  call: (itx: Scope) => T,
): Promise<Awaited<T>> {
  const steps: unknown[] = [];
  const itx = entrypoint.get();
  try {
    return await call(recordPipelinedSteps(itx, steps));
  } finally {
    releaseRpcSessions([itx, ...steps]);
  }
}

/** `stub` as the caller sees it, except that every CALL made through it — at any depth, on the stub,
 *  on a call's result, or on the handle a call's result resolves to once awaited — is pushed onto
 *  `steps`, so the caller can dispose each one: a Workers-RPC call's result is a stub-bearing promise
 *  that keeps its session open until disposed, awaited or not. Awaiting hands back a handle (a stub
 *  is callable, in workerd and capnweb alike) recorded and pushed too, and plain data untouched, so
 *  data still copies across RPC. `catch`/`finally` and symbol members (`Symbol.dispose`) are the
 *  value's own, bound to it, so disposing behaves exactly as on the bare stub; an argument that is
 *  itself a recorded value crosses the wire as the stub it wraps. */
export function recordPipelinedSteps<T>(stub: T, steps: unknown[]): T {
  const wrapped = new WeakMap<object, object>();
  const record = (value: unknown, receiver: unknown): unknown => {
    // oxlint-disable-next-line iterate/simple-truthiness-check -- a Proxy target must be an object or a function: a call may answer any value, and only those two can be wrapped
    if (!value || (typeof value !== "object" && typeof value !== "function")) return value;
    const proxy = new Proxy(value, {
      get(target, key) {
        const member: unknown = Reflect.get(target, key);
        if (key === "then" && typeof member === "function")
          // `const repo = await itx.repos.get(p); await repo.whoami()`: disposing the step releases
          // `repo` (workerd disposes a promise's result with it), never `whoami`'s call, and an
          // awaited property (`await itx.repos`) is no step at all.
          return (onFulfilled?: unknown, onRejected?: unknown) =>
            Reflect.apply(member, target, [
              typeof onFulfilled === "function"
                ? (answer: unknown) => {
                    if (typeof answer !== "function") return onFulfilled(answer);
                    steps.push(answer);
                    return onFulfilled(record(answer, undefined));
                  }
                : onFulfilled,
              onRejected,
            ]);
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
