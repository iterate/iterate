// itx.ts — the durable ITX context core.
//
// An ITX context is the object-capability RPC surface of a hosting Durable
// Object. The host supplies its public surface by reference; user-provided
// capabilities are stored as a durable event-log fold. `ItxProcessor` is the
// small StreamProcessor that owns that fold plus the in-memory bridge for live
// stubs.
//
// This file also holds the small common vocabulary every itx implementation
// uses: capability-descriptor types, path matching, `retain`, and `replayPath`.
// The admin Root ITX (root-itx.ts) reuses `replayPath` so the two surfaces cannot
// drift in how they resolve a dotted path.

import { StreamProcessor } from "@iterate-com/os/src/domains/streams/engine/stream-processor.ts";
import {
  ItxContract,
  type CapabilityAddress,
  type CapabilityRecord,
  type ScriptExecutionRecord,
} from "./contract.ts";

// ---------------------------------------------------------------------------
// The protocol every context answers, and the one capability-descriptor shape.
// ---------------------------------------------------------------------------

/**
 * The descriptor you pass to `provideCapability`, and the shape the constructor
 * takes for `builtinCapabilities`. A built-in is just a capability pre-provided
 * in code (handed to the constructor) instead of via an appended event.
 *
 * `capability` is either a live value (a function / nested object — held in the
 * bridge) or a dynamic `CapabilityAddress` (plain data — stored and resolved).
 */
export type ProvideArgs = {
  path: string[];
  capability: unknown;
  instructions?: string;
  types?: string;
};

/** What `describe()` returns: this context's folded capability table and its
 *  host-created built-ins. */
export type DescribeResult = {
  capabilities: CapabilityRecord[];
  builtins: CapabilityRecord[];
  scriptExecutions: ScriptExecutionRecord[];
};

/**
 * The itx context protocol. `ItxProcessor` `implements` this so every context
 * shares one shape.
 *
 * Every verb takes a single bag-of-props argument (no positional parameters) —
 * this is the one calling convention across the wire, the bridge, host surfaces
 * and codemode, so an adapter never has to translate between two shapes.
 */
export interface ItxContext {
  provideCapability(args: ProvideArgs): Promise<{ path: string[] }>;
  invokeCapability(args: { path: string[]; args?: unknown[] }): Promise<unknown>;
  revokeCapability(args: { path: string[] }): Promise<void>;
  runScript(args: { code: string }): Promise<unknown>;
  describe(): Promise<DescribeResult>;
}

// ---------------------------------------------------------------------------
// Shared vocabulary.
// ---------------------------------------------------------------------------

const ITX_CONTROL_NAMES = new Set([
  "provideCapability",
  "invokeCapability",
  "revokeCapability",
  "describe",
  "runScript",
]);

// Capability paths are also JavaScript property paths on the Cap'n Web surface:
// `itx.slack.chat.postMessage()` becomes
// `invokeCapability({ path: ["slack", "chat", "postMessage"], ... })`.
// Keep them boring. Empty paths have no root capability, non-identifiers cannot
// be called with dotted syntax, and prototype/RPC probe names would collide with
// the proxy/runtime rather than name a real capability.
const INVALID_PATH_SEGMENTS = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "then",
  "apply",
  "call",
  "bind",
  "dup",
  "onRpcBroken",
]);

export function assertCapabilityPath(path: string[]) {
  if (!Array.isArray(path) || path.length === 0) {
    throw new Error("capability path must contain at least one segment");
  }
  for (const segment of path) {
    if (
      typeof segment !== "string" ||
      !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment) ||
      INVALID_PATH_SEGMENTS.has(segment)
    ) {
      throw new Error(`invalid capability path segment "${String(segment)}"`);
    }
  }
}

const CAPABILITY_ADDRESS_TYPES = new Set(["dynamic-worker", "dynamic-durable-object"]);

const capabilityAddressType = (c: unknown): string | undefined => {
  if (!c || typeof c !== "object") return undefined;
  const type = (c as Record<string, unknown>).type;
  return typeof type === "string" ? type : undefined;
};

/** Structural live-vs-durable test: a dynamic address is durable provider data;
 *  anything else (a function, a nested object) is a live stub. */
