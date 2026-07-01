import {
  StreamProcessor,
  type StreamProcessorConstructorArgs,
} from "../streams/stream-processor.ts";
import { normalizePath } from "../durable-object-names.ts";
import type {
  CapabilityProvidedPayload,
  CapabilityDescription,
  CapabilityRecord,
  ItxCapabilityHost,
  JsonValue,
  Itx,
  RevokeCapabilityInput,
  StatelessDynamicWorkerRef,
  StreamEvent,
} from "../../types.ts";
import { sha256Hex } from "../workers/utils.ts";
import type { DynamicWorkerRunner } from "../workers/worker-runner.ts";
import { retainLiveCapabilityProvider, type LiveCapability } from "./live-capability.ts";
import { ItxProcessorContract } from "./itx-processor-contract.ts";
import {
  evaluateItxExpression,
  invokeNormalizedCapability,
  normalizeCapabilityProvider,
} from "./itx-expression.ts";

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

/**
 * The enclosing itx scope, as seen from a child scope's processor.
 *
 * Only the two read operations chain upward (see the class below); mounting is
 * always local, so `provide`/`revoke` are deliberately absent here. In practice
 * this is a `DurableObjectStub<ItxDurableObject>` for the parent scope, but the
 * processor only depends on these two methods.
 */
export type ParentItxScope = {
  invokeCapability(input: { args?: unknown[]; path: string[] }): Promise<unknown>;
  describeCapabilities(): Promise<CapabilityDescription[]>;
};

export class ItxProcessor extends StreamProcessor<typeof ItxProcessorContract> {
  readonly contract = ItxProcessorContract;
  #itx: Itx;
  #path: string;
  #workerRunner: DynamicWorkerRunner;
  #parent: ParentItxScope | undefined;
  #liveCapabilities = new Map<string, LiveCapability>();

  constructor(
    args: StreamProcessorConstructorArgs<typeof ItxProcessorContract, object> & {
      itx: Itx;
      path: string;
      workerRunner: DynamicWorkerRunner;
      // The enclosing scope, or undefined at the project root ("/"). Present for
      // every nested scope (agents, sub-agents, agent namespaces) so capability
      // lookups that miss locally can fall through to the surrounding scope.
      parent?: ParentItxScope;
    },
  ) {
    super(args);
    this.#itx = args.itx;
    this.#path = normalizePath(args.path);
    this.#workerRunner = args.workerRunner;
    this.#parent = args.parent;
  }

