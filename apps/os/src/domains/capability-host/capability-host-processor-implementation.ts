import {
  StreamProcessor,
  type StreamProcessorConstructorArgs,
} from "../streams/stream-processor.ts";
import { normalizePath } from "../durable-object-names.ts";
import type { CapabilityDescription } from "../itx/describe.ts";
import type { StreamEvent } from "../streams/schemas.ts";
import type { JsonValue } from "../workers/schemas.ts";
import type { CapabilityHost, Project } from "../../itx-api.generated.ts";
import type {
  CapabilityProvidedPayload,
  CapabilityRecord,
  ProvideCapabilityInput,
  RevokeCapabilityInput,
} from "./types.ts";
import { retainLiveCapabilityProvider, type LiveCapability } from "./live-capability.ts";
import {
  CapabilityHostProcessorContract,
  DEFAULT_SCRIPT_EXECUTION_EXPIRY_MS,
} from "./capability-host-processor-contract.ts";
import {
  evaluateItxExpression,
  invokeNormalizedCapability,
  normalizeCapabilityProvider,
} from "./itx-expression.ts";

export type RunScriptResult = Awaited<ReturnType<CapabilityHost["runScript"]>>;

type CompletedPayload = {
  error?: string;
  executionId: string;
  result?: JsonValue;
};

type ScriptExecutionEntrypoint = {
  run(code: string): Promise<unknown>;
};

