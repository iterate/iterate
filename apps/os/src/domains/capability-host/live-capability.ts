import { RpcStub } from "capnweb";
import { disposeIgnoredRpcResult } from "iterate/sdk/capnweb";

/**
 * Copy a completed plain-data RPC result before releasing the result wrapper.
 * A returned RPC target, function, cyclic graph, or data containing one stays
 * caller-owned; disposing its wrapper could invalidate an exported capability.
 */
export function detachDisposablePlainRpcResult(result: unknown): unknown {
  if (!isDetachedPlainData(result)) return result;
  const detached = Array.isArray(result) ? [...result] : { ...result };
  Reflect.deleteProperty(detached, Symbol.dispose);
  try {
    disposeIgnoredRpcResult(result);
  } catch (error) {
    // The provider operation already succeeded with detached data. Preserve
    // that outcome while making a failed remote release observable.
    console.warn("live provider plain-data result disposal failed", { error });
  }
  return detached;
}

function isDetachedPlainData(value: unknown): value is object {
  if (!isPlainObjectOrArray(value)) return false;
  const seen = new WeakSet<object>();
  seen.add(value);
  return Object.values(value).every((entry) => isDetachedPlainValue(entry, seen));
}

function isDetachedPlainValue(value: unknown, seen: WeakSet<object>): boolean {
  if (value === null) return true;
  if (typeof value === "function") return false;
  if (typeof value !== "object") return true;
  if (Symbol.dispose in value || typeof Reflect.get(value, "dup") === "function") return false;
  if (!isPlainObjectOrArray(value) || seen.has(value)) return false;
  seen.add(value);
  const detached = Object.values(value).every((entry) => isDetachedPlainValue(entry, seen));
  seen.delete(value);
  return detached;
}

function isPlainObjectOrArray(value: unknown): value is object {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return true;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export type LiveCapability = {
  dispose(): void;
  invoke(path: string[], args: unknown[]): unknown;
  onRpcBroken(handler: (error: unknown) => void): void;
};

/**
 * Retains a live capability provider that may contain RPC stubs from the peer.
 *
 * Ownership rule:
 * - transparent RPC forwarders pass stubs through unchanged;
 * - the isolate that stores a stub past the RPC method return duplicates it and
 *   later disposes the duplicate.
 *
 * A live capability can dispatch in two ways:
 * - default member replay, where the remaining dotted path is walked on the
 *   retained target;
 * - flattened path dispatch, where the retained target's hardcoded
 *   `invokeCapability` method receives the remaining path as data.
 *
 * Source docs:
 * https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/
 * https://developers.cloudflare.com/workers/configuration/compatibility-flags/#duplicate-stubs-in-rpc-params-instead-of-transferring-ownership
 * https://github.com/cloudflare/capnweb#cloudflare-workers-rpc-interoperability
 */
export function retainLiveCapabilityProvider(
  provider: unknown,
  options: { flattenNestedPath?: boolean } = {},
): LiveCapability {
  const retainedProvider = deepRetainRpcStubs(provider);
  return {
    dispose: () => retainedProvider.dispose(),
    invoke: (path, args) =>
      options.flattenNestedPath === true
        ? invokeFlattenedPath({ args, path, target: retainedProvider.value })
        : replayPath({ args, path, target: retainedProvider.value }),
    onRpcBroken: retainedProvider.onRpcBroken,
  };
}

/**
 * Deep-copy a provider tree and retain every RPC stub-like value by calling
 * `.dup()`.
 *
 * Copied and pared down from Cloudflare Cap'n Web's `RpcPayload.deepCopyFrom()`
 * and `RpcPayload.deepCopy()` implementation:
 * https://raw.githubusercontent.com/cloudflare/capnweb/f6cd6863d5554a2964c1396bab2274359a45e037/src/core.ts
 *
 * Cap'n Web's original returns a `RpcPayload` that owns internal `StubHook`s.
 * This local version keeps the same app-facing value shape and records only the
 * concrete `.dup()` results. Disposal releases exactly those duped stubs, never
 * arbitrary local values that merely happen to be reachable from the provider.
 */
type Retained<T> = Disposable & {
  dispose(): void;
  onRpcBroken(handler: (error: unknown) => void): void;
  readonly value: T;
};

export function deepRetainRpcStubs<T>(value: T): Retained<T> {
  const retainedStubs: Disposable[] = [];
  const brokenHandlers = new Set<(error: unknown) => void>();
  let broken: { error: unknown } | undefined;
  const notifyBroken = (error: unknown) => {
    if (broken !== undefined) return;
    broken = { error };
    for (const handler of brokenHandlers) handler(broken.error);
  };
  const retainedValue = deepCopyAndDupRpcStubs(value, retainedStubs, notifyBroken);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    brokenHandlers.clear();
    for (const stub of retainedStubs.splice(0)) stub[Symbol.dispose]();
  };
  return {
    value: retainedValue,
    dispose,
    onRpcBroken: (handler) => {
      brokenHandlers.add(handler);
      if (broken !== undefined) handler(broken.error);
    },
    [Symbol.dispose]: dispose,
  };
}

