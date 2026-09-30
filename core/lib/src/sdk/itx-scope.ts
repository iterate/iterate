// sdk/itx-scope.ts — `itxScope`, what every `getItx` is: the SDK's hosts' (index.ts) and every
// loaded entrypoint's (loaded-worker.ts). THE one way code reaches its context is
// `using itx = this.getItx()` in the smallest block that holds its calls: the `using` releases a
// Workers-RPC scope completely when the block ends — the scope and every call made through it, not
// only the last. A value code keeps from its context past that — an undisposed call, a handle, a
// stub — keeps the context, and any facet holding it, running and billed: pinned by
// test/vitest/os/context-residency.e2e.test.ts ("… does not outlive …"). No workerd import, so the
// unit tests run it in node (itx-scope.test.ts). Lint refuses the raw `env.ITX.get()`, and a
// `getItx()` no `using` binds (iterate/no-raw-itx-get).

import { currentCause } from "../cause.ts";
import { releaseRpcSessions } from "../lib.ts";

/** ONE get on `entrypoint`, under the running cause, for a `using` declaration: its
 *  `[Symbol.dispose]` releases the scope and every call made through it or through a handle it
 *  awaited, the last first. A release that throws is reported and the rest still run (lib.ts
 *  `releaseRpcSessions`), so an answer already awaited stands. Data stays usable after the block;
 *  a stub or handle is released with the rest, so a block hands out data. Await every call before
 *  the block ends: `return await itx.whoami()`, never `return itx.whoami()`.
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
