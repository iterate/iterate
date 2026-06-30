import { normalizePath } from "../durable-object-names.ts";

type DisposableLike = {
  [Symbol.dispose]?(): void;
  dup?(): DisposableLike;
};

type InvokeCapabilityTarget = {
  invokeCapability(call: { args: unknown[]; path: string[] }): unknown;
};

const RESERVED_DYNAMIC_PATH_SEGMENTS: ReadonlySet<string> = new Set([
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
  "__proto__",
  "apply",
  "bind",
  "call",
  "catch",
  "constructor",
  "dup",
  "finally",
  "hasOwnProperty",
  "isPrototypeOf",
  "map",
  "onRpcBroken",
  "propertyIsEnumerable",
  "prototype",
  "then",
  "toLocaleString",
  "toString",
  "valueOf",
]);

export type ItxEntrypointScope = {
  path: string;
  projectId: string;
};

export type ItxEntrypointProps = ItxEntrypointScope;

/**
 * Normalizes the props passed into dynamic workers' `env.ITX` binding.
 *
 * Worker Loader cache keys, stateful worker Durable Object names, and
 * `env.ITX.get()` must all agree on the same project/path scope. Keeping this
 * normalization in one small helper prevents one call site from caching under
 * `"agents/demo"` while another resolves the runtime ITX target as
 * `"/agents/demo"`.
 */
export function itxEntrypointProps(input: ItxEntrypointScope): ItxEntrypointProps {
  return {
    path: normalizePath(input.path),
    projectId: input.projectId,
  };
}

/**
 * Validates the host-minted binding props before giving worker code an ITX
 * capability. This is the trust boundary for dynamic workers: callers do not
 * choose their own scope, the hosting object mints it.
 */
export function scopeFromItxEntrypointProps(
  props: ItxEntrypointProps | undefined,
): ItxEntrypointScope {
  if (props === undefined) {
    throw new Error("env.ITX.get() requires ITX binding props with projectId and path");
  }
  if (props.projectId.trim() === "") {
    throw new Error("env.ITX.get() requires a non-empty projectId");
  }
  return {
    path: normalizePath(props.path),
    projectId: props.projectId,
  };
}

/**
 * Builds the Worker Loader cache key component for an ITX scope.
 *
 * The same module bytes can be loaded under different project/agent scopes, and
 * those scopes must not share Worker Loader instances because `env.ITX` would
 * point at the wrong capability tree.
 */
export function itxEntrypointScopeCacheKey(scope: ItxEntrypointScope): string {
  return JSON.stringify({
    path: normalizePath(scope.path),
    projectId: scope.projectId,
  });
}

/**
 * Groups an authenticated child stub with the parent stubs that keep it alive.
 *
 * Cap'n Web callers often want `using project = connectItx({ projectId })`, but
 * that project stub is reached through a root session and authentication stub.
 * This proxy makes disposal and `dup()` preserve the whole ownership chain, so
 * disposing the child also tells the server it can release the parent stubs.
 */
export function withOwnedRpcSession<T extends object>(stub: T, ...owned: DisposableLike[]): T {
  let disposed = false;
  return new Proxy(stub, {
    get(target, key, receiver) {
      if (key === Symbol.dispose) {
        return () => {
          if (disposed) return;
          disposed = true;
          disposeAll(target as DisposableLike, ...owned);
        };
      }
      if (key === "dup") {
        return () => withOwnedRpcSession(dup(target as DisposableLike), ...owned.map(dup));
      }
      return Reflect.get(target, key, receiver);
    },
  });
}

/**
 * Guards `provideCapability` against shadowing the host's own surface: a
 * capability path's root segment may not be a reserved RPC segment nor an
 * existing builtin on the target RpcTarget (e.g. `streams`, `agents`). Runs in
 * the isolate because it inspects the RpcTarget instance, which the DO can't see.
 */