  protected override reduce({
    event,
    state,
  }: Parameters<StreamProcessor<typeof ItxProcessorContract>["reduce"]>[0]) {
    switch (event.type) {
      case "events.iterate.com/itx/capability-provided": {
        const row: CapabilityRecord = {
          ...event.payload,
          // The stream offset is the provision identity. It is stable,
          // observable, and already exists because the append event is the
          // commit point for a mount. Handles use it to revoke exactly the
          // mount they received, without introducing a second generated id.
          providedAtOffset: event.offset,
        };
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
      case "events.iterate.com/itx/capability-revoked": {
        const revoke = event.payload;
        return {
          ...state,
          capabilities: state.capabilities.filter((capability) => {
            if (!samePath(capability.path, revoke.path)) return true;
            return (
              revoke.providedAtOffset !== undefined &&
              capability.providedAtOffset !== revoke.providedAtOffset
            );
          }),
        };
      }
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

  async provideCapability(input: ProvideCapabilityInput) {
    const { path } = input;
    assertCapabilityPath(path);
    const key = liveKey(path);
    const previousLive = this.#liveCapabilities.get(key);
    let record: CapabilityProvidedPayload;
    let nextLiveInput: { flattenNestedPath: boolean; target: unknown } | undefined;
    if (input.type === "live") {
      if (!Object.hasOwn(input, "capability")) {
        throw new Error('live capabilities require "capability"');
      }
      const flattenNestedPath = input.flattenNestedPaths === true;
      record = {
        flattenNestedPaths: flattenNestedPath ? true : undefined,
        instructions: input.instructions,
        path,
        type: "live",
        types: input.types,
      };
      nextLiveInput = {
        flattenNestedPath,
        target: input.capability,
      };
    } else if (input.type === "itx-expression") {
      assertExpressionDoesNotReferenceOwnMount(input);
      record = {
        expression: input.expression,
        flattenNestedPaths: input.flattenNestedPaths === true ? true : undefined,
        instructions: input.instructions,
        path,
        type: "itx-expression",
        types: input.types,
      };
    } else {
      input satisfies never;
      throw new Error(`unsupported capability input ${(input as { type?: unknown }).type}`);
    }
    const nextLive =
      nextLiveInput !== undefined
        ? retainLiveCapabilityProvider(nextLiveInput.target, {
            flattenNestedPath: nextLiveInput.flattenNestedPath,
          })
        : undefined;

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
    return { path, providedAtOffset: committedOffset };
  }

  async revokeCapability({ path, providedAtOffset }: RevokeCapabilityInput) {
    assertCapabilityPath(path);
    const current = this.state.capabilities.find((record) => samePath(record.path, path));
    if (providedAtOffset !== undefined && current?.providedAtOffset !== providedAtOffset) {
      return;
    }
    const key = liveKey(path);
    const previousLive = this.#liveCapabilities.get(key);
    const [committed] = await this.stream.append({
      type: "events.iterate.com/itx/capability-revoked",
      payload: {
        path,
        ...(providedAtOffset === undefined ? {} : { providedAtOffset }),
      },
    });
    this.#liveCapabilities.delete(key);
    previousLive?.dispose();
    await this.waitUntilEvent({ offset: committed.offset });
  }

  async invokeCapability({ args = [], path }: { args?: unknown[]; path: string[] }) {
    assertCapabilityPath(path);
    const hit = resolveLongestPrefix(this.state.capabilities, path);
    if (!hit) {
      // Not declared at THIS scope. Capability reads chain up the scope hierarchy,
      // so ask the enclosing scope before giving up — this is how an agent sees
      // capabilities mounted on its namespace or on the project. Resolution reads
      // live `state.capabilities` every call, so a revoked child mount transparently
      // re-exposes whatever the parent still has at that path.
      if (this.#parent) return await this.#parent.invokeCapability({ args, path });
      throw new Error(`no capability "${path.join(".")}"`);
    }
    if (hit.record.type === "itx-expression") {
      const evaluated = await evaluateItxExpression(this.#itx, hit.record.expression);
      const provider = await normalizeCapabilityProvider(evaluated, hit.record);
      return await invokeNormalizedCapability(provider, hit.rest, args);
    }
    const live = this.#liveCapabilities.get(liveKey(hit.record.path));
    if (!live) {
      throw new Error(`capability "${hit.record.path.join(".")}" is offline`);
    }
    return await live.invoke(hit.rest, args);
  }

  // Reports everything reachable at this scope: this scope's own mounts plus every
  // capability inherited from enclosing scopes, each tagged with the scope it was
  // declared at. A nearer scope shadows a farther one at the same path (same rule
  // as `resolveLongestPrefix` above), so the caller — usually an LLM deciding what
  // it can invoke — sees exactly one entry per reachable path and where it lives.
  async describeCapabilities(): Promise<CapabilityDescription[]> {
    const local: CapabilityDescription[] = this.state.capabilities.map((record) => ({
      instructions: record.instructions,
      path: record.path,
      providedAtOffset: record.providedAtOffset,
      scope: this.#path,
      type: record.type,
      types: record.types,
    }));
    if (!this.#parent) return local;
    const shadowed = new Set(local.map((c) => JSON.stringify(c.path)));
    const inherited = await this.#parent.describeCapabilities();
    return [...local, ...inherited.filter((c) => !shadowed.has(JSON.stringify(c.path)))];
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
      const worker = await this.#workerRunner.getStatelessEntrypoint<{ run(): Promise<unknown> }>(
        await this.#scriptWorkerRef(input.code),
      );
      const result = await worker.run();
      await complete({ result });
    } catch (error) {
      await complete({ error: error instanceof Error ? error.message : String(error) });
    }
  }

  async #scriptWorkerRef(code: string): Promise<StatelessDynamicWorkerRef> {
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
    // runScript is deliberately expressed as a stateless inline DynamicWorkerRef. That
    // keeps script execution on the same DynamicWorkerRunner path as project workers
    // and provided stateless capabilities; ITX adds only the journal events.
    return {
      path: this.#path,
      source: {
        mainModule: "main.js",
        modules: { "main.js": source },
        type: "inline",
      },
      entrypoint: "ScriptEntrypoint",
      props: { scriptHash: await sha256Hex(code) },
      type: "stateless",
    };
  }
}

function assertExpressionDoesNotReferenceOwnMount(
  input: Extract<ProvideCapabilityInput, { type: "itx-expression" }>,
): void {
  const startsWithOwnPath = input.path.every(
    (segment, index) => input.expression[index] === segment,
  );
  if (startsWithOwnPath) {
    throw new Error(
      `itx-expression capability "${input.path.join(".")}" cannot reference its own mount path`,
    );
  }
}