export const isCapabilityAddress = (c: unknown): c is CapabilityAddress =>
  CAPABILITY_ADDRESS_TYPES.has(capabilityAddressType(c) ?? "");

// A live capability can be provided in two shapes:
//
// 1. A normal object graph, e.g. `{ chat: { postMessage() {} } }`. For this
//    shape, invoking `["slack", "chat", "postMessage"]` resolves the mounted
//    `slack` object and then replays `chat.postMessage(...args)` on it.
//
// 2. A path-call root, e.g. `{ invokeCapability({ path, args }) {} }`. This is
//    the compact SDK-provider shape: the provider does NOT expose every nested
//    member as a real object. Instead, ITX sends the unresolved suffix to
//    `invokeCapability`, so `["slack", "chat", "postMessage"]` becomes
//    `slack.invokeCapability({ path: ["chat", "postMessage"], args })`.
//
// This is intentionally detected only for live capabilities. Dynamic
// capabilities already have an address and are resolved by the host.
const isPathCallProvider = (
  capability: unknown,
): capability is { invokeCapability: (args: unknown) => unknown } =>
  !!capability &&
  typeof capability === "object" &&
  typeof (capability as { invokeCapability?: unknown }).invokeCapability === "function";

/**
 * Retain a live provider past the call that delivered it. Over Cap'n Web /
 * Workers RPC an argument stub is disposed when the call that received it
 * returns — so a live stub we intend to keep must be `dup()`'d to outlive that
 * call.
 *
 * Plain object providers are copied recursively because their own function
 * members may be RPC stubs that individually need retaining. Class-backed
 * providers and RpcTarget instances are NOT plain object graphs: their methods
 * usually live on the prototype, and copying own enumerable keys would erase the
 * public API into `{}`. Those are kept by identity unless the runtime exposes
 * `dup()`, in which case `dup()` is the stronger retain operation.
 *
 * In plain JS there is no `dup` and retaining is mostly identity. Production
 * calls this `retainLiveProvider`. ONE definition is reused by both the bridge
 * here and the serving edge in server.ts.
 */
export function retain(target: any): any {
  if (target && typeof target.dup === "function") return target.dup();
  if (target && typeof target === "object") {
    const proto = Object.getPrototypeOf(target);
    if (proto !== Object.prototype && proto !== Array.prototype && proto !== null) return target;
    const out: any = Array.isArray(target) ? [] : {};
    for (const k of Object.keys(target)) out[k] = retain(target[k]);
    return out;
  }
  return target;
}

function disposeLiveValue(target: any, seen = new Set<unknown>()) {
  if (!target || seen.has(target)) return;
  seen.add(target);
  try {
    target[Symbol.dispose]?.();
  } catch {
    // Best-effort cleanup: releasing a stale live provider should never mask the
    // provide/revoke that made it stale. A later call will fail through normal
    // offline/no-capability paths if the provider is already gone.
  }
  if (typeof target === "object") {
    for (const value of Object.values(target)) disposeLiveValue(value, seen);
  }
}

/** The bridge (live-stub map) is keyed by path. A Map needs a primitive key,
 *  so we derive one from the path ARRAY — `JSON.stringify` is unambiguous even
 *  if a segment contains the separator we'd otherwise pick. ONE definition, used
 *  at every set/get/delete site, so a live provide and its later invoke can
 *  never disagree on the key. */
const bridgeKey = (path: string[]): string => JSON.stringify(path);

/** Two capability paths are equal iff their segments match exactly. */
const samePath = (a: string[], b: string[]) =>
  a.length === b.length && a.every((seg, i) => seg === b[i]);

/** `prefix` is a prefix of `path` (so a cap mounted at `prefix` answers `path`). */
const isPrefixOf = (prefix: string[], path: string[]) =>
  prefix.length <= path.length && prefix.every((seg, i) => seg === path[i]);

/**
 * Longest-registered-prefix wins, so a deep shadow (`slack.chat.postMessage`)
 * beats a broad mount (`slack`). Returns the winning record and the leftover
 * path segments to replay on it. ALL matching is on path ARRAYS — there is no
 * dotted-string key anywhere in resolution.
 */
