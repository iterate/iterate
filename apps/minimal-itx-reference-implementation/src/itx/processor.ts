// processor.ts — the durable ITX context core.
//
// An ITX context is the object-capability RPC surface of a hosting Durable
// Object. The host supplies its public surface by reference; user-provided
// capabilities are stored as a durable event-log fold. `ItxProcessor` is the
// small StreamProcessor that owns that fold plus the in-memory bridge for live
// stubs.
//
// This file also holds the small common vocabulary every itx implementation
// uses: capability-descriptor types, path matching, `retain`, and `replayPath`.
// The admin Root ITX (root.ts) reuses `replayPath` so the two surfaces cannot
// drift in how they resolve a dotted path.

import {
  StreamProcessor,
  type StreamProcessorConstructorArgs,
} from "@iterate-com/os/src/domains/streams/engine/stream-processor.ts";
import type {
  StreamEvent,
  StreamEventInput,
} from "@iterate-com/os/src/domains/streams/engine/shared/event.ts";
import type { DynamicWorkersRpcTarget } from "../domains/dynamic-workers/dynamic-workers-rpc-target.ts";
import type { DynamicWorkerRef } from "../domains/dynamic-workers/dynamic-worker-ref.ts";
import { hashString } from "../domains/dynamic-workers/dynamic-worker-loader.ts";
import {
  ItxContract,
  type CapabilityAddress,
  type CapabilityRecord,
} from "./processor-contract.ts";

type ItxProcessorIterateContext = {
  stream: {
    append(args: {
      streamPath?: string;
      event: StreamEventInput;
    }): StreamEvent | Promise<StreamEvent>;
    appendBatch(args: {
      streamPath?: string;
      events: StreamEventInput[];
    }): StreamEvent[] | Promise<StreamEvent[]>;
  };
};

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
  builtinCapabilities: CapabilityRecord[];
};

export type RunScriptResult = {
  completedEvent: StreamEvent;
  executionId: string;
  result: unknown;
};

type ScriptExecutionCompletedPayload = {
  error?: unknown;
  executionId: string;
  result?: unknown;
};

/**
 * The ITX RPC protocol. `ItxProcessor` implements this so browser clients,
 * scripts and dynamic workers all see the same five verbs.
 *
 * Every verb takes a single bag-of-props argument (no positional parameters) —
 * this is the one calling convention across the wire, the bridge, host surfaces
 * and codemode, so an adapter never has to translate between two shapes.
 */
export interface Itx {
  provideCapability(args: ProvideArgs): Promise<{ path: string[] }>;
  invokeCapability(args: { path: string[]; args?: unknown[] }): Promise<unknown>;
  revokeCapability(args: { path: string[] }): Promise<void>;
  runScript(args: { code: string }): Promise<RunScriptResult>;
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

const CAPABILITY_ADDRESS_TYPES = new Set(["worker-entrypoint", "durable-object"]);

function durableCapabilityAddress(capability: unknown): CapabilityAddress | null {
  if (!capability || typeof capability !== "object") return null;
  const type = (capability as Record<string, unknown>).type;
  if (typeof type !== "string") return null;
  if (!CAPABILITY_ADDRESS_TYPES.has(type)) {
    throw new Error(
      `unsupported capability address type "${type}" (public durable capabilities are worker-entrypoint or durable-object)`,
    );
  }
  return capability as CapabilityAddress;
}

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
 * calls this `retainLiveProvider`. ONE definition is reused by the bridge here.
 */
export function retain(target: unknown): unknown {
  if (
    target &&
    (typeof target === "object" || typeof target === "function") &&
    typeof (target as { dup?: unknown }).dup === "function"
  ) {
    return (target as { dup: () => unknown }).dup();
  }
  if (target && typeof target === "object") {
    const proto = Object.getPrototypeOf(target);
    if (proto !== Object.prototype && proto !== Array.prototype && proto !== null) return target;
    if (Array.isArray(target)) return target.map((value) => retain(value));
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(target)) out[k] = retain((target as Record<string, unknown>)[k]);
    return out;
  }
  return target;
}

