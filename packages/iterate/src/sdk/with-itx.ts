// sdk/with-itx.ts — `withItx`, THE one way code reaches its context: ONE round trip on
// `env.ITX`, then RELEASE a Workers-RPC round trip completely — the scope and every call it made, not
// only the last. Code imports it from "iterate/with-itx" (`withItx(this.env.ITX, (itx) => …)`),
// this module alone, so code that must not load the SDK's hosts (a script's isolate, the agents' AI
// transport) never does. The SDK's hosts (`StreamProcessorDurableObject.withItx`,
// `IterateConfigEntrypoint.withItx`) delegate to it; their `getItx`, and every loaded entrypoint's
// (loaded-worker.ts), is `itxScope`, the same scope for a `using` declaration. No workerd import,
// so the unit tests run it in node (with-itx.test.ts) and the platform bundles it alone for a
// script's isolate (apps/os `runScriptModule`); on native RpcPromises it is proven by every apps/os
// e2e row that reaches a facet, and pinned by apps/os/e2e/context-residency.e2e.test.ts ("… does
// not outlive …": a facet that kept one value from its context stayed running, billed). Lint
// refuses the raw `env.ITX.get()` (iterate/no-raw-itx-get).

import { currentCause } from "../cause.ts";
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
  const itx = itxScope(entrypoint);
  try {
    return await call(itx);
  } finally {
    itx[Symbol.dispose]();
  }
}

/** `withItx`'s scope for a `using` declaration, which releases it as `withItx` does when the block
 *  ends: its `[Symbol.dispose]` releases the scope and every call made through it, the last first.
 *
 *    using itx = this.getItx();
 *    const { projectSlug } = await itx.whoami();
 */
export function itxScope<Scope>(entrypoint: { get(): Scope }): Scope & Disposable {
  const steps: unknown[] = [];
  // …and hands the platform why the code runs (../cause.ts): a word on no signature
  const itx = (entrypoint as { get(cause: unknown): Scope }).get(currentCause());
  const scope = recordPipelinedSteps(itx, steps, () => releaseRpcSessions([itx, ...steps]));
  // the root answers `[Symbol.dispose]` with the release handed to `recordPipelinedSteps`
  return scope as Scope & Disposable;
}

/** `stub` as the caller sees it, except that every CALL made through it — at any depth, on the stub,
 *  on a call's result, or on the handle a call's result resolves to once awaited — is pushed onto
 *  `steps`, so the caller can dispose each one: a Workers-RPC call's result is a stub-bearing promise
 *  that keeps its session open until disposed, awaited or not. Awaiting hands back a handle (a stub
 *  is callable, in workerd and capnweb alike) recorded and pushed too, and plain data untouched, so
 *  data still copies across RPC. `catch`/`finally` and symbol members (`Symbol.dispose`) are the
 *  value's own, bound to it, so disposing behaves exactly as on the bare stub — but for `stub`'s own
 *  `[Symbol.dispose]`, which is `release` when one is given (`itxScope`); an argument that is
 *  itself a recorded value crosses the wire as the stub it wraps. */
export function recordPipelinedSteps<T>(stub: T, steps: unknown[], release?: () => void): T {
  const wrapped = new WeakMap<object, object>();
  const record = (value: unknown, receiver: unknown): unknown => {
    // oxlint-disable-next-line iterate/simple-truthiness-check -- a Proxy target must be an object or a function: a call may answer any value, and only those two can be wrapped
    if (!value || (typeof value !== "object" && typeof value !== "function")) return value;
    const proxy = new Proxy(value, {
      get(target, key) {
        if (release && key === Symbol.dispose && target === stub) return release;
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