export function resolveLongestPrefix<T extends { path: string[] }>(caps: T[], path: string[]) {
  let best: { record: T; rest: string[] } | null = null;
  for (const record of caps) {
    if (isPrefixOf(record.path, path) && (!best || record.path.length > best.record.path.length)) {
      best = { record, rest: path.slice(record.path.length) };
    }
  }
  return best;
}

/**
 * Walk the leftover path segments on a resolved target, then call the leaf on
 * its receiver. `receiver[last](...args)` (not a detached `.apply`) matters: a
 * retained Cap'n Web member is a stub whose `.apply` is itself a path segment,
 * not a callable — the method must be invoked on its owning object.
 */
export async function replayPath(target: any, rest: string[], args: unknown[]) {
  if (rest.length === 0) return typeof target === "function" ? await target(...args) : target;
  let receiver = target;
  for (let i = 0; i < rest.length - 1; i++) {
    receiver = await receiver[rest[i]];
    if (receiver == null) {
      throw new Error(`capability path "${rest.join(".")}" hit ${String(receiver)}`);
    }
  }
  const method = rest.at(-1)!;
  if (typeof receiver?.[method] !== "function") {
    throw new Error(`capability path "${rest.join(".")}" did not resolve to a function`);
  }
  return await receiver[method](...args);
}

type LiveCapability = {
  dispose(): void;
  invoke(rest: string[], args: unknown[]): unknown;
};

const liveCapability = (capability: unknown): LiveCapability => {
  const retained = retain(capability);
  const invoke = isPathCallProvider(capability)
    ? (rest: string[], args: unknown[]) => retained.invokeCapability({ path: rest, args })
    : (rest: string[], args: unknown[]) => replayPath(retained, rest, args);
  return {
    dispose: () => disposeLiveValue(retained),
    invoke,
  };
};

// ---------------------------------------------------------------------------
// The core: ItxProcessor.
// ---------------------------------------------------------------------------

export class ItxProcessor extends StreamProcessor<typeof ItxContract> implements ItxContext {
  readonly contract = ItxContract;

  // Live capabilities are in-memory retained invokers keyed by mount path. The
  // durable fold stores only `address: null`; this map holds the actual callable
  // and whether the provider is member-replayed or path-called.
  #liveCapabilities = new Map<string, LiveCapability>();
  #builtinLiveCapabilities = new Map<string, LiveCapability>();

  // Injected resolver: dynamic capability address → callable stub.
  #resolveDynamicCapability: (address: CapabilityAddress) => any;
  #runScript: (args: { code: string }) => Promise<unknown>;

