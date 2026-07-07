import { normalizePath } from "../durable-object-names.ts";
import { BUILTIN_INTEGRATION_SLUGS } from "../integrations/utils.ts";

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

/**
 * Narrow structural view of the `ItxEntrypoint` loopback export on
 * `ctx.exports`. `ctx.exports` is typed globally (src/lib/worker-env.d.ts);
 * this module keeps its own structural view so it never depends on the
 * ambient global Env (same pattern as `projectEgressFetcher`).
 */
type ItxEntrypointLoopbackExports = Record<
  "ItxEntrypoint",
  (options: { props: ItxEntrypointProps }) => Fetcher
>;

export function itxEntrypointBinding(exports: unknown, props: ItxEntrypointProps): Fetcher {
  return (exports as ItxEntrypointLoopbackExports).ItxEntrypoint({ props });
}

/**
 * Shape helper for the `__describe()` convention (see `Description` in
 * types.ts): fills the always-present fields so every node returns
 * `{ instructions, types, children, ... }` even before it has real content.
 * Deliberately dumb — each node hand-writes its description; this is the
 * anchor the future transitive (parent-composes-children) mechanism hangs off.
 */
export function describeNode<Extras extends object>(
  input: {
    instructions: string;
    types?: string;
    children?: Record<string, string>;
    parent?: string;
  } & Extras,
): { instructions: string; types: string; children: Record<string, string> } & Extras {
  return { children: {}, types: "", ...input };
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
/**
 * Guards `provideCapability` against shadowing the itx surface: a capability
 * path's root segment may not be a reserved RPC segment nor an existing member
 * name of the itx-facing surfaces (e.g. `streams`, `agents`). Runs in the
 * isolate because the member names come from RpcTarget prototypes, which the
 * capability-host Durable Object can't see (ITX_SURFACE_MEMBER_NAMES in
 * rpc-targets.ts).
 *
 * Namespace exception: some surface members are NAMESPACES whose children are
 * the supported extension point. `integrations` is the exemplar — mounting at
 * depth >= 2 under it is how a project adds its own integration — EXCEPT under
 * the names the collection's own dispatch claims (built-in slugs and the
 * collection's verbs), where a mount would be durable, journaled, and silently
 * unreachable; those are rejected loudly at provide time.
 */
const NAMESPACE_BUILTIN_ROOTS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [
    "integrations",
    new Set([
      ...BUILTIN_INTEGRATION_SLUGS,
      "list",
      "getConnection",
      "startOAuthFlow",
      "completeConnect",
      "disconnect",
      "invokeCapability",
    ]),
  ],
]);

export function rejectBuiltinCollision(surfaceMembers: ReadonlySet<string>, path: string[]): void {
  const root = path[0];
  if (!root) return;
  if (isReservedDynamicPathSegment(root)) {
    throw new Error(`cannot provide capability "${root}": it is a reserved ITX path segment`);
  }
  if (surfaceMembers.has(root)) {
    const reservedChildren = NAMESPACE_BUILTIN_ROOTS.get(root);
    if (reservedChildren && path.length >= 2) {
      const child = path[1]!;
      if (reservedChildren.has(child)) {
        throw new Error(
          `cannot provide capability "${root}.${child}": "${child}" is a built-in ${root} member and would shadow deployment code`,
        );
      }
      return;
    }
    throw new Error(`cannot provide capability "${root}": it is already on the ITX surface`);
  }
}

/**
 * Builds the dotted-path fallback used by dynamic ITX capabilities.
 *
 * Dynamic dotted fallback uses a function-backed proxy instead of a RpcTarget
 * instance: each missing property extends the path, and applying the function
 * performs one explicit invokeCapability({ path, args }) call.
 */
export function createInvokeCapabilityPathProxy(
  invoker: InvokeCapabilityTarget,
  path: string[] = [],
  isReserved = isReservedDynamicPathSegment,
): unknown {
  const valueFor = (key: string) =>
    createInvokeCapabilityPathProxy(invoker, [...path, key], isReserved);

  return new Proxy(function () {}, {
    apply(_target, _thisArg, args) {
      return invoker.invokeCapability({ args: [...args], path });
    },
    get(target, key, receiver) {
      if (typeof key === "symbol") return Reflect.get(target, key, receiver);
      if (isReserved(key)) return undefined;
      // NOTE `__describe` is deliberately NOT reserved: it traverses like any
      // other segment, and the capability-host processor intercepts trailing
      // `__describe` and answers from the mount's durable metadata
      // (capability-host-processor-implementation.ts #describeMount). One
      // mechanism, no proxy special cases.
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
 *
 * KEY DESIGN IDEA: the RpcTarget with its known members sits *in front of* the ITX
 * Durable Object. Built-ins resolve here in the isolate; only unknown roots fall
 * through to `invokeCapability` (the ITX DO's dynamic table). So `itx.streams.get(...)`
 * never makes a round trip to the DO just to check whether `streams` was shadowed.
 * The deliberate trade-off: a dynamic capability can never shadow a built-in name —
 * the built-in always wins. If we find we need shadowable built-ins a lot, we'd move
 * resolution behind the DO and pay that round trip; for now this keeps the hot path free.
 */
export function withInvokeCapabilityFallback<T extends object>(
  target: T,
  options: {
    isReserved?: (segment: string) => boolean;
    /**
     * Where unknown dotted paths dispatch. Defaults to the target itself, which
     * must then have `invokeCapability`. The itx/agent surfaces pass their
     * capability host instead, so they need no pass-through method of their own.
     */
    invoker?: InvokeCapabilityTarget;
  } = {},
): T {
  const isReserved = options.isReserved ?? isReservedDynamicPathSegment;
  const invoker = options.invoker ?? (target as unknown as InvokeCapabilityTarget);

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
      return createInvokeCapabilityPathProxy(invoker, [key], isReserved);
    },
    getOwnPropertyDescriptor(target, key) {
      // Unknown dynamic roots must not look like instance fields to Cap'n Web.
      // That keeps Workers RPC's RpcTarget instance-property protection intact:
      // actual instance fields are still rejected by the transport, while
      // missing roots are discovered later as dynamic path proxies.
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
