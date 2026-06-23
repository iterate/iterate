import {
  StreamProcessor,
  type StreamProcessorConstructorArgs,
} from "../domains/streams/engine/stream-processor.ts";
import type { DynamicWorkersRpcTarget } from "../domains/dynamic-workers/dynamic-workers-rpc-target.ts";
import { hashString } from "../domains/dynamic-workers/dynamic-worker-loader.ts";
import { DynamicWorkerRef as DynamicWorkerRefSchema } from "../domains/dynamic-workers/dynamic-worker-ref.ts";
import type {
  DynamicWorkerRef,
  ItxCapabilityHost,
  JsonSerializableTrustMeBro,
  StreamEvent,
} from "../../types-and-schemas.ts";
import { ItxContract, type CapabilityRecord } from "./processor-contract.ts";

export type ProvideCapabilityInput = Parameters<ItxCapabilityHost["provideCapability"]>[0];
export type RunScriptResult = ReturnType<ItxCapabilityHost["runScript"]>;

export type ItxProcessorRpc = {
  invokeCapability(input: { args?: unknown[]; path: string[] }): unknown;
  provideCapability(
    input: ProvideCapabilityInput,
  ): { path: string[] } | Promise<{ path: string[] }>;
  revokeCapability(input: { path: string[] }): void | Promise<void>;
  runScript(code: string): RunScriptResult | Promise<RunScriptResult>;
};

type CompletedPayload = {
  error?: string;
  executionId: string;
  result?: JsonSerializableTrustMeBro;
};
type ScriptRunner = { run(): Promise<unknown> };
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

const samePath = (a: string[], b: string[]) =>
  a.length === b.length && a.every((segment, index) => segment === b[index]);

const liveKey = (path: string[]) => JSON.stringify(path);

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

function json(value: unknown): JsonSerializableTrustMeBro {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as JsonSerializableTrustMeBro;
}

function retain(target: unknown): unknown {
  if (
    target &&
    (typeof target === "object" || typeof target === "function") &&
    typeof (target as { dup?: unknown }).dup === "function"
  ) {
    return (target as { dup: () => unknown }).dup();
  }
  if (Array.isArray(target)) return target.map(retain);
  if (target && typeof target === "object" && Object.getPrototypeOf(target) === Object.prototype) {
    return Object.fromEntries(Object.entries(target).map(([key, value]) => [key, retain(value)]));
  }
  return target;
}

function dispose(target: unknown) {
  if (
    target &&
    (typeof target === "object" || typeof target === "function") &&
    typeof (target as { [Symbol.dispose]?: unknown })[Symbol.dispose] === "function"
  ) {
    (target as { [Symbol.dispose]: () => void })[Symbol.dispose]();
  }
  if (Array.isArray(target)) {
    for (const value of target) dispose(value);
  } else if (target && typeof target === "object") {
    for (const value of Object.values(target)) dispose(value);
  }
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
  if (path.length === 0) return typeof target === "function" ? await target(...args) : target;
  let receiver = await target;
  for (let i = 0; i < path.length - 1; i++) {
    if (!receiver || (typeof receiver !== "object" && typeof receiver !== "function")) {
      throw new Error(`capability path "${path.join(".")}" hit ${String(receiver)}`);
    }
    receiver = await Reflect.get(receiver, path[i]);
  }
  const method = path.at(-1)!;
  if (!receiver || (typeof receiver !== "object" && typeof receiver !== "function")) {
    throw new Error(`capability path "${path.join(".")}" hit ${String(receiver)}`);
  }
  const callable = Reflect.get(receiver, method);
  if (typeof callable !== "function") {
    throw new Error(`capability path "${path.join(".")}" did not resolve to a function`);
  }
  return await Reflect.apply(callable, receiver, args);
}