function disposeLiveValue(target: unknown, seen = new Set<unknown>()) {
  if (!target || seen.has(target)) return;
  seen.add(target);
  try {
    if (
      (typeof target === "object" || typeof target === "function") &&
      typeof (target as { [Symbol.dispose]?: unknown })[Symbol.dispose] === "function"
    ) {
      (target as { [Symbol.dispose]: () => void })[Symbol.dispose]();
    }
  } catch {
    // Best-effort cleanup: releasing a stale live provider should never mask the
    // provide/revoke that made it stale. A later call will fail through normal
    // offline/no-capability paths if the provider is already gone.
  }
  if (typeof target === "object") {
    for (const value of Object.values(target)) disposeLiveValue(value, seen);
  }
}

/** Live RPC stubs are kept in Maps, so their array path needs a primitive map key. */
const liveRpcStubKey = (path: string[]): string => JSON.stringify(path);

/** Two capability paths are equal iff their segments match exactly. */
const samePath = (a: string[], b: string[]) =>
  a.length === b.length && a.every((seg, i) => seg === b[i]);

/**
 * Longest-registered-prefix wins, so a deep shadow (`slack.chat.postMessage`)
 * beats a broad mount (`slack`). Returns the winning record and the leftover
 * path segments to replay on it. ALL matching is on path ARRAYS — there is no
 * dotted-string key anywhere in resolution.
 */
