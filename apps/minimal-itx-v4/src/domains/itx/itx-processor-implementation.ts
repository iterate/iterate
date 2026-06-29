import {
  StreamProcessor,
  type StreamProcessorConstructorArgs,
} from "../streams/engine/stream-processor.ts";
import { normalizePath } from "../durable-object-names.ts";
import type { StreamEvent } from "../streams/types.ts";
import { hashString } from "../workers/worker-loader.ts";
import { WorkerRef as WorkerRefSchema } from "../workers/schemas.ts";
import type { JsonValue, WorkerRef } from "../workers/types.ts";
import type { WorkerRunner } from "../workers/worker-runner.ts";
import { retainLiveCapabilityProvider, type LiveCapability } from "./live-capability.ts";
import { ItxProcessorContract, type CapabilityRecord } from "./itx-processor-contract.ts";
import type { ItxCapabilityHost } from "./types.ts";

export type ProvideCapabilityInput = Parameters<ItxCapabilityHost["provideCapability"]>[0];
export type RunScriptResult = Awaited<ReturnType<ItxCapabilityHost["runScript"]>>;

type CompletedPayload = {
  error?: string;
  executionId: string;
  result?: JsonValue;
};
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

function assertCapabilityPath(path: string[]) {
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

function json(value: unknown): JsonValue {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as JsonValue;
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

export class ItxProcessor extends StreamProcessor<typeof ItxProcessorContract> {
  readonly contract = ItxProcessorContract;
  #path: string;
  #workerRunner: WorkerRunner;
  #liveCapabilities = new Map<string, LiveCapability>();

  constructor(
    args: StreamProcessorConstructorArgs<typeof ItxProcessorContract, object> & {
      path: string;
      workerRunner: WorkerRunner;
    },
  ) {
    super(args);
    this.#path = normalizePath(args.path);
    this.#workerRunner = args.workerRunner;
  }

  protected override reduce({
    event,
    state,
  }: Parameters<StreamProcessor<typeof ItxProcessorContract>["reduce"]>[0]) {
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
  }: Parameters<StreamProcessor<typeof ItxProcessorContract>["processEvent"]>[0]): undefined {
    if (event.type !== "events.iterate.com/itx/script-execution-requested") return;
    if (state.pendingScriptExecutions[event.payload.executionId] !== true) return;
    runInBackground(() =>
      this.#executeScript({ code: event.payload.code, executionId: event.payload.executionId }),
    );
  }

  async provideCapability({ capability, path }: ProvideCapabilityInput) {
    assertCapabilityPath(path);
    const key = liveKey(path);
    const previousLive = this.#liveCapabilities.get(key);
    let record: CapabilityRecord;
    if (capability.type === "worker") {
      const workerRef = WorkerRefSchema.parse(capability.workerRef);
      await this.#workerRunner.validate(workerRef);
      record = {
        path,
        type: "worker",
        workerRef,
      };
    } else {
      record = { path, type: "live" };
    }
    const nextLive =
      capability.type === "live" ? retainLiveCapabilityProvider(capability.target) : undefined;

    let committedOffset: number;
    try {
      const [committed] = await this.stream.append({
        type: "events.iterate.com/itx/capability-provided",
        payload: record,
      });
      committedOffset = committed.offset;
    } catch (error) {
      nextLive?.dispose();
      throw error;
    }

    // The append is the durable commit point. From here on, keep the ephemeral
    // live-provider map aligned with the record that will fold from the stream.
    if (nextLive === undefined) {
      this.#liveCapabilities.delete(key);
    } else {
      this.#liveCapabilities.set(key, nextLive);
    }
    previousLive?.dispose();

    await this.waitUntilEvent({ offset: committedOffset });
    return { path };
  }

  async revokeCapability({ path }: { path: string[] }) {
    assertCapabilityPath(path);
    const key = liveKey(path);
    const previousLive = this.#liveCapabilities.get(key);
    const [committed] = await this.stream.append({
      type: "events.iterate.com/itx/capability-revoked",
      payload: { path },
    });
    this.#liveCapabilities.delete(key);
    previousLive?.dispose();
    await this.waitUntilEvent({ offset: committed.offset });
  }

  async invokeCapability({ args = [], path }: { args?: unknown[]; path: string[] }) {
    assertCapabilityPath(path);
    const hit = resolveLongestPrefix(this.state.capabilities, path);
    if (!hit) throw new Error(`no capability "${path.join(".")}"`);
    if (hit.record.type === "worker") {
      return await this.#workerRunner.invokeCapability({
        args,
        path: hit.rest,
        ref: hit.record.workerRef,
      });
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
      type: "events.iterate.com/itx/script-execution-requested",
      payload: { code, executionId },
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
      const completionPayload: JsonValue =
        payload.error !== undefined
          ? { error: payload.error, executionId: input.executionId }
          : {
              executionId: input.executionId,
              result: "result" in payload ? json(payload.result) : null,
            };
      return this.stream.append({
        type: "events.iterate.com/itx/script-execution-completed",
        payload: completionPayload,
      });
    };

    try {
      const worker = await this.#workerRunner.get<{ run(): Promise<unknown> }>(
        this.#scriptWorkerRef(input.code),
      );
      const result = await worker.run();
      await complete({ result });
    } catch (error) {
      await complete({ error: error instanceof Error ? error.message : String(error) });
    }
  }

  #scriptWorkerRef(code: string): WorkerRef {
    const source = `
      import { WorkerEntrypoint } from "cloudflare:workers";
      const fn = ${code};
      export class ScriptEntrypoint extends WorkerEntrypoint {
        async run() {
          const itx = await this.env.ITX.get();
          return await fn(itx);
        }
      }
    `;
    return {
      path: this.#path,
      source: {
        mainModule: "main.js",
        modules: { "main.js": source },
        type: "inline",
      },
      entrypoint: "ScriptEntrypoint",
      props: { scriptHash: hashString(code) },
      type: "stateless",
    };
  }
}
