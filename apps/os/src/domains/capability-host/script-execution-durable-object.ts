import { DurableObject } from "cloudflare:workers";
import {
  isStreamIdMismatchError,
  type StreamEvent,
  type StreamEventInput,
} from "iterate/processors";
import { disposeIgnoredRpcResult } from "iterate/sdk/capnweb";
import type { Env } from "../../env.ts";
import { DurableObjectNameCodec, normalizePath } from "../durable-object-names.ts";
import type { StreamContext } from "../projects/stream-context.ts";
import {
  retryIdempotentDurableObjectOperation,
  STREAM_UNAVAILABLE_MESSAGE_PREFIX,
} from "../streams/stream-unavailable.ts";
import type { JsonValue, StatelessDynamicWorkerRef } from "../workers/schemas.ts";
import { DynamicWorkerRunner } from "../workers/worker-runner.ts";
import { stableSha256 } from "../workers/utils.ts";
import { settleByDeadline } from "../execution-deadline.ts";
import { CapabilityHostProcessorContract } from "./capability-host-processor-contract.ts";
import { SCRIPT_EXTERNAL_CLEANUP_GRACE_MS } from "./script-execution-budgets.ts";
import {
  scriptCompletionInput,
  settlementForUndrivenScript,
  settlementFromScriptCompletionEvent,
  type ScriptExecutionSettlement,
} from "./script-execution-settlement.ts";

export { SCRIPT_EXTERNAL_CLEANUP_GRACE_MS } from "./script-execution-budgets.ts";

const DEADLINE_EXCEEDED_ERROR =
  "Script execution exceeded its absolute deadline after it started. Its worker execution context ended, but arbitrary external work cannot be proven terminated. It may have partially executed; it was NOT re-run.";
const SETTLEMENT_APPEND_ATTEMPT_TIMEOUT_MS = 5_000;

export type ScriptExecutionStartOptions = {
  /**
   * The typecheck gate's emitted JavaScript for this script (its default
   * export is the script function) — check and emit are one compile, so
   * running the compiler's own output is what makes scripts genuinely
   * TypeScript. Absent when the gate was skipped or the sidecar was
   * unreachable: then `code` embeds raw, which still runs every
   * plain-JavaScript script and surfaces TS-only syntax as the loader's
   * error into the corrective-retry lane.
   */
  emittedJs?: string;
  /** Absolute epoch-ms deadline for the dynamic-worker call. */
  executionExpiresAt: number;
  /** Later absolute deadline reserved for committing the durable settlement. */
  settlementExpiresAt: number;
  /** Project whose scoped capability tree the script receives. */
  projectId: string;
  /** Exact capability-host scope in which the script executes. */
  scopePath: string;
  streamContext: Extract<StreamContext, { kind: "script-execution" }>;
  /** Exact lifetime on which the script-run-started obligation was committed. */
  streamId: string;
};

type ScriptExecutionRequest = {
  code: string;
  options: ScriptExecutionStartOptions;
};

type ScriptExecutionState =
  | {
      fingerprint: string;
      phase: "queued";
      request: ScriptExecutionRequest;
    }
  | {
      fingerprint: string;
      phase: "running";
      request: ScriptExecutionRequest;
    }
  | {
      fingerprint: string;
      phase: "settling";
      request: ScriptExecutionRequest;
      settlement: ScriptExecutionSettlement;
    }
  | {
      fingerprint: string;
      phase: "settled";
    };

const SCRIPT_EXECUTION_STATE_KEY = "script-execution:state";

/**
 * Return the globally unique, bounded Durable Object name for one immutable
 * script execution. Execution ids are offsets local to a scope stream (for
 * example `agent-output:166`), so using one directly aliases unrelated
 * projects and reset stream lifetimes in the global DO namespace.
 */
export async function scriptExecutionDurableObjectName(
  options: Pick<
    ScriptExecutionStartOptions,
    "projectId" | "scopePath" | "streamContext" | "streamId"
  >,
): Promise<string> {
  const digest = await stableSha256({
    executionId: options.streamContext.executionId,
    projectId: options.projectId,
    scopePath: normalizePath(options.scopePath),
    streamId: options.streamId,
  });
  return `script-execution:v2:${digest}`;
}

