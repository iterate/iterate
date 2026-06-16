// itx.ts — the itx core. `ItxProcessor` IS a real StreamProcessor.
//
// `ItxProcessor extends StreamProcessor<ItxContract>` from the platform streams engine
// (apps/os/src/domains/streams/engine). We override exactly one pure method —
// `reduce` (the fold) — and add the verbs. Everything DURABLE (what names exist,
// each one's address) is the fold of the event log; the only non-durable state
// is the in-memory bridge of live stubs, which is precisely the live-vs-sturdy
// line drawn in running code.
//
// This file also holds the small shared vocabulary every itx implementation
// uses: the capability-descriptor types, path matching, `retain`, and
// `replayPath`. `GlobalItx` (global-itx.ts) reuses them so the two
// implementations of the protocol cannot drift in how they resolve a path.

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
 * bridge) or a sturdy `CapabilityAddress` (plain data — stored and re-dialed).
 */
export type ProvideArgs = {
  path: string[];
  capability: unknown;
  instructions?: string;
  types?: string;
};

/** What `describe()` returns: this context's folded capability table, its
 *  built-ins (which are not in the fold, so listed separately), and the parent
 *  context nested under `parentCapabilities` — recursively, up to the root. */
export type DescribeResult = {
  capabilities: CapabilityRecord[];
  builtins: CapabilityRecord[];
  scriptExecutions: ScriptExecutionRecord[];
  parentCapabilities?: DescribeResult;
};

/**
 * The itx context protocol. A served context AND a dialable parent both answer
 * it. `ItxProcessor` and `GlobalItx` each `implements` this, so the two
 * cannot drift apart: change one method's shape and the other stops compiling.
 *
 * Every verb takes a single bag-of-props argument (no positional parameters) —
 * this is the one calling convention across the wire, the bridge, the chain and
 * codemode, so an adapter never has to translate between two shapes.
 */
export interface ItxContext {
  provideCapability(args: ProvideArgs): Promise<{ path: string[] }>;
  invokeCapability(args: { path: string[]; args?: unknown[] }): Promise<unknown>;
  revokeCapability(args: { path: string[] }): Promise<void>;
  describe(): Promise<DescribeResult>;
}

// ---------------------------------------------------------------------------
// Shared vocabulary.
// ---------------------------------------------------------------------------

const CAPABILITY_ADDRESS_TYPES = new Set([
  "rpc",
  "dynamic-worker",
  "dynamic-durable-object",
  "durable-object",
]);

/** Structural live-vs-sturdy test: a sturdy provided capability is plain
 *  address data; anything else (a function, a nested object) is a live stub. */
export const isCapabilityAddress = (c: unknown): c is CapabilityAddress =>
  !!c &&
  typeof c === "object" &&
  typeof (c as { type?: unknown }).type === "string" &&
  CAPABILITY_ADDRESS_TYPES.has((c as { type: string }).type);

/** Project a live or sturdy `capability` into the `address` the table stores. */
const addressOf = (capability: unknown): CapabilityAddress | null =>
  isCapabilityAddress(capability) ? capability : null;

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
// This is intentionally detected only for live capabilities. Sturdy/durable
// capabilities already have an address and are resolved by the dialer.
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
  for (let i = 0; i < rest.length - 1; i++) receiver = receiver[rest[i]];
  return await receiver[rest.at(-1)!](...args);
}

// ---------------------------------------------------------------------------
// The core: ItxProcessor.
// ---------------------------------------------------------------------------

export class ItxProcessor extends StreamProcessor<typeof ItxContract> implements ItxContext {
  readonly contract = ItxContract;

  // The bridge: live stubs, keyed by the capability's path (via `bridgeKey`). In
  // memory, NOT durable — a live cap dies with its provider, which is exactly why
  // the fold records it with `address: null` while the real stub lives here. The
  // key is derived from the path ARRAY, the same way at every site, so the fold
  // and the bridge cannot disagree on what a capability is called.
  #liveCapabilities = new Map<string, any>();

  // Subset of `#liveCapabilities` whose mounted object is a path-call root.
  //
  // Why this has to be separate state:
  // - The durable capability table deliberately stores only `{ path, address }`.
  //   For live providers the address is `null`; the table says "there is a live
  //   capability mounted here", but it cannot hold the actual RPC stub or any
  //   non-serializable metadata about that stub.
  // - The bridge map holds the retained live stub, but invocation also needs to
  //   know HOW to replay the leftover path. Normal live objects use property
  //   replay (`stub.chat.postMessage(...)`). Path-call providers use
  //   `stub.invokeCapability({ path: ["chat", "postMessage"], args })`.
  // - We capture that replay mode at provide time, while we still have the
  //   original live object shape in hand, and key it by the same bridge key as
  //   `#liveCapabilities`.
  //
  // This set is intentionally in-memory. If the provider disconnects, both the
  // retained stub and this replay-mode bit disappear; the folded row remains as
  // `address: null`, so later calls correctly fail as "offline".
  #pathCallCapabilities = new Set<string>();

