import { normalizePath } from "../durable-object-names.ts";
import { BUILTIN_INTEGRATION_SLUGS } from "../integrations/utils.ts";

/**
 * Minimal ExecutionContext shape the RPC adapter layer needs.
 *
 * Server-side plumbing, not part of the client-facing itx contract. It is
 * exported only so domain hosts can inject project/agent capability targets
 * without importing the full worker module.
 */
export type CfExecutionContext = {
  exports: ExecutionContext["exports"];
  /** Required, not optional: budget-expired dynamic worker builds are handed
   * to it (worker-loader.ts withBuildBudget) — a silent no-op here would
   * strand every cold build the caller gave up on. Hosts without a real
   * runtime hook must still supply an explicit function. */
  waitUntil: ExecutionContext["waitUntil"];
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
  /** The host-minted lane determines whether this binding can reach delivery-only sinks. */
  purpose: "stream-delivery" | "userspace";
  /**
   * `null` is the deployment-global scope: the trusted root a GLOBAL
   * (`projectId: null`) stream's delivery dial evaluates expressions against.
   * Dynamic workers are always project-scoped — their minting paths type
   * `projectId: string` upstream, so `null` never reaches a worker binding.
   */
  projectId: string | null;
};

export type ItxEntrypointProps = ItxEntrypointScope;

/**
 * Normalizes the props passed into dynamic workers' `env.ITX` binding.
 *
 * Worker Loader cache keys, stateful worker Durable Object names, and
 * `env.ITX.get()` must all agree on the same project/path scope. Keeping this
 * normalization in one small helper prevents one call site from caching under
 * `"agents/demo"` while another resolves the runtime itx target as
 * `"/agents/demo"`.
 */
export function itxEntrypointProps(input: ItxEntrypointScope): ItxEntrypointProps {
  return {
    path: normalizePath(input.path),
    projectId: input.projectId,
    purpose: input.purpose,
  };
}

/**
 * Validates the host-minted binding props before giving worker code an itx
 * capability. This is the trust boundary for dynamic workers: callers do not
 * choose their own scope, the hosting object mints it.
 */
export function scopeFromItxEntrypointProps(
  props: ItxEntrypointProps | undefined,
): ItxEntrypointScope {
  if (props === undefined) {
    throw new Error("env.ITX.get() requires itx binding props with projectId, path, and purpose");
  }
  if (props.projectId !== null && props.projectId.trim() === "") {
    throw new Error("env.ITX.get() requires a non-empty projectId (or null for the global scope)");
  }
  if (props.purpose !== "stream-delivery" && props.purpose !== "userspace") {
    throw new Error("env.ITX.get() requires purpose to be userspace or stream-delivery");
  }
  return {
    path: normalizePath(props.path),
    projectId: props.projectId,
    purpose: props.purpose,
  };
}

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
 * The loopback ItxEntrypoint stub viewed by callers that use its RPC `get()`
 * (the scoped itx root) rather than binding it as a dynamic worker's env
 * fetcher. Same stub, honest type: `Fetcher` is what worker bindings need,
 * `get()` is what in-process callers (the stream delivery dial, scheduler
 * scripts) actually call. Both the stub and the root it returns are
 * per-acquisition and must be disposed by the caller.
 */
type ItxLoopbackStub = { get(): Promise<unknown> } & Partial<Disposable>;

export function itxLoopbackStub(exports: unknown, props: ItxEntrypointProps): ItxLoopbackStub {
  return itxEntrypointBinding(exports, itxEntrypointProps(props)) as unknown as ItxLoopbackStub;
}

/**
 * Shape helper for the `__describe()` convention (see `Description` in
 * ./describe.ts): fills the always-present fields so every node returns
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
      // Fixed first-party receiver; unlike connection families it is absent
      // from the public integration catalog.
      "posthog",
      "list",
      "getConnection",
      "startOAuthFlow",
      "completeConnect",
      "connectTelegram",
      "disconnect",
      "invokeCapability",
    ]),
  ],
]);

export function rejectBuiltinCollision(surfaceMembers: ReadonlySet<string>, path: string[]): void {
  const root = path[0];
  if (!root) return;
  if (isReservedDynamicPathSegment(root)) {
    throw new Error(`cannot provide capability "${root}": it is a reserved itx path segment`);
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
    throw new Error(`cannot provide capability "${root}": it is already on the itx surface`);
  }
}

/**
 * Builds the dotted-path fallback used by dynamic itx capabilities.
 *
 * Dynamic dotted fallback uses a function-backed proxy instead of a RpcTarget
 * instance: each missing property extends the path, and applying the function
 * performs one explicit invokeCapability({ path, args }) call.
 */