/**
 * Compute the timeout forwarded to one sandbox command inside a script. This
 * exact function is embedded into the generated worker below (via
 * Function#toString), so the executable unit tests and the deployed script
 * cannot drift into two subtly different deadline calculations.
 */
export function sandboxExecTimeout(input: {
  executionDeadline: number;
  externalCleanupGraceMs: number;
  nowMs: number;
  requestedTimeout: unknown;
}): number {
  const remainingMs = input.executionDeadline - input.nowMs - input.externalCleanupGraceMs;
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    throw new Error("Script deadline left no time to start a sandbox command");
  }
  const requestedTimeout = input.requestedTimeout;
  const boundedRequestedTimeout =
    typeof requestedTimeout === "number" &&
    Number.isFinite(requestedTimeout) &&
    requestedTimeout > 0
      ? requestedTimeout
      : remainingMs;
  return Math.max(1, Math.min(remainingMs, boundedRequestedTimeout));
}

/**
 * One alarm-owned executor per immutable script execution id.
 *
 * `start()` persists and arms only. The alarm owns the full Dynamic Worker
 * invocation, which gives a script the alarm handler's multi-minute lifetime
 * instead of the 30-second tail of an already-returned request. The persisted
 * phase is also the at-most-once fence:
 *
 * - queued may invoke once, after first persisting running;
 * - a recovered running phase first accepts an already-committed keyed
 *   settlement, otherwise it is settled orphaned and is never invoked again;
 * - settling retries only the exact keyed stream append;
 * - settled is a permanent, compact tombstone for duplicate handoffs.
 *
 * A terminal invocation result is appended to the stream before replacing
 * `running` with the compact tombstone. If executor storage resets at that
 * boundary, the alarm retry can recover the exact keyed stream fact instead
 * of misclassifying the completed script as orphaned.
 *
 * This deliberately prefers an explicit possibly-partial failure over replaying
 * arbitrary user code after an actor reset.
 */
export class ScriptExecutionDurableObject extends DurableObject<Env> {
  async start(code: string, options: ScriptExecutionStartOptions): Promise<void> {
    await this.#assertIdentity(options);
    const request = normalizedScriptExecutionRequest(code, options);
    const fingerprint = await stableSha256(request);

    await this.ctx.blockConcurrencyWhile(async () => {
      const state = this.#state();
      if (state !== undefined) {
        if (state.fingerprint !== fingerprint) {
          throw new TypeError(
            `script execution "${options.streamContext.executionId}" received a mismatched duplicate handoff`,
          );
        }
        // A previous setAlarm acknowledgement may have been lost. Re-arming
        // the still-queued exact request is idempotent; every later phase
        // already has an owner or is terminal.
        if (state.phase === "queued") await this.ctx.storage.setAlarm(Date.now());
        return;
      }

      this.#putState({ fingerprint, phase: "queued", request });
      await this.ctx.storage.setAlarm(Date.now());
    });
  }

