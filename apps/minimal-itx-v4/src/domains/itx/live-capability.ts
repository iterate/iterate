export type LiveCapability = {
  dispose(): void;
  invoke(path: string[], args: unknown[]): unknown;
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
  readonly value: T;
};

export function deepRetainRpcStubs<T>(value: T): Retained<T> {
  const retainedStubs: Disposable[] = [];
  const retainedValue = deepCopyAndDupRpcStubs(value, retainedStubs);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const stub of retainedStubs.splice(0)) stub[Symbol.dispose]();
  };
  return {
    value: retainedValue,
    dispose,
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
  const callable = Reflect.get(receiver, method);
  if (typeof callable !== "function") {
    throw new Error(`capability path "${path.join(".")}" did not resolve to a function`);
  }
  return await Reflect.apply(callable, receiver, args);
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
    args: [{ args, path }],
    path: ["invokeCapability"],
    target,
  });
}

function deepCopyAndDupRpcStubs<T>(value: T, retainedStubs: Disposable[]): T {
  if (Array.isArray(value)) {
    const result = new Array(value.length);
    for (let index = 0; index < value.length; index++) {
      result[index] = deepCopyAndDupRpcStubs(value[index], retainedStubs);
    }
    return result as T;
  }

  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      result[key] = deepCopyAndDupRpcStubs(value[key], retainedStubs);
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