function resolveLongestPrefix(records: CapabilityRecord[], path: string[]) {
  let best: { record: CapabilityRecord; rest: string[] } | null = null;
  for (const record of records) {
    const matches =
      record.path.length <= path.length &&
      record.path.every((segment, index) => segment === path[index]);
    if (matches && (!best || record.path.length > best.record.path.length)) {
      best = { record, rest: path.slice(record.path.length) };
    }
  }
  return best;
}

type LiveCapability = {
  dispose(): void;
  invoke(path: string[], args: unknown[]): unknown;
};

function retainLiveCapability(capability: unknown): LiveCapability {
  const retained = retain(capability);
  const invoker = retained as {
    invokeCapability?: (input: { args?: unknown[]; path: string[] }) => unknown;
  };
  return {
    dispose: () => dispose(retained),
    invoke: (path, args) =>
      typeof invoker.invokeCapability === "function"
        ? invoker.invokeCapability({ path, args })
        : replayPath({ args, path, target: retained }),
  };
}

export class ItxProcessor extends StreamProcessor<typeof ItxContract> implements ItxProcessorRpc {
  readonly contract = ItxContract;
  #dynamicWorkers: DynamicWorkersRpcTarget;
  #liveCapabilities = new Map<string, LiveCapability>();

  constructor(
    args: StreamProcessorConstructorArgs<typeof ItxContract, object> & {
      dynamicWorkers: DynamicWorkersRpcTarget;
    },
  ) {
    super(args);
    this.#dynamicWorkers = args.dynamicWorkers;
  }

  protected override reduce({
    event,
    state,
  }: Parameters<StreamProcessor<typeof ItxContract>["reduce"]>[0]) {
    switch (event.type) {
      case "events.iterate.com/itx/capability-provided": {
        const row = event.payload;
        const exists = state.capabilities.some((capability) => samePath(capability.path, row.path));
        return {
          ...state,
          capabilities: exists
            ? state.capabilities.map((capability) =>
                samePath(capability.path, row.path) ? row : capability,
              )
            : [...state.capabilities, row],
        };
      }
      case "events.iterate.com/itx/capability-revoked":
        return {
          ...state,
          capabilities: state.capabilities.filter(
            (capability) => !samePath(capability.path, event.payload.path),
          ),
        };
      case "events.iterate.com/itx/script-execution-requested":
        return {
          ...state,
          pendingScriptExecutions: {
            ...state.pendingScriptExecutions,
            [event.payload.executionId]: true,
          },
        };
      case "events.iterate.com/itx/script-execution-completed": {
        const pendingScriptExecutions = { ...state.pendingScriptExecutions };
        delete pendingScriptExecutions[event.payload.executionId];
        return { ...state, pendingScriptExecutions };
      }
      default:
        return state;
    }
  }

  protected override processEvent({
    event,
    runInBackground,
    state,
  }: Parameters<StreamProcessor<typeof ItxContract>["processEvent"]>[0]): undefined {
    if (event.type !== "events.iterate.com/itx/script-execution-requested") return;
    if (state.pendingScriptExecutions[event.payload.executionId] !== true) return;
    runInBackground(() =>
      this.#executeScript({ code: event.payload.code, executionId: event.payload.executionId }),
    );
  }

  async provideCapability({ capability, path }: ProvideCapabilityInput) {
    assertCapabilityPath(path);
    const key = liveKey(path);
    this.#liveCapabilities.get(key)?.dispose();
    const record: CapabilityRecord =
      capability.type === "dynamic-worker"
        ? {
            path,
            type: "dynamic-worker",
            workerRef: DynamicWorkerRefSchema.parse(capability.workerRef),
          }
        : { path, type: "live" };

    if (capability.type === "dynamic-worker") {
      this.#liveCapabilities.delete(key);
    } else {
      this.#liveCapabilities.set(key, retainLiveCapability(capability.target));
    }
    const committed = await this.stream.append({
      event: { type: "events.iterate.com/itx/capability-provided", payload: record },
    });
    await this.waitUntilEvent({ offset: committed.offset });
    return { path };
  }