  // Injected dialer: a sturdy ADDRESS → a callable stub. ONE dialer serves both
  // a capability's sturdy address AND a parent context's address — they are the
  // same operation, "address → stub". Optional: a context with only live caps
  // and no parent never needs it. (Production splits this into a gated capability
  // dial and an ungated context dial for the auth boundary; the reference impl is
  // unauthed within a connection, so one dial. Auth lives at the connect door.)
  #dial: (address: any, mountPath?: string[]) => any;

  // Built-in capabilities, handed to the constructor instead of appended to the
  // log (e.g. a project context's `fetch`, backed by its Project DO). They arrive
  // as `ProvideArgs` but we normalize them at construction into the SAME
  // `CapabilityRecord` shape the fold produces — a live built-in's stub goes into
  // the same bridge a live provide uses. After that one step a built-in is
  // indistinguishable from a folded capability except for which list it lives in,
  // so resolution and describe() treat both identically. Own provides shadow a
  // built-in at the same path (own list is searched first). Changing built-ins is
  // a code change, not a log rewrite.
  #builtins: CapabilityRecord[];

  // The chain: an Itx is born with a PARENT address (an agent's parent is its
  // project; a project's is the __global__ root). On a capability MISS, resolution
  // falls through to the parent. The parent is a sturdy address — the same plain
  // data a capability uses — dialed by the same `#dial`. null when there is none.
  #parentAddress: any | null;