  // Built-in capabilities, handed to the constructor instead of appended to the
  // log (e.g. a project context's `egress`, backed by its Project DO). They arrive
  // as `ProvideArgs` but we normalize them at construction into the SAME
  // `CapabilityRecord` shape the fold produces — a live built-in's stub goes into
  // the same bridge a live provide uses. After that one step a built-in is
  // indistinguishable from a folded capability except for which list it lives in,
  // so resolution and describe() treat both identically. Own provides shadow a
  // built-in at the same path (own list is searched first). Changing built-ins is
  // a code change, not a log rewrite.
  #builtins: CapabilityRecord[];
  constructor(
    args: ConstructorParameters<typeof StreamProcessor<typeof ItxContract>>[0] & {
      resolveDynamicCapability?: (address: CapabilityAddress) => any;
      runScript?: (args: { code: string }) => Promise<unknown>;
      builtinCapabilities?: ProvideArgs[];
    },
  ) {
    super(args);
    this.#resolveDynamicCapability =
      args.resolveDynamicCapability ??
      (() => {
        throw new Error("this context has no resolver configured for dynamic addresses");
      });
    this.#runScript =
      args.runScript ??
      (() => {
        throw new Error("this context has no script runner configured");
      });
    // Normalize each built-in into a CapabilityRecord, stashing any live one's
    // stub in the bridge — exactly what provideCapability does for a live provide.
    this.#builtins = (args.builtinCapabilities ?? []).map((b) => {
      const address = isCapabilityAddress(b.capability) ? b.capability : null;
      if (address === null) {
        this.#setLiveCapability(this.#builtinLiveCapabilities, b.path, b.capability);
      }
      return {
        path: b.path,
        address,
        instructions: b.instructions ?? null,
        types: b.types ?? null,
      };
    });
  }

  // The fold: one pure projection of an event into the next capability table.
  // Returning the same state for events we do not consume is the identity case
  // (the codemode bracket events fall through here — they are records, not state).
  protected override reduce({
    event,
    state,
  }: Parameters<StreamProcessor<typeof ItxContract>["reduce"]>[0]) {
    switch (event.type) {
      case "events.iterate.com/itx/capability-provided": {
        const { path, address, instructions, types } = event.payload;
        const row: CapabilityRecord = {
          path,
          address: address ?? null,
          instructions: instructions ?? null,
          types: types ?? null,
        };
        // A provide at an existing path REPLACES that row in place; otherwise it
        // appends. The list is the capabilities in arrival order, deduped by path.
        const exists = state.capabilities.some((c: CapabilityRecord) => samePath(c.path, path));
        return {
          ...state,
          capabilities: exists
            ? state.capabilities.map((c: CapabilityRecord) => (samePath(c.path, path) ? row : c))
            : [...state.capabilities, row],
        };
      }
      case "events.iterate.com/itx/capability-revoked": {
        return {
          ...state,
          capabilities: state.capabilities.filter(
            (c: CapabilityRecord) => !samePath(c.path, event.payload.path),
          ),
        };
      }
      case "events.iterate.com/itx/script-execution-requested": {
        const { code, executionId } = event.payload;
        if (typeof executionId !== "string") return state;
        const row: ScriptExecutionRecord = {
          code: typeof code === "string" ? code : null,
          error: null,
          executionId,
          status: "requested",
        };
        const exists = state.scriptExecutions.some(
          (execution: ScriptExecutionRecord) => execution.executionId === executionId,
        );
        return {
          ...state,
          scriptExecutions: exists
            ? state.scriptExecutions.map((execution: ScriptExecutionRecord) =>
                execution.executionId === executionId ? row : execution,
              )
            : [...state.scriptExecutions, row],
        };
      }
      case "events.iterate.com/itx/script-execution-completed": {
        const { error, executionId, result } = event.payload;
        if (typeof executionId !== "string") return state;
        return {
          ...state,
          scriptExecutions: state.scriptExecutions.map((execution: ScriptExecutionRecord) =>
            execution.executionId === executionId
              ? {
                  ...execution,
                  error: typeof error === "string" ? error : null,
                  result,
                  status: "completed" as const,
                }
              : execution,
          ),
        };
      }
      default:
        return state;
    }
  }

  // provide = append an event. A live stub also lands in the in-memory bridge.
  // There is NO self-ingest: the event flows out to the stream and the stream's
  // subscription delivers it back into the fold. We then wait for that delivery
  // so the write is immediately readable (read-your-writes).
  async provideCapability({ path, capability, instructions, types }: ProvideArgs) {
    this.#assertUserCapabilityPath(path);
    const providedAddressType = capabilityAddressType(capability);
    if (providedAddressType && !CAPABILITY_ADDRESS_TYPES.has(providedAddressType)) {
      throw new Error(
        `unsupported capability address type "${providedAddressType}" (public durable capabilities are dynamic-worker or dynamic-durable-object)`,
      );
    }
    const address = isCapabilityAddress(capability) ? capability : null;
    if (address === null) {
      this.#setLiveCapability(this.#liveCapabilities, path, capability);
    } else {
      this.#deleteLiveCapability(this.#liveCapabilities, path);
    }
    const committed = await this.ctx.stream.append({
      event: {
        type: "events.iterate.com/itx/capability-provided",
        payload: { path, address, instructions, types },
      },
    });
    await this.waitUntilEvent({ offset: (committed as any).offset });
    return { path };
  }

  async revokeCapability({ path }: { path: string[] }) {
    this.#assertUserCapabilityPath(path);
    this.#deleteLiveCapability(this.#liveCapabilities, path);
    const committed = await this.ctx.stream.append({
      event: { type: "events.iterate.com/itx/capability-revoked", payload: { path } },
    });
    await this.waitUntilEvent({ offset: (committed as any).offset });
  }

  // describe() is the ONE read verb (there is no separate `list`). It hands back
  // this context's RAW folded table and its constructor-injected `builtins`.
  // Every row — folded or built-in — is the same `CapabilityRecord` shape.
  async describe(): Promise<DescribeResult> {
    return {
      capabilities: this.state.capabilities,
      builtins: this.#builtins,
      scriptExecutions: this.state.scriptExecutions,
    };
  }

  async runScript(args: { code: string }): Promise<unknown> {
    return await this.#runScript(args);
  }

  // Every dotted Cap'n Web call arrives as invokeCapability({ path, args }).
  // Single-segment root paths that name the ITX control surface are handled here
  // first, so pathInvokerToProxy does not need to know those names. They are reserved:
  // users cannot mount or shadow capabilities under them.
  async invokeCapability({
    path,
    args = [],
  }: {
    path: string[];
    args?: unknown[];
  }): Promise<unknown> {
    assertCapabilityPath(path);
    const control = path[0];
    if (control && ITX_CONTROL_NAMES.has(control)) {
      if (path.length !== 1) throw new Error(`reserved ITX control path "${control}"`);
      switch (control) {
        case "provideCapability":
          return await this.provideCapability(args[0] as ProvideArgs);
        case "invokeCapability":
          return await this.invokeCapability(args[0] as { path: string[]; args?: unknown[] });
        case "revokeCapability":
          return await this.revokeCapability(args[0] as { path: string[] });
        case "describe":
          return await this.describe();
        case "runScript":
          return await this.runScript(args[0] as { code: string });
      }
    }

    const local =
      this.#resolveLocal(this.state.capabilities, path, this.#liveCapabilities) ??
      this.#resolveLocal(this.#builtins, path, this.#builtinLiveCapabilities);
    if (local) return await local(args);

    throw new Error(`no capability "${path.join(".")}"`);
  }

  // Resolve one capability list — folded rows or built-ins. Dynamic rows are
  // resolved and property-replayed; live rows use their retained invoker.
  #resolveLocal(
    caps: CapabilityRecord[],
    path: string[],
    liveCapabilities: Map<string, LiveCapability>,
  ): ((args: unknown[]) => unknown) | null {
    const hit = resolveLongestPrefix(caps, path);
    if (!hit) return null;
    const { record, rest } = hit;
    if (record.address) {
      // Dynamic Durable Object facets need the mount path in their facet
      // identity, so replacing/reproviding the same dynamic DO at a different
      // path gets distinct storage. The mount path is host-owned metadata, not
      // provider-facing address vocabulary, so attach it here immediately before
      // resolving instead of storing it in the folded capability row.
      const address =
        record.address.type === "dynamic-durable-object"
          ? { ...record.address, mountPath: record.path }
          : record.address;
      const target = this.#resolveDynamicCapability(address);
      return (args) => replayPath(target, rest, args);
    }
    const target = liveCapabilities.get(bridgeKey(record.path));
    if (!target) {
      throw new Error(
        `capability "${record.path.join(".")}" is offline (live provider disconnected)`,
      );
    }
    return (args) => target.invoke(rest, args);
  }

  #assertUserCapabilityPath(path: string[]) {
    assertCapabilityPath(path);
    const control = path[0];
    if (control && ITX_CONTROL_NAMES.has(control)) {
      throw new Error(`reserved ITX control root "${control}" cannot be provided as a capability`);
    }
  }

  #setLiveCapability(
    liveCapabilities: Map<string, LiveCapability>,
    path: string[],
    capability: unknown,
  ) {
    const key = bridgeKey(path);
    liveCapabilities.get(key)?.dispose();
    liveCapabilities.set(key, liveCapability(capability));
  }

  #deleteLiveCapability(liveCapabilities: Map<string, LiveCapability>, path: string[]) {
    const key = bridgeKey(path);
    liveCapabilities.get(key)?.dispose();
    liveCapabilities.delete(key);
  }
}