  async revokeCapability({ path }: { path: string[] }) {
    assertCapabilityPath(path);
    const key = liveKey(path);
    this.#liveCapabilities.get(key)?.dispose();
    this.#liveCapabilities.delete(key);
    const committed = await this.stream.append({
      event: { type: "events.iterate.com/itx/capability-revoked", payload: { path } },
    });
    await this.waitUntilEvent({ offset: committed.offset });
  }

  async invokeCapability({ args = [], path }: { args?: unknown[]; path: string[] }) {
    assertCapabilityPath(path);
    const hit = resolveLongestPrefix(this.state.capabilities, path);
    if (!hit) throw new Error(`no capability "${path.join(".")}"`);
    if (hit.record.type === "dynamic-worker") {
      const target = this.#dynamicWorkers.get(
        withCacheKey(hit.record.workerRef, `capability:${hit.record.path.join(".")}`),
      );
      return await replayPath({ args, path: hit.rest, target });
    }
    const live = this.#liveCapabilities.get(liveKey(hit.record.path));
    if (!live) {
      throw new Error(`capability "${hit.record.path.join(".")}" is offline`);
    }
    return await live.invoke(hit.rest, args);
  }

  async runScript(code: string): Promise<RunScriptResult> {
    const executionId = crypto.randomUUID();
    const completed = this.#waitForScriptCompletion(executionId);
    await this.stream.append({
      event: {
        type: "events.iterate.com/itx/script-execution-requested",
        payload: { code, executionId },
      },
    });
    const event = await completed;
    const payload = event.payload as CompletedPayload;
    if (payload.error !== undefined) throw new Error(String(payload.error));
    return { completedEvent: event, executionId, result: payload.result ?? null };
  }

  async #waitForScriptCompletion(executionId: string) {
    let completed: StreamEvent | undefined;
    await this.waitUntilEvent({
      predicate: (event) => {
        if (event.type !== "events.iterate.com/itx/script-execution-completed") return false;
        const payload = event.payload as CompletedPayload;
        if (payload.executionId !== executionId) return false;
        completed = event as StreamEvent;
        return true;
      },
    });
    if (!completed) throw new Error(`script execution "${executionId}" completed without an event`);
    return completed;
  }

  async #executeScript(input: { code: string; executionId: string }) {
    const complete = (payload: { error?: string; result?: unknown }) => {
      const completionPayload: JsonSerializableTrustMeBro =
        payload.error !== undefined
          ? { error: payload.error, executionId: input.executionId }
          : {
              executionId: input.executionId,
              result: "result" in payload ? json(payload.result) : null,
            };
      return this.stream.append({
        event: {
          type: "events.iterate.com/itx/script-execution-completed",
          payload: completionPayload,
        },
      });
    };

    try {
      const worker = await this.#dynamicWorkers.get<ScriptRunner>(
        this.#scriptWorkerRef(input.code),
      );
      const result = await worker.run();
      await complete({ result });
    } catch (error) {
      await complete({ error: error instanceof Error ? error.message : String(error) });
    }
  }

  #scriptWorkerRef(code: string): DynamicWorkerRef {
    const source = `
      import { WorkerEntrypoint } from "cloudflare:workers";
      const fn = ${code};
      export class ScriptEntrypoint extends WorkerEntrypoint {
        async run() { return await fn(await this.env.ITX.authenticate()); }
      }
    `;
    return {
      cacheKey: `script:${hashString(code)}`,
      source: {
        mainModule: "main.js",
        modules: { "main.js": source },
        type: "inline",
      },
      target: {
        entrypoint: "ScriptEntrypoint",
        type: "worker-entrypoint",
      },
    };
  }
}

function withCacheKey(address: DynamicWorkerRef, prefix: string): DynamicWorkerRef {
  return { ...address, cacheKey: address.cacheKey ? `${prefix}:${address.cacheKey}` : prefix };
}