  constructor(
    args: ConstructorParameters<typeof StreamProcessor<typeof ItxContract>>[0] & {
      dial?: (address: any, mountPath?: string[]) => any;
      builtinCapabilities?: ProvideArgs[];
      parentAddress?: any;
    },
  ) {
    super(args);
    this.#dial =
      args.dial ??
      (() => {
        throw new Error("this context has no dial configured (no sturdy addresses or parent)");
      });
    // Normalize each built-in into a CapabilityRecord, stashing any live one's
    // stub in the bridge — exactly what provideCapability does for a live provide.
    this.#builtins = (args.builtinCapabilities ?? []).map((b) => {
      const address = addressOf(b.capability);
      if (address === null) {
        const key = bridgeKey(b.path);
        this.#liveCapabilities.set(key, retain(b.capability));
        // Built-ins can be live too. If a built-in is mounted as a path-call
        // root, record that replay mode beside the retained stub for the same
        // reason `provideCapability` does: the durable/builtin record only knows
        // the mount path and `address: null`, not whether the leftover path
        // should be property-replayed or passed through to `.invokeCapability`.
        if (isPathCallProvider(b.capability)) this.#pathCallCapabilities.add(key);
      }
      return {
        path: b.path,
        address,
        instructions: b.instructions ?? null,
        types: b.types ?? null,
      };
    });
    this.#parentAddress = args.parentAddress ?? null;
  }

  // The fold: one pure projection of an event into the next capability table.
  // Returning the same state for events we do not consume is the identity case
  // (the codemode bracket events fall through here — they are records, not state).
  protected override reduce(args: Parameters<StreamProcessor<typeof ItxContract>["reduce"]>[0]) {
    const { event, state } = args as { event: any; state: any };
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
                  status: "completed",
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
    const address = addressOf(capability);
    // dup at THIS layer too: the stub arrived as an argument to this call and is
    // disposed when the call returns; the bridge must keep its own retained copy.
    const key = bridgeKey(path);
    if (address === null) {
      this.#liveCapabilities.set(key, retain(capability));
      // Live provider, no sturdy address:
      //
      // The event we append below will contain `address: null`, so after replay
      // the folded table can only tell us that this path is backed by a live
      // provider. It cannot tell us whether that provider is a normal object
      // graph or an SDK-shaped path-call root.
      //
      // Capture the replay mode here, at the same time as we retain the stub.
      // This makes the three pieces line up by one key:
      // - fold row:       path exists, `address: null`
      // - live bridge:    path key -> retained live RPC stub
      // - path-call set:  path key is present only when leftover path goes to
      //                   `stub.invokeCapability({ path: rest, args })`
      if (isPathCallProvider(capability)) this.#pathCallCapabilities.add(key);
      else this.#pathCallCapabilities.delete(key);
    } else {
      // Sturdy capability. It is resolved by `#dial(address, ...)`, so any old
      // live-provider replay metadata at this mount must be cleared. This matters
      // when a path is first provided live and later replaced by a sturdy address.
      this.#pathCallCapabilities.delete(key);
    }
    const committed = await this.ctx.stream.append({
      event: {
        type: "events.iterate.com/itx/capability-provided",
        payload: { path, address, instructions, types },
      },
    });
    await this.#awaitDelivered((committed as any).offset);
    return { path };
  }

  async revokeCapability({ path }: { path: string[] }) {
    const key = bridgeKey(path);
    this.#liveCapabilities.delete(key);
    this.#pathCallCapabilities.delete(key);
    const committed = await this.ctx.stream.append({
      event: { type: "events.iterate.com/itx/capability-revoked", payload: { path } },
    });
    await this.#awaitDelivered((committed as any).offset);
  }

  // describe() is the ONE read verb (there is no separate `list`). It hands back
  // this context's RAW folded table, its constructor-injected `builtins`, and
  // nests the parent under `parentCapabilities` recursively to the root. Every
  // row — folded or built-in — is the same `CapabilityRecord` shape.
  async describe(): Promise<DescribeResult> {
    return {
      capabilities: this.state.capabilities,
      builtins: this.#builtins,
      scriptExecutions: this.state.scriptExecutions,
      ...(this.#parentAddress
        ? { parentCapabilities: await this.#dial(this.#parentAddress).describe() }
        : {}),
    };
  }

  // invoke is a precedence cascade: own fold → built-ins → parent → miss. The
  // first two are the same local lookup over two lists (own shadows a built-in
  // because it is tried first); the third re-dispatches the whole path UP the
  // chain, so a child shadows a parent by late binding (re-resolved per call),
  // not by copy.
  async invokeCapability({ path, args = [] }: { path: string[]; args?: unknown[] }) {
    const local =
      this.#resolveLocal(this.state.capabilities, path) ?? this.#resolveLocal(this.#builtins, path);
    if (local) return await local.invoke(args);
    if (this.#parentAddress) {
      return await this.#dial(this.#parentAddress).invokeCapability({ path, args });
    }
    throw new Error(`no capability "${path.join(".")}"`);
  }

  // Resolve a path against ONE capability list — the fold or the built-ins; the
  // constructor normalized built-ins to the same `CapabilityRecord` shape, so
  // both resolve identically. Returns a tiny invoker closure: normal/sturdy caps
  // use `replayPath(target, rest, args)`, while SDK-shaped live providers receive
  // the leftover path as data through `invokeCapability({ path: rest, args })`.
  // Returns null on no match, so `invokeCapability` falls through to the next
  // source in the cascade.
  #resolveLocal(
    caps: CapabilityRecord[],
    path: string[],
  ): { invoke: (args: unknown[]) => unknown } | null {
    const hit = resolveLongestPrefix(caps, path);
    if (!hit) return null;
    const { record, rest } = hit;
    if (record.address) {
      const target = this.#dial(record.address, record.path);
      return { invoke: (args) => replayPath(target, rest, args) };
    }
    const stub = this.#liveCapabilities.get(bridgeKey(record.path));
    if (!stub) {
      throw new Error(
        `capability "${record.path.join(".")}" is offline (live provider disconnected)`,
      );
    }
    if (this.#pathCallCapabilities.has(bridgeKey(record.path))) {
      // The mounted capability is not a nested object graph; it is a path-call
      // root. `rest` is therefore NOT replayed as properties on the stub. Instead
      // the unresolved suffix is sent directly to the provider as data:
      //
      //   mount: ["slack"]
      //   invoke: ["slack", "chat", "postMessage"], args: [{ text: "hi" }]
      //   provider receives: { path: ["chat", "postMessage"], args: [{...}] }
      //
      return {
        invoke: (args) => stub.invokeCapability({ path: rest, args }),
      };
    }
    return { invoke: (args) => replayPath(stub, rest, args) };
  }

  // Read-your-writes without self-ingest: after appending, wait for the stream's
  // subscription to deliver our own event back into the fold (the checkpoint
  // catches up to the appended offset). The stream is the single source of truth.
  //
  // TODO(deferred): this is a spin-poll on `checkpointOffset`. It works but is a
  // wart — replace with a proper "delivered to offset N" await once the streams
  // engine exposes one. Tracked as a known follow-up, not load-bearing design.
  async #awaitDelivered(offset: number): Promise<void> {
    for (let i = 0; i < 400 && this.checkpointOffset < offset; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  async waitUntilDelivered(offset: number): Promise<void> {
    await this.#awaitDelivered(offset);
  }
}