  async alarm(): Promise<void> {
    const state = this.#state();
    if (state === undefined || state.phase === "settled") return;
    if (state.phase === "settling") {
      await this.#appendAndFinish(state);
      return;
    }
    if (state.phase === "running") {
      const committedSettlement = await readScriptExecutionSettlement({
        executionId: state.request.options.streamContext.executionId,
        getStream: () => this.#settlementStream(state.request.options),
        settlementExpiresAt: state.request.options.settlementExpiresAt,
      });
      if (committedSettlement !== undefined) {
        console.info("[script-execution] recovered committed settlement after executor reset", {
          executionId: state.request.options.streamContext.executionId,
          status: committedSettlement.status,
        });
        this.#putState({ fingerprint: state.fingerprint, phase: "settled" });
        return;
      }

      console.warn("[script-execution] recovered interrupted alarm without replaying script", {
        executionId: state.request.options.streamContext.executionId,
      });
      const settling: Extract<ScriptExecutionState, { phase: "settling" }> = {
        ...state,
        phase: "settling",
        settlement: settlementForUndrivenScript("started"),
      };
      await this.#appendAndFinish(settling);
      return;
    }

    const { request } = state;
    const { options } = request;
    let settlement: ScriptExecutionSettlement;
    if (Date.now() >= options.executionExpiresAt) {
      settlement = {
        status: "failed",
        error:
          "Script execution reached its absolute deadline after alarm ownership was committed but before the worker was invoked. It never ran.",
        failureKind: "deadline",
        phase: "before-execution",
        executionMayHaveOccurred: false,
        cancellation: "not-applicable",
      };
    } else {
      // This durable write is the at-most-once boundary. If the alarm dies
      // anywhere after it, its native retry observes `running`, records an
      // orphaned outcome, and never invokes the arbitrary body again.
      this.#putState({ ...state, phase: "running" });
      settlement = await this.#invoke(request);
    }

    await this.#appendAndFinish({
      fingerprint: state.fingerprint,
      phase: "settling",
      request,
      settlement,
    });
  }

  async #invoke({ code, options }: ScriptExecutionRequest): Promise<ScriptExecutionSettlement> {
    const projectId = options.projectId;
    const scopePath = options.scopePath;
    const dynamicWorkers = new DynamicWorkerRunner({
      streamContext: options.streamContext,
      exports: this.ctx.exports,
      projectId,
      scopePath,
    });

    // Scripts execute inside THIS scope: the loaded worker's env.ITX resolves
    // to the same path the capability host owns.
    const invocation = dynamicWorkers.invokeCapability({
      path: ["run"],
      ref: scriptWorkerRef({
        code,
        emittedJs: options.emittedJs,
        expiresAt: options.executionExpiresAt,
        scopePath,
      }),
      traceRole: "run_script",
    });
    const settlement = await settlementFromScriptInvocation(invocation, options.executionExpiresAt);
    return settlement;
  }

  async #appendAndFinish(
    state: Extract<ScriptExecutionState, { phase: "settling" }>,
  ): Promise<void> {
    const { options } = state.request;
    try {
      await appendScriptExecutionSettlement({
        executionId: options.streamContext.executionId,
        getStream: () => this.#settlementStream(options),
        projectId: options.projectId,
        scopePath: options.scopePath,
        settlement: state.settlement,
        settlementExpiresAt: options.settlementExpiresAt,
        streamId: options.streamId,
      });
    } catch (error) {
      // Preserve the exact terminal result only when its authoritative stream
      // append could not be confirmed. An alarm retry can then replay that
      // keyed append without invoking arbitrary code again.
      this.#putState(state);
      throw error;
    }
    this.#putState({ fingerprint: state.fingerprint, phase: "settled" });
  }

  #settlementStream(options: ScriptExecutionStartOptions): ScriptSettlementStream {
    return this.env.STREAM.getByName(
      DurableObjectNameCodec.stringify({
        projectId: options.projectId,
        path: options.scopePath,
      }),
    );
  }

  async #assertIdentity(options: ScriptExecutionStartOptions): Promise<void> {
    const executionId = options.streamContext.executionId;
    const expectedName = await scriptExecutionDurableObjectName(options);
    if (this.ctx.id.name !== expectedName) {
      throw new TypeError(
        `script execution "${executionId}" does not match executor identity "${this.ctx.id.name}"`,
      );
    }
  }

  #state(): ScriptExecutionState | undefined {
    return this.ctx.storage.kv.get<ScriptExecutionState>(SCRIPT_EXECUTION_STATE_KEY);
  }

  #putState(state: ScriptExecutionState): void {
    this.ctx.storage.kv.put(SCRIPT_EXECUTION_STATE_KEY, state);
  }
}

function normalizedScriptExecutionRequest(
  code: string,
  options: ScriptExecutionStartOptions,
): ScriptExecutionRequest {
  return {
    code,
    options: {
      ...options,
      scopePath: normalizePath(options.scopePath),
    },
  };
}

/** Convert the dynamic worker's raw result into the one JSON settlement that
 * will be journaled. This runs in the independently-lived executor, so every
 * terminal worker outcome is constructed before the direct stream append. */