export function resolveLongestPrefix<T extends { path: string[] }>(caps: T[], path: string[]) {
  let best: { record: T; rest: string[] } | null = null;
  for (const record of caps) {
    const matches =
      record.path.length <= path.length &&
      record.path.every((segment, index) => segment === path[index]);
    if (matches && (!best || record.path.length > best.record.path.length)) {
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
export async function replayPath({
  args,
  path,
  target,
}: {
  args: unknown[];
  path: string[];
  target: unknown;
}) {
  if (path.length === 0) return typeof target === "function" ? await target(...args) : target;
  let receiver = target;
  for (let i = 0; i < path.length - 1; i++) {
    if (!receiver || (typeof receiver !== "object" && typeof receiver !== "function")) {
      throw new Error(`capability path "${path.join(".")}" hit ${String(receiver)}`);
    }
    receiver = await (receiver as Record<string, unknown>)[path[i]];
    if (receiver == null) {
      throw new Error(`capability path "${path.join(".")}" hit ${String(receiver)}`);
    }
  }
  const method = path.at(-1)!;
  if (!receiver || (typeof receiver !== "object" && typeof receiver !== "function")) {
    throw new Error(`capability path "${path.join(".")}" hit ${String(receiver)}`);
  }
  const callable = (receiver as Record<string, unknown>)[method];
  if (typeof callable !== "function") {
    throw new Error(`capability path "${path.join(".")}" did not resolve to a function`);
  }
  return await (receiver as Record<string, (...args: unknown[]) => unknown>)[method](...args);
}

type LiveRpcStub = {
  dispose(): void;
  invoke(rest: string[], args: unknown[]): unknown;
};

const retainLiveRpcStub = (capability: unknown): LiveRpcStub => {
  const retained = retain(capability);
  const retainedInvoker = retained as {
    invokeCapability?: (input: { path: string[]; args: unknown[] }) => unknown;
  };
  const retainedInvokeCapability = retainedInvoker.invokeCapability;
  const invoke =
    !!capability &&
    typeof capability === "object" &&
    typeof (capability as { invokeCapability?: unknown }).invokeCapability === "function" &&
    typeof retainedInvokeCapability === "function"
      ? (rest: string[], args: unknown[]) => retainedInvokeCapability({ path: rest, args })
      : (path: string[], args: unknown[]) => replayPath({ args, path, target: retained });
  return {
    dispose: () => disposeLiveValue(retained),
    invoke,
  };
};

// ---------------------------------------------------------------------------
// The core: ItxProcessor.
// ---------------------------------------------------------------------------

export class ItxProcessor
  extends StreamProcessor<typeof ItxContract, object, ItxProcessorIterateContext>
  implements Itx
{
  readonly contract = ItxContract;

  // `this.state.capabilities` is the durable provided-capability table. Live
  // rows in that table (`address: null`) need a retained RPC stub in this
  // isolate; dynamic rows (`address` set) are resolved by the host on demand.
  #providedLiveCapabilityRpcStubs = new Map<string, LiveRpcStub>();
  #builtinLiveCapabilityRpcStubs = new Map<string, LiveRpcStub>();

  #dynamicWorkers: DynamicWorkersRpcTarget | null;

  // Built-in capabilities are code-provided, not folded state. They use the same
  // `CapabilityRecord` shape so invocation can search provided capabilities
  // first, then search these as fallback.
  #builtinCapabilities: CapabilityRecord[];
  constructor(
    args: StreamProcessorConstructorArgs<typeof ItxContract, object, ItxProcessorIterateContext> & {
      dynamicWorkers?: DynamicWorkersRpcTarget;
      builtinCapabilities?: ProvideArgs[];
    },
  ) {
    super(args);
    this.#dynamicWorkers = args.dynamicWorkers ?? null;
    this.#builtinCapabilities = (args.builtinCapabilities ?? []).map((b) => {
      const address = durableCapabilityAddress(b.capability);
      if (address === null) {
        const key = liveRpcStubKey(b.path);
        this.#builtinLiveCapabilityRpcStubs.get(key)?.dispose();
        this.#builtinLiveCapabilityRpcStubs.set(key, retainLiveRpcStub(b.capability));
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
        return {
          ...state,
          pendingScriptExecutions: {
            ...state.pendingScriptExecutions,
            [event.payload.executionId]: true,
          },
        };
      }
      case "events.iterate.com/itx/script-execution-completed": {
        const pendingScriptExecutions = { ...state.pendingScriptExecutions };
        delete pendingScriptExecutions[event.payload.executionId];
        return { ...state, pendingScriptExecutions };
      }
      default:
        return state;
    }
  }

  // A script-execution-requested event is executable work. Run detached because
  // the script's own ITX calls can append events that re-enter this processor.
  protected override processEvent({
    event,
    state,
    runInBackground,
  }: Parameters<StreamProcessor<typeof ItxContract>["processEvent"]>[0]): undefined {
    if (event.type !== "events.iterate.com/itx/script-execution-requested") return;
    if (state.pendingScriptExecutions[event.payload.executionId] !== true) return;
    runInBackground(() =>
      this.#executeRequestedScript({
        code: event.payload.code,
        executionId: event.payload.executionId,
      }),
    );
  }

  // provide = append an event. A live stub also lands in the in-memory bridge.
  // There is NO self-ingest: the event flows out to the stream and the stream's
  // subscription delivers it back into the fold. We then wait for that delivery
  // so the write is immediately readable (read-your-writes).
  async provideCapability({ path, capability, instructions, types }: ProvideArgs) {
    this.#assertUserCapabilityPath(path);
    const address = durableCapabilityAddress(capability);
    const key = liveRpcStubKey(path);
    this.#providedLiveCapabilityRpcStubs.get(key)?.dispose();
    if (address === null) {
      this.#providedLiveCapabilityRpcStubs.set(key, retainLiveRpcStub(capability));
    } else {
      this.#providedLiveCapabilityRpcStubs.delete(key);
    }
    const committed = await this.ctx.stream.append({
      event: {
        type: "events.iterate.com/itx/capability-provided",
        payload: { path, address, instructions, types },
      },
    });
    await this.waitUntilEvent({ offset: committed.offset });
    return { path };
  }

  async revokeCapability({ path }: { path: string[] }) {
    this.#assertUserCapabilityPath(path);
    const key = liveRpcStubKey(path);
    this.#providedLiveCapabilityRpcStubs.get(key)?.dispose();
    this.#providedLiveCapabilityRpcStubs.delete(key);
    const committed = await this.ctx.stream.append({
      event: { type: "events.iterate.com/itx/capability-revoked", payload: { path } },
    });
    await this.waitUntilEvent({ offset: committed.offset });
  }

  // describe() is the ONE read verb (there is no separate `list`). It hands back
  // the folded provided capabilities and constructor-injected builtin capabilities.
  async describe(): Promise<DescribeResult> {
    return {
      capabilities: this.state.capabilities,
      builtinCapabilities: this.#builtinCapabilities,
    };
  }

  async runScript({ code }: { code: string }): Promise<RunScriptResult> {
    const executionId = crypto.randomUUID();
    let completedEvent: StreamEvent | undefined;
    const completed = this.waitUntilEvent({
      predicate: (event) => {
        if (event.type !== "events.iterate.com/itx/script-execution-completed") return false;
        const payload = event.payload as ScriptExecutionCompletedPayload;
        if (payload.executionId !== executionId) return false;
        completedEvent = event;
        return true;
      },
    });
    await this.ctx.stream.append({
      event: {
        type: "events.iterate.com/itx/script-execution-requested",
        payload: { code, executionId },
      },
    });
    await completed;
    const event = completedEvent!;
    const payload = event.payload as ScriptExecutionCompletedPayload;
    if (payload.error !== undefined) {
      const error = new Error(String(payload.error));
      Object.assign(error, { completedEvent: event, executionId });
      throw error;
    }
    return { completedEvent: event, executionId, result: payload.result };
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

    const provided = resolveLongestPrefix(this.state.capabilities, path);
    if (provided) {
      return await this.#invokeCapabilityRecord(
        provided,
        this.#providedLiveCapabilityRpcStubs,
        args,
      );
    }

    const builtin = resolveLongestPrefix(this.#builtinCapabilities, path);
    if (builtin) {
      return await this.#invokeCapabilityRecord(builtin, this.#builtinLiveCapabilityRpcStubs, args);
    }

    throw new Error(`no capability "${path.join(".")}"`);
  }

  // Invoke a row after the winner has already been chosen. `record.address`
  // means durable dynamic code; `address: null` means a live RPC stub must still
  // be retained in this isolate.
  async #invokeCapabilityRecord(
    hit: { record: CapabilityRecord; rest: string[] },
    liveCapabilityRpcStubs: Map<string, LiveRpcStub>,
    args: unknown[],
  ) {
    const { record, rest } = hit;
    if (record.address) {
      const target = this.#resolveDynamicWorkerCapability(record.address, record.path);
      return await replayPath({ args, path: rest, target });
    }
    const liveRpcStub = liveCapabilityRpcStubs.get(liveRpcStubKey(record.path));
    if (!liveRpcStub) {
      throw new Error(
        `capability "${record.path.join(".")}" is offline (live provider disconnected)`,
      );
    }
    return await liveRpcStub.invoke(rest, args);
  }

  #assertUserCapabilityPath(path: string[]) {
    assertCapabilityPath(path);
    const control = path[0];
    if (control && ITX_CONTROL_NAMES.has(control)) {
      throw new Error(`reserved ITX control root "${control}" cannot be provided as a capability`);
    }
  }

  #resolveDynamicWorkerCapability(address: CapabilityAddress, capabilityPath: string[]): unknown {
    if (!this.#dynamicWorkers) {
      throw new Error("this context has no dynamic workers target configured");
    }
    return this.#dynamicWorkers.get(
      withCacheKey(address, `capability:${capabilityPath.join(".")}`),
    );
  }

  async #executeRequestedScript(args: { code: string; executionId: string }) {
    const appendCompleted = async (payload: Record<string, unknown>) => {
      await this.ctx.stream.append({
        event: {
          type: "events.iterate.com/itx/script-execution-completed",
          payload: { executionId: args.executionId, ...payload },
        },
      });
    };

    try {
      const script = this.#scriptWorkerRef(args.code);
      const worker = this.#requireDynamicWorkers().get(script) as { run(): Promise<unknown> };
      const result = await worker.run();
      await appendCompleted({ result });
    } catch (error: unknown) {
      await appendCompleted({ error: error instanceof Error ? error.message : String(error) });
    }
  }

  #scriptWorkerRef(code: string): DynamicWorkerRef {
    const source = `
      import { WorkerEntrypoint } from "cloudflare:workers";
      const fn = ${code};
      export class ScriptEntrypoint extends WorkerEntrypoint {
        async run() { return await fn(await this.env.ITX.get()); }
      }
    `;
    return {
      cacheKey: `script:${hashString(code)}`,
      entrypoint: "ScriptEntrypoint",
      source: {
        mainModule: "main.js",
        modules: { "main.js": source },
        type: "inline",
      },
      type: "worker-entrypoint",
    };
  }

  #requireDynamicWorkers(): DynamicWorkersRpcTarget {
    if (!this.#dynamicWorkers) {
      throw new Error("this context has no dynamic workers target configured");
    }
    return this.#dynamicWorkers;
  }
}

function withCacheKey(ref: CapabilityAddress, prefix: string): CapabilityAddress {
  return {
    ...ref,
    cacheKey: ref.cacheKey ? `${prefix}:${ref.cacheKey}` : prefix,
  };
}