export async function replayPath({
  args,
  path,
  target,
}: {
  args: unknown[];
  path: string[];
  target: unknown;
}) {
  if (path.length === 0) {
    return typeof target === "function" ? await target(...args) : target;
  }
  let receiver = await target;
  for (let i = 0; i < path.length - 1; i++) {
    if (!isObjectLike(receiver)) {
      throw new Error(`capability path "${path.join(".")}" hit ${String(receiver)}`);
    }
    receiver = await Reflect.get(receiver, path[i]);
  }
  const method = path.at(-1)!;
  if (!isObjectLike(receiver)) {
    throw new Error(`capability path "${path.join(".")}" hit ${String(receiver)}`);
  }
  const handler = Reflect.get(receiver, method);
  if (typeof handler !== "function") {
    throw new Error(`capability path "${path.join(".")}" did not resolve to a function`);
  }
  return await Reflect.apply(handler, receiver, args);
}

/**
 * Flattened dispatch with member-replay fallback: prefer ONE
 * `invokeCapability({ path, args })` call (a worker that implements the
 * dispatcher gets whole dotted paths in a single RPC — how the seeded
 * template serves `slack.chat.postMessage`), but a worker that simply does
 * not implement it falls back to member-by-member replay, so committing a
 * plain WorkerEntrypoint never breaks `project.worker.*`. Only the specific
 * "method does not exist" failure falls back; errors thrown BY a dispatcher
 * propagate untouched.
 */
export async function invokePreferringFlattenedPath({
  args,
  path,
  target,
}: {
  args: unknown[];
  path: string[];
  target: unknown;
}) {
  try {
    return await invokeFlattenedPath({ args, path, target });
  } catch (error) {
    if (!isMissingInvokeCapabilityError(error)) throw error;
    return await replayPath({ args, path, target });
  }
}

// Workers RPC reports a call to a method the receiver does not have as a
// TypeError naming the method; local replay reports it as our own "did not
// resolve to a function". Both mean "this worker has no dispatcher". Message
// drift in a workerd upgrade fails loudly: the itx e2e "…dynamic worker refs
// compose" test commits a plain entrypoint worker whose calls only succeed
// through this fallback.
export function isMissingInvokeCapabilityError(error: unknown): boolean {
  if (error instanceof TypeError) {
    return error.message.includes('does not implement the method "invokeCapability"');
  }
  return (
    error instanceof Error &&
    error.message.includes('capability path "invokeCapability" did not resolve to a function')
  );
}

export async function invokeFlattenedPath({
  args,
  path,
  target,
}: {
  args: unknown[];
  path: string[];
  target: unknown;
}) {
  return await replayPath({
    args: [{ args, flattenNestedPath: true, path }],
    path: ["invokeCapability"],
    target,
  });
}

function deepCopyAndDupRpcStubs<T>(
  value: T,
  retainedStubs: Disposable[],
  onRpcBroken: (error: unknown) => void,
): T {
  if (Array.isArray(value)) {
    const result = new Array(value.length);
    for (let index = 0; index < value.length; index++) {
      result[index] = deepCopyAndDupRpcStubs(value[index], retainedStubs, onRpcBroken);
    }
    return result as T;
  }

  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      result[key] = deepCopyAndDupRpcStubs(value[key], retainedStubs, onRpcBroken);
    }
    return result as T;
  }

  if (isRpcStubLike(value)) {
    const retained = (value as { dup: () => unknown }).dup();
    if (
      isObjectLike(retained) &&
      typeof (retained as { [Symbol.dispose]?: unknown })[Symbol.dispose] === "function"
    ) {
      retainedStubs.push(retained as Disposable);
    }
    // `RpcStub` is Cap'n Web's positive runtime identity. Do not probe an
    // arbitrary Workers RPC proxy for a fabricated `onRpcBroken` member.
    if (retained instanceof RpcStub) retained.onRpcBroken(onRpcBroken);
    return retained as T;
  }

  return value;
}

function isRpcStubLike(value: unknown): value is { dup(): unknown } {
  return isObjectLike(value) && typeof (value as { dup?: unknown }).dup === "function";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isObjectLike(value) || typeof value === "function") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isObjectLike(value: unknown): value is object | ((...args: never[]) => unknown) {
  return value !== null && (typeof value === "object" || typeof value === "function");
}