export async function settlementFromScriptInvocation(
  invocation: Promise<unknown>,
  executionExpiresAt: number,
): Promise<ScriptExecutionSettlement> {
  const outcome = await settleByDeadline(invocation, executionExpiresAt, Date.now);
  if (outcome.status === "deadline") {
    // This timer lives in the alarm handler that owns the dynamic-worker call.
    // Its expiry is not a cancellation acknowledgement for arbitrary work the
    // script may already have started. Sandbox exec has its own earlier,
    // process-tree terminating deadline; every other external effect remains
    // explicitly classified as possibly continuing.
    return {
      status: "failed",
      error: DEADLINE_EXCEEDED_ERROR,
      failureKind: "deadline",
      phase: "execution",
      executionMayHaveOccurred: true,
      cancellation: "external-work-may-continue",
    };
  }
  if (outcome.status === "rejected") {
    return {
      status: "failed",
      error: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
      failureKind: "runtime",
      phase: "execution",
      executionMayHaveOccurred: true,
      // A rejected worker call proves this handler stopped waiting, not that
      // arbitrary fire-and-forget capability work has terminated.
      cancellation: "external-work-may-continue",
    };
  }

  try {
    const result = outcome.value;
    // This is an RPC/event JSON boundary, not a deep-clone operation. Preserve
    // JSON's deliberate normalization and rejection semantics (Dates become
    // strings; unsupported/cyclic values fail) instead of structuredClone's
    // broader value model.
    const serializedResult = result === undefined ? undefined : JSON.stringify(result);
    return {
      status: "succeeded",
      ...(serializedResult === undefined
        ? {}
        : { result: JSON.parse(serializedResult) as JsonValue }),
    };
  } catch (error) {
    return {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      failureKind: "runtime",
      phase: "execution",
      executionMayHaveOccurred: true,
      cancellation: "external-work-may-continue",
    };
  }
}

/**
 * Commit the executor-owned terminal fact onto the exact stream lifetime that
 * recorded `script-run-started`. The event is keyed, so one lifecycle replay
 * is safe; a lost acknowledgement is accepted only after reading back a valid
 * settlement under that same execution key.
 */
type ScriptSettlementStream = {
  appendIfStreamId(args: {
    streamId: string;
    events: StreamEventInput[];
  }): Promise<StreamEvent[]> | StreamEvent[];
  getEvent(args: {
    idempotencyKey: string;
  }): Promise<StreamEvent | undefined> | StreamEvent | undefined;
};

function scriptExecutionSettlementIdempotencyKey(executionId: string): string {
  return `${CapabilityHostProcessorContract.slug}/script-run-settled@${executionId}`;
}

async function readScriptExecutionSettlement(input: {
  executionId: string;
  getStream: () => ScriptSettlementStream;
  settlementExpiresAt: number;
}): Promise<ScriptExecutionSettlement | undefined> {
  const idempotencyKey = scriptExecutionSettlementIdempotencyKey(input.executionId);
  const read = Promise.resolve(input.getStream().getEvent({ idempotencyKey }));
  const readOutcome = await settleByDeadline(
    read,
    Math.min(input.settlementExpiresAt, Date.now() + SETTLEMENT_APPEND_ATTEMPT_TIMEOUT_MS),
    Date.now,
  );
  if (readOutcome.status === "deadline") {
    void read.then(disposeIgnoredRpcResult, () => undefined);
    throw new Error(
      `${STREAM_UNAVAILABLE_MESSAGE_PREFIX}script settlement read received no response within ` +
        `${SETTLEMENT_APPEND_ATTEMPT_TIMEOUT_MS}ms`,
    );
  }
  if (readOutcome.status === "rejected") throw readOutcome.error;
  try {
    return settlementFromScriptCompletionEvent(readOutcome.value, input.executionId);
  } finally {
    disposeIgnoredRpcResult(readOutcome.value);
  }
}