/**
 * Names common protocols LOOK UP on arbitrary objects and CALL if callable:
 * JSON.stringify (toJSON) and vitest/jest equality (asymmetricMatch). A
 * dynamic fallback answering them turns every stringify/assert of a
 * capability surface into a live invokeCapability dispatch — and the
 * asymmetricMatch case is worse than noise: vitest treats any object with a
 * callable asymmetricMatch as an asymmetric matcher, and a dispatcher
 * returning a (truthy) Promise makes the equality SPURIOUSLY PASS.
 *
 * Enforced BOTH at the prototype-chain hop and at every depth of the path
 * proxies it hands out (stringify probes callables too — the first fix
 * stopped at the hop and JSON.stringify(itx.someMount) still dispatched).
 * NOT in RESERVED_DYNAMIC_PATH_SEGMENTS, and the membership bar is HIGH,
 * because these names become unreachable as dotted capability segments
 * (explicit invokeCapability({ path }) still reaches them): only names that
 * are (a) probed-and-called by ubiquitous protocols AND (b) implausible as
 * capability/method names belong here. `inspect` fails (b) — blocking it
 * broke itx.agentProbe.inspect(...) in preview e2e; chai/loupe probing it
 * during error formatting is the accepted lesser evil.
 */
const PROTOCOL_PROBE_KEYS: ReadonlySet<string> = new Set(["toJSON", "asymmetricMatch"]);

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
      if (isReserved(key) || PROTOCOL_PROBE_KEYS.has(key)) return undefined;
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
      if (typeof key === "symbol" || isReserved(key) || PROTOCOL_PROBE_KEYS.has(key)) {
        return undefined;
      }
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
      return !isReserved(key) && !PROTOCOL_PROBE_KEYS.has(key);
    },
  });
}

/**
 * Install the dynamic-capability fallback on a class's PROTOTYPE CHAIN:
 * built-in members win through normal property lookup, and only missing
 * roots become dynamic capability paths — which lets a surface expose
 * concrete methods like `streams` while also supporting provided paths such
 * as `project.slack.chat.postMessage(...)`.
 *
 * KEY DESIGN IDEA: the RpcTarget with its known members sits *in front of*
 * the itx Durable Object. Built-ins resolve here in the isolate; only
 * unknown roots fall through to `invokeCapability` (the itx DO's dynamic
 * table). So `itx.streams.get(...)` never makes a round trip to the DO just
 * to check whether `streams` was shadowed. The deliberate trade-off: a
 * dynamic capability can never shadow a built-in name — the built-in always
 * wins.
 *
 * Why a prototype hop and not a Proxy AROUND the instance (the previous
 * design): workerd RPC classifies a call's RESULT for promise pipelining
 * with native brand checks that a JS Proxy can never pass
 * (`serializeJsValueWithPipeline` in workerd's worker-rpc.c++ → falls to
 * `NonPipelinable`; upstream: cloudflare/workerd#6873). So a surface
 * returned FROM A METHOD (`agents.get`, `capabilityHosts.get`,
 * `workers.get`, `projects.get`, `mcp.connect`, `openapi.connect`) must hand
 * back a REAL, unproxied instance or every pipelined call on it dies with
 * "The RPC receiver does not implement the method ...". This helper squares
 * that with dynamic dispatch by inserting one proxied hop BETWEEN
 * `Class.prototype` and its parent prototype:
 *
 *   instance ──proto──▶ Class.prototype ──proto──▶ Proxy(hop) ──proto──▶ parent
 *
 * - The instance is a genuine, natively-branded RpcTarget → workerd's
 *   pipeline classifier accepts it (SingleStub), so `x.get(p).method()`
 *   chains work in one expression.
 * - Declared members (own prototype methods/getters) resolve BEFORE the hop —
 *   built-ins always win, same precedence as the wrapper.
 * - Unknown string keys reach the hop's `get` trap and become dynamic
 *   capability path proxies, dispatched via `invokerFor(receiver)` — both
 *   workerd's traversal (`object.get` walks the prototype chain) and plain JS
 *   property lookup consult the trap.
 * - Instances stay clean of own properties, so Workers RPC's
 *   instance-property protection needs no `getOwnPropertyDescriptor` help.
 *
 * Call ONCE per class (the registry block at the bottom of rpc-targets.ts).
 * Constructor inheritance (`super()`) is untouched — only `Class.prototype`'s
 * parent link changes, and the hop forwards everything it doesn't intercept.
 *
 * DECISION RULE, recorded for future simplifiers: if/when workerd fixes the
 * pipeline classifier upstream (cloudflare/workerd#6873) so instance-wrapping
 * Proxies pipeline again, do NOT revert to constructor-returned Proxies —
 * they split identity (`this` !== what callers hold), trap EVERY property
 * get (the hop only traps misses), and remain hostage to native brand checks
 * elsewhere. The hop stays correct under either upstream resolution.
 *
 * KNOWN QUIRKS (accepted, by parity with the old wrapper or by design):
 * - No `has` trap: `"x" in instance` reflects DECLARED members only, while
 *   `instance.x` conjures a dispatcher — feature-detect with access, not `in`.
 * - `super.someUndeclaredName` inside these classes resolves through the hop
 *   like any other miss.
 * - A typo'd built-in (`itx.strems`) is a syntactically valid dynamic
 *   dispatch that fails at the capability table, not a crisp missing-method
 *   error — inherent to dynamic fallback, identical under the old wrapper.
 */