const INVALID_PATH_SEGMENTS = new Set([
  // Mount names only — INVOCATION paths may end in __describe (intercepted in
  // invokeCapability below); a MOUNT named __describe would be unreachable.
  "__describe",
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
 * this is a `DurableObjectStub<CapabilityHostDurableObject>` for the parent scope, but the
 * processor only depends on these two methods.
 */
export type ParentCapabilityHost = {
  invokeCapability(input: { args?: unknown[]; path: string[] }): Promise<unknown>;
  describeCapabilities(): Promise<CapabilityDescription[]>;
};

export class CapabilityHostProcessor extends StreamProcessor<CapabilityHostProcessorContract> {
  readonly contract = CapabilityHostProcessorContract;
  #itx: Project;
  #path: string;
  #scriptExecutionEntrypoint: ScriptExecutionEntrypoint;
  /** Injected clock (expiry decisions); production defaults to Date.now. */
  #now: (() => number) | undefined;
  #parent: ParentCapabilityHost | undefined;
  #liveCapabilities = new Map<string, LiveCapability>();

  constructor(
    args: StreamProcessorConstructorArgs<CapabilityHostProcessorContract, object> & {
      itx: Project;
      path: string;
      /** Runs run-script workers in this scope. */
      scriptExecutionEntrypoint: ScriptExecutionEntrypoint;
      /** Injected clock (expiry decisions); production defaults to Date.now. */
      now?: () => number;
      // The enclosing scope, or undefined at the project root ("/"). Present for
      // every nested scope (agents, sub-agents, agent namespaces) so capability
      // lookups that miss locally can fall through to the surrounding scope.
      parent?: ParentCapabilityHost;
    },
  ) {
    super(args);
    this.#itx = args.itx;
    this.#path = normalizePath(args.path);
    this.#scriptExecutionEntrypoint = args.scriptExecutionEntrypoint;
    this.#now = args.now;
    this.#parent = args.parent;
  }

  protected override reduce({
    event,
    state,
  }: Parameters<StreamProcessor<CapabilityHostProcessorContract>["reduce"]>[0]) {
    switch (event.type) {
      case "events.iterate.com/capability-host/capability-provided": {
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
      case "events.iterate.com/capability-host/capability-revoked": {
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
      case "events.iterate.com/capability-host/script-execution-requested":
        return {
          ...state,
          scriptExecutions: {
            ...state.scriptExecutions,
            [event.payload.executionId]: {
              status: "requested" as const,
              code: event.payload.code,
              expiresAt:
                event.payload.expiresAt ??
                Date.parse(event.createdAt) + DEFAULT_SCRIPT_EXECUTION_EXPIRY_MS,
            },
          },
        };
      case "events.iterate.com/capability-host/script-execution-started": {
        const existing = state.scriptExecutions[event.payload.executionId];
        if (existing === undefined) return state;
        return {
          ...state,
          scriptExecutions: {
            ...state.scriptExecutions,
            [event.payload.executionId]: { ...existing, status: "started" as const },
          },
        };
      }
      case "events.iterate.com/capability-host/script-execution-completed": {
        const scriptExecutions = { ...state.scriptExecutions };
        delete scriptExecutions[event.payload.executionId];
        return { ...state, scriptExecutions };
      }
      default:
        return state;
    }
  }

  /** Script executions alive in THIS incarnation — the "actual" half of the
   * reconciliation below. */
  readonly #liveExecutions = new Set<string>();

  /**
   * End-of-batch reconciliation of desired (open script obligations in the
   * fold) against actual (this incarnation's live executions) — the same
   * shape as the LLM providers' (see OpenAiWsProcessor.processEventBatch for
   * the doctrine), with one policy difference: a `started` script that lost
   * its incarnation is settled as a FAILURE and never re-run, because a
   * script may have half-executed its side effects and scripts are not
   * assumed idempotent. The agent renders the failure and the model decides
   * whether to retry.
   */
  protected override async processEventBatch(
    args: Parameters<StreamProcessor<CapabilityHostProcessorContract>["processEventBatch"]>[0],
  ): Promise<void> {
    await super.processEventBatch(args);
    // At-head gate — see OpenAiWsProcessor.processEventBatch.
    if (args.checkpointOffset < args.streamMaxOffset) return;
    const now = (this.#now ?? Date.now)();
    const settle: { executionId: string; error: string }[] = [];
    for (const [executionId, execution] of Object.entries(args.state.scriptExecutions)) {
      if (this.#liveExecutions.has(executionId)) continue;
      if (execution.status === "requested" && now < execution.expiresAt) {
        this.#liveExecutions.add(executionId);
        args.runInBackground(() => this.#executeScript({ code: execution.code, executionId }));
        continue;
      }
      settle.push({
        executionId,
        error:
          execution.status === "started"
            ? "Script execution orphaned: the incarnation running it went away before completing (eviction mid-run). It may have partially executed; it was NOT re-run."
            : "Script execution expired before any attempt started (the host was down past the request's expiry). It never ran.",
      });
    }
    if (settle.length === 0) return;
    args.blockProcessorWhile(async () => {
      for (const { executionId, error } of settle) {
        console.error("[capability-host] settling undriven script execution", {
          executionId,
          error,
        });
        await this.#appendCompletion({ executionId, error });
      }
    });
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
        type: "events.iterate.com/capability-host/capability-provided",
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
      type: "events.iterate.com/capability-host/capability-revoked",
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
    // A trailing __describe is a valid INVOCATION (answered from the mount's
    // durable metadata below) — the reserved-name rule is for MOUNT names, so
    // validate the path without it or discovery on provided capabilities dies
    // here with "invalid capability path segment".
    assertCapabilityPath(path[path.length - 1] === "__describe" ? path.slice(0, -1) : path);
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
    // `__describe` on a mounted capability is answered HERE, from the mount's
    // durable metadata (instructions/types recorded at provide time) — the
    // live target is never dialed, for ANY mount kind. Flattened mounts
    // especially: forwarding ["...","__describe"] to a flattenNestedPaths
    // target would hand a discovery probe to a dispatcher that treats every
    // path as a method route. This is what makes discovery work on
    // session-bound live mounts whose provider is offline, and it is the first
    // rung of the transitive-description ladder.
    if (path[path.length - 1] === "__describe") {
      return this.#describeMount(hit.record, path.slice(0, -1));
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

  /**
   * The `Description` for one mount, built entirely from the durable record.
   * `at` is the path the caller asked about (which may be nested below the
   * mount point). Besides the provider's own instructions/types, the prose
   * explains HOW dispatch works for this mount kind — most usefully for
   * `flattenNestedPaths` targets, which are dispatchers rather than object
   * graphs: their sub-paths cannot be enumerated, only routed.
   */
  #describeMount(record: CapabilityRecord, at: string[]) {
    const mountPoint = record.path.join(".");
    const asked = at.join(".");
    const nestedNote =
      at.length > record.path.length
        ? ` You asked about the nested path "${asked}" — nesting below the mount is ${record.flattenNestedPaths === true ? "routed, not enumerable: only the provider knows which sub-paths exist" : "resolved by property traversal on the provider's value"}.`
        : "";
    const dispatch =
      record.flattenNestedPaths === true
        ? `This is a FLATTENED dispatch target: any dotted call under the mount compiles to one invokeCapability call with the remaining path — \`${mountPoint}.a.b(x)\` reaches the provider as \`invokeCapability({ path: ["a","b"], args: [x] })\`. There is no object graph to walk; \`children\` is empty because sub-paths are routes the provider interprets, not members this host can list.`
        : record.type === "live"
          ? `Dotted calls under the mount replay onto the provider's value by property traversal (\`${mountPoint}.a.b(x)\` calls \`a.b(x)\` on it). Live mounts are session-bound: the mount record is durable, but calls travel over the provider's connection and fail with "offline" when it disconnects. \`children\` is empty because the host only stores this record, never the provider's shape.`
          : `A durable itx-expression: on every call the recorded expression is re-evaluated against this scope's own itx and the remaining path is invoked on the result — no live connection is held. \`children\` is empty because the host only stores the recipe, not the evaluated value's shape.`;
    return {
      instructions: [
        record.instructions ?? `A dynamic ${record.type} capability mounted at "${mountPoint}".`,
        dispatch + nestedNote,
      ].join("\n\n"),
      types: record.types ?? "",
      children: {},
      parent: `the capability host at scope "${this.#path}" (mounted at "${mountPoint}", providedAtOffset ${record.providedAtOffset})`,
    };
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
      type: "events.iterate.com/capability-host/script-execution-requested",
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
        if (event.type !== "events.iterate.com/capability-host/script-execution-completed")
          return false;
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
    try {
      // Started-evidence lands durably BEFORE the script body runs, so the
      // fold can always tell "provably never ran" (requested, startable late)
      // from "may have half-run" (started, settle-only). Deliberately OUTSIDE
      // the try below: if this append fails the script never ran, so no
      // completion may be appended — the obligation stays `requested`, the
      // rethrow marks the keepalive window failed, and a later reconciliation
      // retries the whole attempt. (Same shape as the LLM providers.)
      await this.stream.append({
        type: "events.iterate.com/capability-host/script-execution-started",
        idempotencyKey: `capability-host/script-execution-started@${input.executionId}`,
        payload: { executionId: input.executionId },
      });
      try {
        const result = await this.#scriptExecutionEntrypoint.run(input.code);
        await this.#appendCompletion({ executionId: input.executionId, result });
      } catch (error) {
        await this.#appendCompletion({
          executionId: input.executionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      this.#liveExecutions.delete(input.executionId);
    }
  }

  /** The one durable outcome of a script execution. The reconciler's settle
   * path and the normal run share the idempotency key, so races collapse to
   * one completion at the append dedup layer. */
  #appendCompletion(input: { executionId: string; error?: string; result?: unknown }) {
    const payload: JsonValue =
      input.error !== undefined
        ? { error: input.error, executionId: input.executionId }
        : {
            executionId: input.executionId,
            // A script that returns undefined omits `result` entirely. The
            // distinction is load-bearing for agents: "returned a value"
            // feeds the result back for another turn, "returned nothing"
            // ends the loop.
            ...(input.result === undefined ? {} : { result: json(input.result) }),
          };
    return this.stream.append({
      type: "events.iterate.com/capability-host/script-execution-completed",
      idempotencyKey: `capability-host/script-execution-completed@${input.executionId}`,
      payload,
    });
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