export async function appendScriptExecutionSettlement(input: {
  executionId: string;
  getStream: () => ScriptSettlementStream;
  projectId: string;
  scopePath: string;
  settlement: ScriptExecutionSettlement;
  settlementExpiresAt: number;
  streamId: string;
}): Promise<void> {
  const idempotencyKey = scriptExecutionSettlementIdempotencyKey(input.executionId);
  const event: StreamEventInput = {
    ...scriptCompletionInput({
      executionId: input.executionId,
      idempotencyKey,
      settlement: input.settlement,
    }),
    source: {
      processor: {
        slug: CapabilityHostProcessorContract.slug,
        version: CapabilityHostProcessorContract.version,
        stream: {
          path: input.scopePath,
          projectId: input.projectId,
          streamId: input.streamId,
        },
      },
    },
  };

  try {
    await retryIdempotentDurableObjectOperation({
      operation: async () => {
        const invocation = Promise.resolve(
          input.getStream().appendIfStreamId({
            streamId: input.streamId,
            events: [event],
          }),
        );
        const outcome = await settleByDeadline(
          invocation,
          Math.min(input.settlementExpiresAt, Date.now() + SETTLEMENT_APPEND_ATTEMPT_TIMEOUT_MS),
          Date.now,
        );
        if (outcome.status === "fulfilled") {
          disposeIgnoredRpcResult(outcome.value);
          return;
        }
        if (outcome.status === "rejected") throw outcome.error;
        // A late keyed append may still commit. Observe/release its result; the
        // one permitted replay carries the exact same body and therefore
        // dedupes if the first acknowledgement alone was lost.
        void invocation.then(disposeIgnoredRpcResult, () => undefined);
        throw new Error(
          `${STREAM_UNAVAILABLE_MESSAGE_PREFIX}script settlement append received no response within ` +
            `${SETTLEMENT_APPEND_ATTEMPT_TIMEOUT_MS}ms`,
        );
      },
      onRetry: ({ attempt, error, maxAttempts }) => {
        console.warn("[script-execution] retrying keyed settlement append", {
          attempt,
          error,
          executionId: input.executionId,
          maxAttempts,
          path: input.scopePath,
          projectId: input.projectId,
        });
      },
    });
    return;
  } catch (appendError) {
    if (isStreamIdMismatchError(appendError)) {
      // Deleting/recreating the stream closes the old lifetime and all of its
      // obligations. Never leak the old executor's outcome into the new log.
      console.info("[script-execution] settlement abandoned with replaced stream lifetime", {
        executionId: input.executionId,
        path: input.scopePath,
        projectId: input.projectId,
        streamId: input.streamId,
      });
      return;
    }

    let durableSettlement: ScriptExecutionSettlement | undefined;
    try {
      durableSettlement = await readScriptExecutionSettlement({
        executionId: input.executionId,
        getStream: input.getStream,
        settlementExpiresAt: input.settlementExpiresAt,
      });
      if (durableSettlement === undefined) throw appendError;
    } catch (verificationError) {
      if (verificationError === appendError) throw appendError;
      throw new AggregateError(
        [appendError, verificationError],
        "script executor settlement append failed and its durable outcome could not be verified",
      );
    }

    console.info("[script-execution] late settlement superseded by durable outcome", {
      attemptedFailureKind:
        input.settlement.status === "failed" ? input.settlement.failureKind : undefined,
      attemptedStatus: input.settlement.status,
      durableFailureKind:
        durableSettlement.status === "failed" ? durableSettlement.failureKind : undefined,
      durableStatus: durableSettlement.status,
      executionId: input.executionId,
    });
  }
}