/** Prototypes that already carry a fallback hop (idempotence guard). */
const PROTOTYPE_FALLBACK_HOPS = new WeakSet<object>();

export function installPrototypeInvokeCapabilityFallback<
  T extends abstract new (...args: never[]) => object,
>(
  cls: T,
  options: {
    isReserved?: (segment: string) => boolean;
    /**
     * Derive the invokeCapability dispatcher from the instance the lookup
     * happened on. Defaults to the instance itself (which must then have
     * `invokeCapability`); surfaces that dispatch through their capability
     * host return it here.
     */
    invokerFor?: (instance: InstanceType<T>) => InvokeCapabilityTarget;
  } = {},
): void {
  const isReserved = options.isReserved ?? isReservedDynamicPathSegment;
  const invokerFor =
    options.invokerFor ?? ((instance) => instance as unknown as InvokeCapabilityTarget);
  // A second install is a programmer error: silently returning would discard
  // the second caller's options (a different invokerFor/isReserved) with no
  // trace, and stacking hops would double-dispatch. Module re-evaluation (test
  // runners, HMR) redefines the class and gets a fresh prototype, so this
  // only fires on a genuine duplicate call.
  if (PROTOTYPE_FALLBACK_HOPS.has(cls.prototype as object)) {
    throw new Error(
      `installPrototypeInvokeCapabilityFallback: ${cls.name} already has a fallback hop installed`,
    );
  }
  const parentPrototype = Object.getPrototypeOf(cls.prototype) as object;
  const hop = new Proxy(Object.create(parentPrototype) as object, {
    get(hopTarget, key, receiver) {
      // `then` must stay absent or every `await` of an instance would treat
      // it as a thenable and try to resolve it as a dynamic capability.
      if (key === "then") return undefined;
      // Symbols and anything the parent chain already answers (dispose
      // protocol, capnweb internals, Object.prototype) pass through with the
      // instance as receiver, exactly like an un-hopped lookup would.
      if (typeof key === "symbol" || key in hopTarget) {
        return Reflect.get(hopTarget, key, receiver);
      }
      if (isReserved(key) || PROTOCOL_PROBE_KEYS.has(key)) return undefined;
      // The dynamic fallback exists for INSTANCES. A lookup whose receiver is
      // not one — someone probing `Class.prototype.foo` directly, a framework
      // walking prototypes — must see plain "undefined", not conjure a
      // dispatcher over an uninitialized receiver (invokerFor would touch
      // instance state that does not exist there).
      if (!(receiver instanceof (cls as unknown as abstract new (...args: never[]) => object))) {
        return undefined;
      }
      // invokerFor resolves at CALL time, not trap time: the trap can fire
      // mid-construction (a property miss on `this` inside a base-class
      // constructor, before field initializers ran), and a dispatcher built
      // over half-initialized state must not be baked into the path proxy.
      return createInvokeCapabilityPathProxy(
        {
          invokeCapability: (call) =>
            invokerFor(receiver as InstanceType<T>).invokeCapability(call),
        },
        [key],
        isReserved,
      );
    },
  });
  Object.setPrototypeOf(cls.prototype, hop);
  PROTOTYPE_FALLBACK_HOPS.add(cls.prototype as object);
}

function isReservedDynamicPathSegment(segment: string): boolean {
  return RESERVED_DYNAMIC_PATH_SEGMENTS.has(segment);
}
