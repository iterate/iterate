import { tracing } from "cloudflare:workers";
import {
  StreamProcessor,
  type StreamProcessorConstructorArgs,
} from "../streams/stream-processor.ts";
import type { ProcessorState } from "../streams/processor-contracts.ts";
import { normalizePath } from "../durable-object-names.ts";
import type { CapabilityDescription } from "../itx/describe.ts";
import type { Project } from "../../itx-api.generated.ts";
import type { ScriptExecutionCheck } from "../typecheck/virtual-project.ts";
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
import { settleByDeadline } from "./execution-deadline.ts";
import {
  SCRIPT_COMPLETION_OBSERVATION_GRACE_MS,
  SCRIPT_EXECUTION_SETTLEMENT_GRACE_MS,
  scriptCompletionInput,
  settlementAppendDeadline,
  settlementForUndrivenScript,
  settlementFromWorkerOutcome,
  type ScriptExecutionSettlement as ScriptExecutionSettlementValue,
} from "./script-execution-settlement.ts";
import {
  evaluateItxExpression,
  invokeNormalizedCapability,
  normalizeCapabilityProvider,
} from "./itx-expression.ts";

export type ScriptRunRequest = {
  completionIdempotencyKey: string;
  executionId: string;
  expiresAt: number;
};

type ScriptExecutionEntrypoint = {
  run(code: string, options: { emittedJs?: string; expiresAt: number }): Promise<unknown>;
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

/** ~4k tokens: how much of a mount's types `__describe` shows before
 * deferring to docs.get's budgeted reader. */
const MAX_DESCRIBED_TYPES_CHARS = 16_000;
// provide/revoke are read-your-write boundaries. A broken delivery path must
// reject the command rather than retain an RPC forever.
const INGEST_WAIT_TIMEOUT_MS = 15_000;

function truncatedTypes(types: string, mountPoint: string): string {
  if (types.length <= MAX_DESCRIBED_TYPES_CHARS) return types;
  const cut = types.slice(0, MAX_DESCRIBED_TYPES_CHARS);
  // Close a block comment the cut may have opened, so the notice stays
  // visible to a consumer rendering this as code (same rule as typeSlice).
  const openComment = cut.lastIndexOf("/*") > cut.lastIndexOf("*/");
  return (
    cut +
    (openComment ? " */" : "") +
    `\n// … truncated — read slices with itx.docs.get({ name: ${JSON.stringify(mountPoint)}, maxTokens: 4000 })`
  );
}

const samePath = (a: string[], b: string[]) =>
  a.length === b.length && a.every((segment, index) => segment === b[index]);

const liveKey = (path: string[]) => JSON.stringify(path);

function assertCapabilityPath(path: string[]) {
  if (!Array.isArray(path)) {
    throw new Error('capability path must be an ARRAY of segments (e.g. ["tools", "weather"])');
  }
  if (path.length === 0) {
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
 * One explicitly declared ancestor scope, as seen from a child scope's processor.
 *
 * Only the two read operations chain upward (see the class below); mounting is
 * always local, so `provide`/`revoke` are deliberately absent here. In practice
 * this is a `DurableObjectStub<CapabilityHostDurableObject>` for the parent scope, but the
 * processor only depends on these two methods.
 */
export type CapabilityHostAncestor = {
  invokeCapability(
    input: { args?: unknown[]; path: string[] },
    visitedScopePaths?: string[],
  ): Promise<unknown>;
  describeCapabilities(visitedScopePaths?: string[]): Promise<CapabilityDescription[]>;
};

const MAX_CAPABILITY_ANCESTOR_DEPTH = 32;

type CapabilityHostBirthCertificate = NonNullable<
  ProcessorState<CapabilityHostProcessorContract>["birthCertificate"]
>;

/**
 * RUNNER-backed reads of the committed fold. Under registry drive the runner
 * owns both cursors and the processor instance's internal checkpoint never
 * advances, so every fold read this processor makes OUTSIDE a hook's own args
 * — capability resolution, the revoke guard, and the provide/revoke
 * read-your-writes barriers — must go through the runner's committed
 * progress. The hosting DO wires this to
 * `registry.reads(processor)` (lazily — `reads()` needs the registered
 * processor); test harnesses wire it to the driving StreamProcessorRunner.
 * Capability-host reads use only exact durable offsets. Long predicate waits
 * belong to the stateless Worker RPC target, which can reopen bounded Stream
 * DO leases across incarnation changes.
 */
export type CapabilityHostProcessorReads = {
  snapshot(): Promise<{
    offset: number;
    state: ProcessorState<CapabilityHostProcessorContract>;
  }>;
  waitUntilEvent(input: {
    offset: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<void>;
};

export class CapabilityHostProcessor extends StreamProcessor<CapabilityHostProcessorContract> {
  readonly contract = CapabilityHostProcessorContract;
  #itx: Project;
  #path: string;
  #scriptExecutionEntrypoint: ScriptExecutionEntrypoint;
  /** Injected clock (expiry decisions); production defaults to Date.now. */
  #now: (() => number) | undefined;
  #resolveAncestor: ((path: string) => CapabilityHostAncestor) | undefined;
  #validateCapabilityTypes: ((types: string) => Promise<string[]>) | undefined;
  #typecheckScript:
    | ((input: {
        capabilities: CapabilityDescription[];
        code: string;
      }) => Promise<ScriptExecutionCheck>)
    | undefined;
  #runScriptInBackground: (work: () => Promise<unknown>) => void;
  #liveCapabilities = new Map<string, LiveCapability>();
  #reads: CapabilityHostProcessorReads;

  constructor(
    args: StreamProcessorConstructorArgs & {
      itx: Project;
      path: string;
      /** Runner-backed fold reads — see {@link CapabilityHostProcessorReads}. */
      reads: CapabilityHostProcessorReads;
      /** Runs run-script workers in this scope. */
      scriptExecutionEntrypoint: ScriptExecutionEntrypoint;
      /** Injected clock (expiry decisions); production defaults to Date.now. */
      now?: () => number;
      /** Resolves only the path recorded in the host's birth certificate. */
      resolveAncestor?: (path: string) => CapabilityHostAncestor;
      /**
       * Compiles a mount's `types` string, returning problems (empty = it
       * compiles). Wired to the typechecker sidecar in production; the node
       * test harness runs without one, which skips validation.
       */
      validateCapabilityTypes?: (types: string) => Promise<string[]>;
      /**
       * Pre-execution typecheck of a requested script against this scope's
       * capability types (checkItxScriptForExecution in production; absent in
       * the node test harness, which skips the gate). Only a `problems`
       * verdict blocks the run — see ScriptExecutionCheck.
       */
      typecheckScript?: (input: {
        capabilities: CapabilityDescription[];
        code: string;
      }) => Promise<ScriptExecutionCheck>;
      /**
       * Starts a committed script obligation on the hosting runner's recovery
       * lane. Production injects the registry runner; tests may use the base
       * processor keepalive.
       */
      runScriptInBackground?: (work: () => Promise<unknown>) => void;
    },
  ) {
    super(args);
    this.#itx = args.itx;
    this.#path = normalizePath(args.path);
    this.#reads = args.reads;
    this.#scriptExecutionEntrypoint = args.scriptExecutionEntrypoint;
    this.#now = args.now;
    this.#resolveAncestor = args.resolveAncestor;
    this.#validateCapabilityTypes = args.validateCapabilityTypes;
    this.#typecheckScript = args.typecheckScript;
    this.#runScriptInBackground =
      args.runScriptInBackground ?? ((work) => this.runInBackground(work));
  }

  protected override reduce({
    event,
    state,
  }: Parameters<StreamProcessor<CapabilityHostProcessorContract>["reduce"]>[0]) {
    switch (event.type) {
      case "events.iterate.com/capability-host/created": {
        if (state.birthCertificate !== null) {
          throw new Error("capability host received more than one created event");
        }
        const ancestorPath = event.payload.config.ancestorPath;
        return {
          ...state,
          birthCertificate: {
            config: {
              ancestorPath: ancestorPath === null ? null : normalizePath(ancestorPath),
            },
          },
        };
      }
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
      case "events.iterate.com/capability-host/script-run-requested":
        return {
          ...state,
          scriptExecutions: {
            ...state.scriptExecutions,
            [event.payload.executionId]: {
              status: "requested" as const,
              code: event.payload.code,
              expiresAt: event.payload.expiresAt,
            },
          },
        };
      case "events.iterate.com/capability-host/script-run-started": {
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
      case "events.iterate.com/capability-host/script-run-settled": {
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
   * Incarnation-local launch ownership. A foreground reservation exists before
   * its journal request and remains through the append continuation, so
   * committed-state pruning must never infer that its absence from a snapshot
   * makes it stale. Once launched, foreground and reconcile owners remain
   * until the committed fold removes the obligation.
   */
  readonly #executionOwners = new Map<string, "foreground-reserved" | "foreground" | "reconcile">();
  /**
   * Exact outcomes already known by this incarnation but not yet observed
   * back from the journal. A timed-out completion append is an ambiguous
   * transport outcome, not permission to replace the script's real result
   * with an invented orphan classification. Reconciliation retries this
   * same settlement under the completion idempotency key until the durable
   * event is folded (or the incarnation itself disappears).
   */
  readonly #pendingSettlements = new Map<string, ScriptExecutionSettlementValue>();

  /**
   * The at-head reconcile (was `onCaughtUp`): `processEvent` invokes it under
   * `delivery.caughtUp`, so this processor has no per-event side effects — all
   * of its work is the obligation reconciliation. It runs after the scan
   * reaches head, on either the last consumed event or the runner's eventless
   * pass, so a mid-catch-up fold never re-runs a settled script.
   */
  protected override processEvent(
    args: Parameters<StreamProcessor<CapabilityHostProcessorContract>["processEvent"]>[0],
  ): undefined {
    if (
      args.event !== null &&
      args.event.type === "events.iterate.com/capability-host/script-run-settled"
    ) {
      this.#pendingSettlements.delete(args.event.payload.executionId);
      this.#executionOwners.delete(args.event.payload.executionId);
    }
    // ONE outer blocking closure per at-head pass — the settle appends inside
    // #reconcileScriptObligations are awaited (holding this head event's
    // deferred commit); a nested blockProcessorWhile would register after the
    // runner's per-event blocker snapshot and never be awaited.
    if (args.delivery.caughtUp) {
      args.blockProcessorWhileCaughtUp(() => this.#reconcileScriptObligations(args));
    }
  }

  /**
   * At-head reconciliation of desired (open script obligations in the head
   * fold) against actual (this incarnation's live executions) — the
   * obligation doctrine, with one policy difference from the LLM providers: a
   * `started` script that lost its incarnation is settled as a FAILURE and
   * never re-run, because a script may have half-executed its side effects
   * and scripts are not assumed idempotent. The agent renders the failure and
   * the model decides whether to retry.
   *
   * RECOVERY rides this same path: `events.iterate.com/stream/processor-revived`
   * — the fact the keepalive's revival pass journals after an eviction took
   * in-flight work — is consumed by the contract, so its ordinary delivery is
   * a guaranteed turn that lands at head and runs this reconcile, where the
   * undriven obligations are re-driven. The `processEvent` switch has no arm
   * for its type; the at-head reconcile is the whole point.
   */
  async #reconcileScriptObligations(
    args: Parameters<StreamProcessor<CapabilityHostProcessorContract>["processEvent"]>[0],
  ): Promise<void> {
    if (args.state.birthCertificate === null) {
      const settlements = Object.entries(args.state.scriptExecutions).map(
        ([executionId, execution]) => {
          const settlement: ScriptExecutionSettlementValue =
            execution.status === "started"
              ? {
                  status: "failed",
                  error: `Script execution cannot be reconciled: capability host at ${this.#path} has not been created, despite having started evidence. It may have partially executed; it was NOT re-run.`,
                  failureKind: "orphaned",
                  phase: "recovery",
                  executionMayHaveOccurred: true,
                  cancellation: "external-work-may-continue",
                }
              : {
                  status: "failed",
                  error: `Script was NOT executed: capability host at ${this.#path} has not been created.`,
                  failureKind: "runtime",
                  phase: "before-execution",
                  executionMayHaveOccurred: false,
                  cancellation: "not-applicable",
                };
          console.error("[capability-host] settling script execution on an uncreated host", {
            executionId,
            settlement,
          });
          return { executionId, expiresAt: execution.expiresAt, settlement };
        },
      );
      await this.#appendCompletionsWithin(settlements);
      return;
    }
    const now = (this.#now ?? Date.now)();
    const settle: {
      executionId: string;
      expiresAt: number;
      settlement: ScriptExecutionSettlementValue;
    }[] = [];
    for (const [executionId, execution] of Object.entries(args.state.scriptExecutions)) {
      if (this.#liveExecutions.has(executionId)) continue;
      const pendingSettlement = this.#pendingSettlements.get(executionId);
      if (pendingSettlement !== undefined) {
        settle.push({ executionId, expiresAt: execution.expiresAt, settlement: pendingSettlement });
        continue;
      }
      if (execution.status === "requested" && now < execution.expiresAt) {
        // A prior attempt in this incarnation may already have committed its
        // started/completed evidence while this fold still shows requested.
        if (this.#executionOwners.has(executionId)) continue;
        this.#driveRequestedScript({
          execution,
          executionId,
          state: args.state,
          runInBackground: args.runInBackground,
        });
        continue;
      }
      settle.push({
        executionId,
        expiresAt: execution.expiresAt,
        settlement: settlementForUndrivenScript(execution.status),
      });
    }
    // Settle inline — this runs inside the head event's outer blocking closure
    // (see processEvent), so awaiting the single atomic append holds the frame.
    if (settle.length === 0) return;
    for (const { executionId, settlement } of settle) {
      console.error("[capability-host] settling undriven script execution", {
        executionId,
        settlement,
      });
    }
    // One stream append is both faster and stronger than serial appends: a
    // recovery backlog consumes one bounded settlement window and commits
    // every orphan classification atomically in canonical execution order.
    await this.#appendCompletionsWithin(settle);
  }

  /**
   * Turn one durable `requested` fact into an incarnation-local attempt.
   * Recovery reconciliation acquires an unowned claim; `requestScript` reserves
   * its own owner before journaling and calls #startOwnedScript directly.
   */
  #driveRequestedScript(input: {
    execution: { code: string; expiresAt: number };
    executionId: string;
    state: ProcessorState<CapabilityHostProcessorContract>;
    runInBackground: (work: () => Promise<unknown>) => void;
  }): void {
    if (this.#executionOwners.has(input.executionId)) return;
    this.#executionOwners.set(input.executionId, "reconcile");
    this.#startOwnedScript({ ...input, launchOwner: "reconcile" });
  }

  /** Start an attempt whose incarnation-local ownership is already recorded. */
  #startOwnedScript(input: {
    execution: { code: string; expiresAt: number };
    executionId: string;
    launchOwner: "foreground" | "reconcile";
    state: ProcessorState<CapabilityHostProcessorContract>;
    runInBackground: (work: () => Promise<unknown>) => void;
  }): void {
    if (this.#executionOwners.get(input.executionId) !== input.launchOwner) {
      throw new Error(
        `script execution "${input.executionId}" started without ${input.launchOwner} ownership`,
      );
    }
    this.#liveExecutions.add(input.executionId);
    try {
      input.runInBackground(() =>
        this.#executeScript({
          birthCertificate: this.#requireBirthCertificate(input.state.birthCertificate),
          capabilities: input.state.capabilities,
          code: input.execution.code,
          executionId: input.executionId,
          expiresAt: input.execution.expiresAt,
          launchOwner: input.launchOwner,
        }),
      );
    } catch (error) {
      this.#liveExecutions.delete(input.executionId);
      this.#executionOwners.delete(input.executionId);
      throw error;
    }
  }

  /** Drop launched owners only from a COMMITTED fold with no obligation.
   * Pre-append reservations are intentionally invisible to this pruning. */
  #pruneExecutionOwners(state: ProcessorState<CapabilityHostProcessorContract>): void {
    for (const [executionId, owner] of this.#executionOwners) {
      if (owner === "foreground-reserved") continue;
      if (state.scriptExecutions[executionId] === undefined) {
        this.#executionOwners.delete(executionId);
      }
    }
  }

  async provideCapability(input: ProvideCapabilityInput) {
    await this.#assertCreated();
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
      if (!Array.isArray(input.expression)) {
        throw new Error(
          '"expression" must be an ARRAY of steps — property names and [method, ...args] calls ' +
            'walked over itx, e.g. ["streams", ["get", "/"]] — not JavaScript source. ' +
            'Copy the recipe from itx.docs.get({ name: "typed-capability-mount" }).',
        );
      }
      assertExpressionDoesNotReferenceOwnMount(input);
      record = {
        expression: input.expression,
        flattenNestedPaths: input.flattenNestedPaths === true ? true : undefined,
        instructions: input.instructions,
        path,
        type: "itx-expression",
        types: input.types ?? (await this.#selfDescribedTypes(input.expression)),
      };
    } else {
      input satisfies never;
      throw new Error(`unsupported capability input ${(input as { type?: unknown }).type}`);
    }
    // Authored types must compile before they enter the journal — a typo'd
    // declaration rejected here is a fixable error; one journaled durably is
    // silent rot every docs read and typecheck inherits. This runs AFTER the
    // cheap structural checks above so a malformed payload never costs a
    // network-bound compile before its real error surfaces.
    if (input.types !== undefined) {
      const problems = (await this.#validateCapabilityTypes?.(input.types)) ?? [];
      if (problems.length > 0) {
        throw new Error(
          `capability "types" for "${path.join(".")}" does not compile:\n${problems.join("\n")}`,
        );
      }
    }
    const nextLive =
      nextLiveInput !== undefined
        ? retainLiveCapabilityProvider(nextLiveInput.target, {
            flattenNestedPath: nextLiveInput.flattenNestedPath,
          })
        : undefined;

    let committedOffset: number;
    try {
      const [committed] = await this.append({
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

    await this.#reads.waitUntilEvent({
      offset: committedOffset,
      timeoutMs: INGEST_WAIT_TIMEOUT_MS,
    });
    return { path, providedAtOffset: committedOffset };
  }

  /**
   * Connect-time auto-typing: a durable expression mount provided WITHOUT
   * types asks the capability to describe itself ONCE, here, and keeps the
   * `types` its `__describe()` reports — the MCP and OpenAPI connect doors
   * generate theirs from tool schemas and spec operations, so third-party
   * services become as documented as builtins with zero author effort.
   * Best-effort by design: an unreachable or slow server, a target without
   * `__describe`, or self-reported types that fail to compile all leave the
   * mount untyped rather than blocking the provide. The compile gate keeps
   * the invariant that types journaled THROUGH provideCapability always
   * compile (direct `capability-provided` appends — agent birth mounts,
   * userspace processors — bypass this method entirely).
   */
  async #selfDescribedTypes(
    expression: Extract<ProvideCapabilityInput, { type: "itx-expression" }>["expression"],
  ): Promise<string | undefined> {
    // The catch rides the promise itself, BEFORE the race: describing may
    // lose to the deadline and fail later, and an abandoned rejection must
    // not surface as unhandled after the provide already returned.
    const described = this.#describeExpressionTypes(expression).catch(() => undefined);
    // The deadline keeps a hanging third-party server (MCP listTools, an
    // OpenAPI spec fetch) from hanging the provide — past it, the mount just
    // stays untyped.
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        described,
        new Promise<undefined>((resolve) => {
          deadline = setTimeout(() => resolve(undefined), 10_000);
        }),
      ]);
    } finally {
      clearTimeout(deadline);
    }
  }

  async #describeExpressionTypes(
    expression: Extract<ProvideCapabilityInput, { type: "itx-expression" }>["expression"],
  ): Promise<string | undefined> {
    const evaluated = await evaluateItxExpression(this.#itx, expression);
    const value = (await evaluated.value) as {
      __describe?: () => Promise<{ types?: string }>;
    };
    const types = (await value.__describe?.())?.types;
    if (typeof types !== "string" || types.length === 0) return undefined;
    const problems = (await this.#validateCapabilityTypes?.(types)) ?? [];
    return problems.length === 0 ? types : undefined;
  }

  async revokeCapability({ path, providedAtOffset }: RevokeCapabilityInput) {
    await this.#assertCreated();
    assertCapabilityPath(path);
    const { state } = await this.#reads.snapshot();
    const current = state.capabilities.find((record) => samePath(record.path, path));
    if (providedAtOffset !== undefined && current?.providedAtOffset !== providedAtOffset) {
      return;
    }
    const key = liveKey(path);
    const previousLive = this.#liveCapabilities.get(key);
    const [committed] = await this.append({
      type: "events.iterate.com/capability-host/capability-revoked",
      payload: {
        path,
        ...(providedAtOffset === undefined ? {} : { providedAtOffset }),
      },
    });
    this.#liveCapabilities.delete(key);
    previousLive?.dispose();
    await this.#reads.waitUntilEvent({
      offset: committed.offset,
      timeoutMs: INGEST_WAIT_TIMEOUT_MS,
    });
  }

  async invokeCapability(
    { args = [], path }: { args?: unknown[]; path: string[] },
    visitedScopePaths: string[] = [],
  ) {
    // A trailing __describe is a valid INVOCATION (answered from the mount's
    // durable metadata below) — the reserved-name rule is for MOUNT names, so
    // validate the path without it or discovery on provided capabilities dies
    // here with "invalid capability path segment".
    assertCapabilityPath(path[path.length - 1] === "__describe" ? path.slice(0, -1) : path);
    const { state } = await this.#reads.snapshot();
    const birthCertificate = this.#requireBirthCertificate(state.birthCertificate);
    const hit = resolveLongestPrefix(state.capabilities, path);
    if (!hit) {
      // Not declared at THIS scope. Ask only the ancestor named in this host's
      // durable declaration. Path prefixes are names, not capability scopes.
      // Resolution reads live state every call, so revoking a child mount
      // transparently re-exposes whatever the declared ancestor still has.
      const ancestor = this.#ancestorFor(birthCertificate);
      if (ancestor !== undefined) {
        return await ancestor.invokeCapability(
          { args, path },
          this.#nextAncestorTraversal(visitedScopePaths),
        );
      }
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
      // __describe is the identity card, never big: a giant declaration
      // (authors can journal hundreds of KB) is truncated here; the budgeted
      // reader is `itx.docs.get({ name: "<mount path>", maxTokens })`.
      types: truncatedTypes(record.types ?? "", mountPoint),
      children: {},
      parent: `the capability host at scope "${this.#path}" (mounted at "${mountPoint}", providedAtOffset ${record.providedAtOffset})`,
    };
  }

  // Reports everything reachable at this scope: this scope's own mounts plus
  // those reachable through its explicit ancestor, each tagged with the scope
  // it was declared at. A nearer scope shadows a farther one at the same path.
  async describeCapabilities(visitedScopePaths: string[] = []): Promise<CapabilityDescription[]> {
    const { state } = await this.#reads.snapshot();
    return await this.#describeCapabilitiesFrom(
      state.capabilities,
      this.#requireBirthCertificate(state.birthCertificate),
      visitedScopePaths,
    );
  }

  async #describeCapabilitiesFrom(
    records: CapabilityRecord[],
    birthCertificate: CapabilityHostBirthCertificate,
    visitedScopePaths: string[] = [],
  ): Promise<CapabilityDescription[]> {
    const local: CapabilityDescription[] = records.map((record) => ({
      instructions: record.instructions,
      path: record.path,
      providedAtOffset: record.providedAtOffset,
      scope: this.#path,
      type: record.type,
      types: record.types,
    }));
    const ancestor = this.#ancestorFor(birthCertificate);
    if (ancestor === undefined) return local;
    const shadowed = new Set(local.map((c) => JSON.stringify(c.path)));
    const inherited = await ancestor.describeCapabilities(
      this.#nextAncestorTraversal(visitedScopePaths),
    );
    return [...local, ...inherited.filter((c) => !shadowed.has(JSON.stringify(c.path)))];
  }

  #nextAncestorTraversal(visitedScopePaths: string[]): string[] {
    if (visitedScopePaths.includes(this.#path)) {
      throw new Error(
        `capability-host ancestor cycle: ${[...visitedScopePaths, this.#path].join(" -> ")}`,
      );
    }
    if (visitedScopePaths.length >= MAX_CAPABILITY_ANCESTOR_DEPTH) {
      throw new Error(
        `capability-host ancestor depth exceeds ${MAX_CAPABILITY_ANCESTOR_DEPTH}: ${[
          ...visitedScopePaths,
          this.#path,
        ].join(" -> ")}`,
      );
    }
    return [...visitedScopePaths, this.#path];
  }

  #ancestorFor(
    birthCertificate: CapabilityHostBirthCertificate,
  ): CapabilityHostAncestor | undefined {
    const ancestorPath = birthCertificate.config.ancestorPath;
    if (ancestorPath === null) return undefined;
    if (ancestorPath === this.#path) {
      throw new Error(`capability-host "${this.#path}" cannot be its own ancestor`);
    }
    const resolveAncestor = this.#resolveAncestor;
    if (resolveAncestor === undefined) {
      throw new Error(
        `capability-host "${this.#path}" declares ancestor "${ancestorPath}" but no resolver is configured`,
      );
    }
    return resolveAncestor(ancestorPath);
  }

  async ancestorPath(): Promise<string | null> {
    const { state } = await this.#reads.snapshot();
    return this.#requireBirthCertificate(state.birthCertificate).config.ancestorPath;
  }

  #requireBirthCertificate(
    birthCertificate: CapabilityHostBirthCertificate | null,
  ): CapabilityHostBirthCertificate {
    if (birthCertificate === null) {
      throw new Error(`capability host at ${this.#path} has not been created`);
    }
    return birthCertificate;
  }

  /**
   * Journal and launch one script obligation, then return its exact durable
   * completion coordinate. Completion observation deliberately does not live
   * in this incarnation: the Worker waits through the Stream DO's hibernating
   * WebSocket lane and can survive either object's hibernation or restart.
   */
  async requestScript(code: string): Promise<ScriptRunRequest> {
    const { state } = await this.#reads.snapshot();
    this.#pruneExecutionOwners(state);
    this.#requireBirthCertificate(state.birthCertificate);
    const executionId = crypto.randomUUID();
    const completionIdempotencyKey = this.#completionIdempotencyKey(executionId);
    const now = this.#now ?? Date.now;
    const expiresAt = now() + DEFAULT_SCRIPT_EXECUTION_EXPIRY_MS;
    // Reserve before the request append. Push delivery can fold the request
    // before this foreground continuation resumes; without the reservation,
    // that reconcile could acquire the same obligation and launch it from an
    // unrelated delivery lineage.
    this.#executionOwners.set(executionId, "foreground-reserved");
    try {
      await tracing.enterSpan("capability_host.script_request_append", async (span) => {
        span.setAttribute("iterate.capability_host.execution_id", executionId);
        const events = await this.#awaitJournalAppend(
          this.append({
            type: "events.iterate.com/capability-host/script-run-requested",
            payload: { code, executionId, expiresAt },
          }),
          expiresAt,
          `record the request for script execution "${executionId}"`,
        );
        const requestedEvent = events[0];
        if (requestedEvent === undefined) {
          throw new Error(`script execution "${executionId}" request append returned no event`);
        }
        span.setAttribute("iterate.capability_host.request_offset", requestedEvent.offset);
      });

      // The append is the durable recovery boundary. Starting the exact
      // obligation now keeps foreground latency independent of subscriber
      // delivery and the runner's serialized catch-up chain. If this
      // incarnation dies after the append but before/during the launch, the
      // journaled request is what a later at-head reconcile adopts.
      if (this.#executionOwners.get(executionId) !== "foreground-reserved") {
        throw new Error(`script execution "${executionId}" lost its foreground reservation`);
      }
      this.#executionOwners.set(executionId, "foreground");
      this.#startOwnedScript({
        execution: { code, expiresAt },
        executionId,
        launchOwner: "foreground",
        state,
        runInBackground: this.#runScriptInBackground,
      });
      return {
        completionIdempotencyKey,
        executionId,
        expiresAt,
      };
    } catch (error) {
      // Before #startOwnedScript schedules work, the foreground path owns
      // only an in-memory reservation. Releasing it lets durable recovery
      // adopt any request whose append committed before this failure.
      if (!this.#liveExecutions.has(executionId)) {
        this.#executionOwners.delete(executionId);
      }
      throw error;
    }
  }

  async #assertCreated(): Promise<void> {
    const { state } = await this.#reads.snapshot();
    this.#requireBirthCertificate(state.birthCertificate);
  }

  /**
   * The pre-execution typecheck gate: a script whose OWN code carries a
   * provable error (a syntax error, a near-miss typo the compiler can name
   * the fix for) settles as an error completion without running — the model
   * reads compiler errors instead of paying a failed run. Permissive
   * everywhere the checker lacks knowledge (unknown types, unchecked
   * verdicts, checker failures): the gate may only ever block on proof.
   * Returns the completion error, or null to proceed.
   */
  async #typecheckScriptForRun(
    code: string,
    records: CapabilityRecord[],
    birthCertificate: CapabilityHostBirthCertificate,
  ): Promise<{ rejection: string | null; emittedJs?: string }> {
    const typecheckScript = this.#typecheckScript;
    if (typecheckScript === undefined) return { rejection: null };
    const rejectProblems = (problems: string[]) => ({
      rejection: [
        "Script was NOT executed: it does not typecheck against this scope's capability types.",
        ...problems,
        "Fix the type errors and resend the whole corrected script.",
      ].join("\n"),
    });
    let platformProblems: string[] | undefined;
    try {
      const check = (capabilities: CapabilityDescription[]) =>
        typecheckScript({ capabilities, code });

      // Most scripts use only the static Project surface. Compile that first:
      // a diagnostic-free successful emit proves no dynamic mount declaration
      // was needed, so walking the explicit ancestor graph would only add cold
      // Durable Object RPCs. Script diagnostics or a missing emit mean the
      // static surface was insufficient; only then assemble and check the full
      // scope.
      const platformChecked = await check([]);
      if (
        platformChecked.verdict === "clean" &&
        !platformChecked.needsScopeTypes &&
        platformChecked.emittedJs !== undefined
      ) {
        return { rejection: null, emittedJs: platformChecked.emittedJs };
      }
      // An unavailable/crashed checker cannot become authoritative merely by
      // adding mount declarations. Preserve the permissive unchecked lane
      // without paying capability discovery first.
      if (platformChecked.verdict === "unchecked") return { rejection: null };
      if (platformChecked.verdict === "problems") {
        // A complete scope check can disprove a platform-only diagnostic by
        // supplying the missing dynamic declaration. Until that succeeds,
        // though, these remain proven blockers rather than an unchecked lane.
        platformProblems = platformChecked.problems;
      }

      const capabilities = await this.#describeCapabilitiesFrom(records, birthCertificate);
      const checked = await check(capabilities);
      if (checked.verdict === "clean") {
        // Check and emit are one compile: what runs IS the compiler's
        // type-stripped output, so scripts are genuinely TypeScript.
        return { rejection: null, emittedJs: checked.emittedJs };
      }
      if (checked.verdict === "problems") return rejectProblems(checked.problems);
      return platformProblems === undefined
        ? { rejection: null }
        : rejectProblems(platformProblems);
    } catch (error) {
      // A checker/ancestor failure is permissive only when no completed check
      // has already proved a blocker. Losing the scope-aware recheck must not
      // erase the platform check's durable verdict.
      console.warn("[capability-host] script typecheck skipped", { error });
      return platformProblems === undefined
        ? { rejection: null }
        : rejectProblems(platformProblems);
    }
  }

  async #executeScript(input: {
    birthCertificate: CapabilityHostBirthCertificate;
    capabilities: CapabilityRecord[];
    code: string;
    executionId: string;
    expiresAt: number;
    launchOwner: "foreground" | "reconcile";
  }) {
    const now = this.#now ?? Date.now;
    const executionExpiresAt = input.expiresAt - SCRIPT_EXECUTION_SETTLEMENT_GRACE_MS;
    let durableAttemptEvidenceCommitted = false;
    // This work deliberately outlives the requestScript RPC under waitUntil.
    // Cloudflare custom spans are request-scoped: starting them here lets the
    // foreground request close their parent while this promise keeps running,
    // which produces impossible parentage and even negative child durations.
    // Keep the foreground request-append/public runScript spans, plus the
    // independently request-scoped typechecker and executor spans; the durable
    // requested/started/settled facts remain the execution phase record.
    try {
      // The typecheck gate runs BEFORE the started evidence: it has no side
      // effects, so a rejected script provably never ran (requested →
      // completed, no started event) and the reconciler doctrine is untouched.
      const checkedOutcome = await settleByDeadline(
        this.#typecheckScriptForRun(input.code, input.capabilities, input.birthCertificate),
        executionExpiresAt,
        now,
      );
      if (checkedOutcome.status === "deadline") {
        await this.#appendAndFoldCompletionWithin(
          {
            executionId: input.executionId,
            settlement: {
              status: "failed",
              error:
                "Script execution reached its absolute deadline while being typechecked. It never ran.",
              failureKind: "deadline",
              phase: "typecheck",
              executionMayHaveOccurred: false,
              cancellation: "not-applicable",
            },
          },
          input.expiresAt,
        );
        return;
      }
      if (checkedOutcome.status === "rejected") throw checkedOutcome.error;
      const checked = checkedOutcome.value;
      if (checked.rejection !== null) {
        await this.#appendAndFoldCompletionWithin(
          {
            executionId: input.executionId,
            settlement: {
              status: "failed",
              error: checked.rejection,
              failureKind: "typecheck",
              phase: "typecheck",
              executionMayHaveOccurred: false,
              cancellation: "not-applicable",
            },
          },
          input.expiresAt,
        );
        return;
      }
      // Started-evidence lands durably BEFORE the script body runs, so the
      // fold can always tell "provably never ran" (requested, startable late)
      // from "may have half-run" (started, settle-only). Deliberately OUTSIDE
      // the try below: if this append fails the script never ran, so no
      // completion may be appended — the obligation stays `requested`, the
      // rethrow marks the keepalive window failed, and a later reconciliation
      // retries the whole attempt. (Same shape as the LLM providers.)
      await this.#awaitJournalAppend(
        this.append({
          type: "events.iterate.com/capability-host/script-run-started",
          idempotencyKey: this.idempotencyKey(`script-run-started@${input.executionId}`),
          payload: { executionId: input.executionId },
        }),
        executionExpiresAt,
        `record the start of script execution "${input.executionId}"`,
      );
      durableAttemptEvidenceCommitted = true;
      if (now() >= executionExpiresAt) {
        await this.#appendAndFoldCompletionWithin(
          {
            executionId: input.executionId,
            settlement: {
              status: "failed",
              error:
                "Script execution reached its absolute deadline after its start was recorded but before the worker was invoked. It never ran.",
              failureKind: "deadline",
              phase: "before-execution",
              executionMayHaveOccurred: false,
              cancellation: "not-applicable",
            },
          },
          input.expiresAt,
        );
        return;
      }

      // The entrypoint owns a timer around the dynamic-worker invocation, but
      // the RPC carrying that result back to this host is a second failure
      // boundary. Bound it independently: a half-open worker stub must not
      // keep the journal obligation (and the public runScript call) alive
      // forever even if the remote timer fired correctly.
      const runPromise = this.#scriptExecutionEntrypoint.run(input.code, {
        emittedJs: checked.emittedJs,
        expiresAt: executionExpiresAt,
      });
      const runOutcome = await settleByDeadline(runPromise, executionExpiresAt, now);
      if (runOutcome.status === "deadline") {
        // Workers RPC promises are disposable capabilities at runtime. End
        // this host's retained call as soon as its absolute wait expires;
        // the durable settlement still conservatively says arbitrary
        // external work may continue because disposal is not a cancellation
        // acknowledgement from code the script already invoked.
        (runPromise as Promise<unknown> & Partial<Disposable>)[Symbol.dispose]?.();
      }
      const settlement = settlementFromWorkerOutcome(runOutcome);
      // Deliberately outside the worker-invocation catch: a failed journal
      // append must never be reclassified as a script runtime failure. It
      // rejects this tracked attempt, and reconciliation retries the same
      // idempotent settlement.
      await this.#appendAndFoldCompletionWithin(
        { executionId: input.executionId, settlement },
        input.expiresAt,
      );
    } finally {
      this.#liveExecutions.delete(input.executionId);
      if (!durableAttemptEvidenceCommitted && !this.#pendingSettlements.has(input.executionId)) {
        this.#executionOwners.delete(input.executionId);
      }
    }
  }

  /**
   * Commit a terminal script fact and fold that exact offset through this
   * processor before the background attempt is considered settled. Normal
   * executions run off the processor chain, so this self-pull cannot deadlock;
   * inline recovery settlement deliberately uses #appendCompletionsWithin.
   */
  async #appendAndFoldCompletionWithin(
    input: { executionId: string; settlement: ScriptExecutionSettlementValue },
    obligationExpiresAt: number,
  ): Promise<void> {
    const [completed] = await this.#appendCompletionWithin(input, obligationExpiresAt);
    if (completed === undefined) {
      throw new Error(
        `script execution "${input.executionId}" completion append returned no event`,
      );
    }
    await this.#reads.waitUntilEvent({
      offset: completed.offset,
      timeoutMs: Math.max(
        1,
        obligationExpiresAt + SCRIPT_COMPLETION_OBSERVATION_GRACE_MS - (this.#now ?? Date.now)(),
      ),
    });
  }

  async #awaitJournalAppend<T>(
    append: Promise<T>,
    deadline: number,
    description: string,
  ): Promise<T> {
    const outcome = await settleByDeadline(append, deadline, this.#now ?? Date.now);
    if (outcome.status === "fulfilled") return outcome.value;
    if (outcome.status === "rejected") throw outcome.error;
    throw new Error(`Timed out while attempting to ${description}`);
  }

  #appendCompletionWithin(
    input: { executionId: string; settlement: ScriptExecutionSettlementValue },
    obligationExpiresAt: number,
  ) {
    return this.#appendCompletionsWithin([{ ...input, expiresAt: obligationExpiresAt }]);
  }

  #appendCompletionsWithin(
    inputs: {
      executionId: string;
      expiresAt: number;
      settlement: ScriptExecutionSettlementValue;
    }[],
  ) {
    if (inputs.length === 0) return Promise.resolve([]);
    for (const { executionId, settlement } of inputs) {
      this.#pendingSettlements.set(executionId, settlement);
    }
    const now = (this.#now ?? Date.now)();
    // Normal execution reserved this interval before obligation expiry. A
    // recovery pass necessarily runs after expiry, so give each idempotent
    // retry one fresh bounded interval instead of either failing instantly or
    // blocking the processor forever. A batch uses its earliest member's
    // deadline so batching cannot extend any individual obligation.
    const appendDeadline = settlementAppendDeadline(inputs, now);
    return this.#awaitJournalAppend(
      this.append(...inputs.map((input) => this.#completionInput(input))),
      appendDeadline,
      inputs.length === 1
        ? `record the settlement of script execution "${inputs[0]!.executionId}"`
        : `record ${inputs.length} script execution settlements`,
    );
  }

  /** The one durable outcome of a script execution. The reconciler's settle
   * path and the normal run share the idempotency key, so races collapse to
   * one completion at the append dedup layer. */
  #completionInput(input: { executionId: string; settlement: ScriptExecutionSettlementValue }) {
    return scriptCompletionInput({
      executionId: input.executionId,
      idempotencyKey: this.#completionIdempotencyKey(input.executionId),
      settlement: input.settlement,
    });
  }

  #completionIdempotencyKey(executionId: string): string {
    return this.idempotencyKey(`script-run-settled@${executionId}`);
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