export function scriptWorkerRef(input: {
  code: string;
  emittedJs?: string;
  expiresAt: number;
  scopePath: string;
}): StatelessDynamicWorkerRef {
  // Preferred shape: the gate's emitted module (default export = the script
  // function) as its own file, imported by the harness — the compiler's
  // type-stripped output is what runs. Fallback shape (no emit available):
  // embed the raw code as an expression, exactly the pre-gate behavior.
  const scriptModule = input.emittedJs;
  const fnSource = scriptModule === undefined ? input.code : `scriptModule`;
  const importLine = scriptModule === undefined ? "" : `import scriptModule from "./script.js";`;
  const sandboxExecTimeoutSource = sandboxExecTimeout.toString();
  const source = `
    import { WorkerEntrypoint } from "cloudflare:workers";
    ${importLine}
    const fn = ${fnSource};
    const executionDeadline = ${input.expiresAt};
    const externalCleanupGraceMs = ${SCRIPT_EXTERNAL_CLEANUP_GRACE_MS};
    const sandboxExecTimeout = ${sandboxExecTimeoutSource};

    function receiverSafeProperty(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      // Cap'n Web path handles are callable Proxies: a value such as
      // itx.agents must retain both its call surface and child properties such
      // as .get. Replacing every function with a bound arrow preserves calls
      // but collapses those paths into plain functions. Proxy apply instead,
      // and recursively preserve the real receiver for any child method.
      return new Proxy(value, {
        apply(callable, _receiver, args) {
          return Reflect.apply(callable, target, args);
        },
        get(callable, childProperty) {
          return receiverSafeProperty(callable, childProperty);
        },
      });
    }

    function sandboxWithExecutionDeadline(sandbox, resolved = false) {
      return new Proxy(sandbox, {
        get(target, property) {
          if (property === "then") {
            // The pipelined handle is thenable. Preserve its receiver while
            // re-wrapping the fulfilled stub so awaiting sandboxes.get(...)
            // cannot escape the execution-deadline guard. The fulfilled
            // wrapper must no longer look thenable or promise resolution
            // would recursively assimilate it.
            if (resolved) return undefined;
            const then = Reflect.get(target, property, target);
            if (typeof then !== "function") return then;
            return (onFulfilled, onRejected) =>
              Reflect.apply(then, target, [
                typeof onFulfilled === "function"
                  ? (value) => onFulfilled(sandboxWithExecutionDeadline(value, true))
                  : onFulfilled,
                onRejected,
              ]);
          }
          if (property === "execStream") {
            return () => {
              throw new Error(
                "sandbox.execStream is unavailable inside scripts because the sandbox SDK cannot prove that cancelling its stream terminates the command process tree; use sandbox.exec instead",
              );
            };
          }
          if (property !== "exec") return receiverSafeProperty(target, property);
          const exec = Reflect.get(target, property, target);
          return (command, options = {}) => {
            const timeout = sandboxExecTimeout({
              executionDeadline,
              externalCleanupGraceMs,
              nowMs: Date.now(),
              requestedTimeout: options.timeout,
            });
            return Reflect.apply(exec, target, [command, { ...options, timeout }]);
          };
        },
      });
    }

    function itxWithExecutionDeadline(itx) {
      const sandboxes = itx.sandboxes;
      const guardedSandboxes = new Proxy(sandboxes, {
        get(target, property) {
          if (property !== "get") return receiverSafeProperty(target, property);
          // Collection.get() is deliberately synchronous: capnweb returns a
          // pipelined handle whose methods (including create) can be called
          // before any round trip. Awaiting it here turns that handle into a
          // plain Promise and erases the handle-level surface.
          const get = Reflect.get(target, property, target);
          return (...args) =>
            sandboxWithExecutionDeadline(Reflect.apply(get, target, args));
        },
      });
      return new Proxy(itx, {
        get(target, property) {
          return property === "sandboxes"
            ? guardedSandboxes
            : receiverSafeProperty(target, property);
        },
      });
    }

    export class ScriptEntrypoint extends WorkerEntrypoint {
      async run() {
        // \`using\`: the itx root is an RPC stub this isolate owns for the
        // script's duration; releasing it on return (the result is fully
        // awaited by then) keeps the runtime's stub-disposal warning out of
        // the logs. Values the script obtained THROUGH it (returned stubs,
        // appended events) hold their own references and are unaffected.
        using itx = await this.env.ITX.get();
        return await fn(itxWithExecutionDeadline(itx));
      }
    }
  `;
  // runScript is deliberately expressed as a stateless inline DynamicWorkerRef.
  // That keeps script execution on the same DynamicWorkerRunner dispatch path as
  // project workers and provided stateless capabilities; itx adds only the
  // journal events. `bundle: false` asks worker-bundler for its transform-only
  // path, avoiding an esbuild bundle while retaining the same cached build
  // contract as every other dynamic Worker.
  return {
    path: input.scopePath,
    source: {
      createWorker: {
        bundle: false,
        entryPoint: "main.js",
        files: {
          files:
            scriptModule === undefined
              ? { "main.js": source }
              : { "main.js": source, "script.js": scriptModule },
          type: "inline",
        },
      },
    },
    entrypoint: "ScriptEntrypoint",
    type: "stateless",
  };
}