export function rejectBuiltinCollision(target: object, path: string[]): void {
  const root = path[0];
  if (!root) return;
  if (isReservedDynamicPathSegment(root)) {
    throw new Error(`cannot provide capability "${root}": it is a reserved ITX path segment`);
  }
  if (root in target) {
    throw new Error(`cannot provide capability "${root}": it is already on this ITX target`);
  }
}

/**
 * Builds the callable dotted-path fallback used by dynamic ITX capabilities.
 *
 * Cap'n Web and Workers RPC can transport functions as callable capabilities.
 * Dynamic dotted fallback therefore uses a function-backed proxy instead of a
 * RpcTarget instance: each missing property extends the path, and applying the
 * function performs one explicit invokeCapability({ path, args }) call.
 */
export function createInvokeCapabilityPathProxy(
  target: InvokeCapabilityTarget,
  path: string[] = [],
  isReserved = isReservedDynamicPathSegment,
): unknown {
  const valueFor = (key: string) =>
    createInvokeCapabilityPathProxy(target, [...path, key], isReserved);

  return new Proxy(function () {}, {
    apply(_target, _thisArg, args) {
      return target.invokeCapability({ args: [...args], path });
    },
    get(target, key, receiver) {
      if (typeof key === "symbol") return Reflect.get(target, key, receiver);
      if (isReserved(key)) return undefined;
      return valueFor(key);
    },
    getOwnPropertyDescriptor(target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      if (descriptor) return descriptor;
      if (typeof key === "symbol" || isReserved(key)) return undefined;
      // Cap'n Web's server-side path traversal probes own descriptors before
      // reading a segment. Dynamic roots need to look discoverable here so
      // calls like project.slack.chat.postMessage(...) reach the apply trap.
      return {
        configurable: true,
        enumerable: true,
        value: valueFor(key),
        writable: false,
      };
    },
    has(target, key) {
      if (typeof key === "symbol") return key in target;
      return !isReserved(key);
    },
  });
}

/**
 * Wraps a fixed RpcTarget with the dynamic capability fallback surface.
 *
 * Built-in methods still win through normal property lookup. Only missing roots
 * become dynamic capability paths, which lets the public API expose concrete
 * methods like `streams` while also supporting provided paths such as
 * `project.slack.chat.postMessage(...)`.
 */
export function withInvokeCapabilityFallback<T extends object & InvokeCapabilityTarget>(
  target: T,
  options: { isReserved?: (segment: string) => boolean } = {},
): T {
  const isReserved = options.isReserved ?? isReservedDynamicPathSegment;

  return new Proxy(target, {
    get(target, key) {
      if (key === "then") return undefined;
      if (typeof key === "symbol" || key in target) {
        const value = Reflect.get(target, key, target);
        if (typeof value === "function" && !isAccessor(target, key)) {
          return value.bind(target);
        }
        return value;
      }
      if (isReserved(key)) return undefined;
      return createInvokeCapabilityPathProxy(target, [key], isReserved);
    },
    getOwnPropertyDescriptor(target, key) {
      // Unknown dynamic roots must not look like instance fields to Cap'n Web.
      // That keeps Workers RPC's RpcTarget instance-property protection intact:
      // actual instance fields are still rejected by the transport, while
      // missing roots are discovered later as callable path proxies.
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
}

function isReservedDynamicPathSegment(segment: string): boolean {
  return RESERVED_DYNAMIC_PATH_SEGMENTS.has(segment);
}

function dup(disposable: DisposableLike): DisposableLike {
  if (disposable.dup === undefined) {
    throw new Error("Cannot dup scoped RPC stub because an owned stub does not expose dup()");
  }
  return disposable.dup();
}

function disposeAll(...disposables: DisposableLike[]): void {
  let firstError: unknown;
  for (const disposable of disposables) {
    try {
      disposable[Symbol.dispose]?.();
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError !== undefined) throw firstError;
}

function isAccessor(target: object, key: PropertyKey): boolean {
  for (let node: object | null = target; node; node = Object.getPrototypeOf(node)) {
    const descriptor = Object.getOwnPropertyDescriptor(node, key);
    if (descriptor) return descriptor.get !== undefined;
  }
  return false;
}
