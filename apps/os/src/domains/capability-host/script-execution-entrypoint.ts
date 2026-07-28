import { WorkerEntrypoint } from "cloudflare:workers";
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
import { settleByDeadline } from "../execution-deadline.ts";
import { CapabilityHostProcessorContract } from "./capability-host-processor-contract.ts";
import { SCRIPT_EXTERNAL_CLEANUP_GRACE_MS } from "./script-execution-budgets.ts";
import {
  scriptCompletionInput,
  settlementFromScriptCompletionEvent,
  type ScriptExecutionSettlement,
} from "./script-execution-settlement.ts";

export { SCRIPT_EXTERNAL_CLEANUP_GRACE_MS } from "./script-execution-budgets.ts";

const DEADLINE_EXCEEDED_ERROR =
  "Script execution exceeded its absolute deadline after it started. Its worker execution context ended, but arbitrary external work cannot be proven terminated. It may have partially executed; it was NOT re-run.";
const SETTLEMENT_APPEND_ATTEMPT_TIMEOUT_MS = 5_000;

type ScriptExecutionStartOptions = {
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
  streamContext: Extract<StreamContext, { kind: "script-execution" }>;
  /** Exact lifetime on which the script-run-started obligation was committed. */
  streamId: string;
};

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
 * Stateless loopback executor for capability-host runScript.
 *
 * The capability-host Durable Object journals script lifecycle events, but this
 * entrypoint owns the Dynamic Worker load, invocation, AND durable settlement.
 * `start()` is only a short handoff: it schedules the long execution with this
 * entrypoint's own waitUntil and returns immediately. The host therefore never
 * retains a multi-minute Workers RPC result channel whose cancellation can
 * orphan otherwise healthy work.
 */
export class ScriptExecutionEntrypoint extends WorkerEntrypoint<
  Env,
  { projectId: string; scopePath: string }
> {
  start(code: string, options: ScriptExecutionStartOptions): void {
    this.ctx.waitUntil(this.#runAndSettle(code, options));
  }

  async #runAndSettle(code: string, options: ScriptExecutionStartOptions): Promise<void> {
    const projectId = this.ctx.props.projectId;
    const scopePath = normalizePath(this.ctx.props.scopePath);
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
    await appendScriptExecutionSettlement({
      executionId: options.streamContext.executionId,
      getStream: () =>
        this.env.STREAM.getByName(
          DurableObjectNameCodec.stringify({
            projectId,
            path: scopePath,
          }),
        ),
      projectId,
      scopePath,
      settlement,
      settlementExpiresAt: options.settlementExpiresAt,
      streamId: options.streamId,
    });
  }
}

/** Convert the dynamic worker's raw result into the one JSON settlement that
 * will be journaled. This runs in the independently-lived entrypoint, so every
 * terminal worker outcome is constructed before the direct stream append. */
export async function settlementFromScriptInvocation(
  invocation: Promise<unknown>,
  executionExpiresAt: number,
): Promise<ScriptExecutionSettlement> {
  const outcome = await settleByDeadline(invocation, executionExpiresAt, Date.now);
  if (outcome.status === "deadline") {
    // This timer lives in the RPC entrypoint that owns the dynamic-worker
    // call. Its expiry is not a cancellation acknowledgement for arbitrary
    // work the script may already have started. Sandbox exec has its own
    // earlier, process-tree terminating deadline; every other external
    // effect remains explicitly classified as possibly continuing.
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

export async function appendScriptExecutionSettlement(input: {
  executionId: string;
  getStream: () => ScriptSettlementStream;
  projectId: string;
  scopePath: string;
  settlement: ScriptExecutionSettlement;
  settlementExpiresAt: number;
  streamId: string;
}): Promise<void> {
  const idempotencyKey = `${CapabilityHostProcessorContract.slug}/script-run-settled@${input.executionId}`;
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
      const read = Promise.resolve(input.getStream().getEvent({ idempotencyKey }));
      const readOutcome = await settleByDeadline(
        read,
        Math.min(input.settlementExpiresAt, Date.now() + SETTLEMENT_APPEND_ATTEMPT_TIMEOUT_MS),
        Date.now,
      );
      if (readOutcome.status === "deadline") {
        void read.then(disposeIgnoredRpcResult, () => undefined);
        throw new Error("timed out reading back the script settlement");
      }
      if (readOutcome.status === "rejected") throw readOutcome.error;
      try {
        durableSettlement = settlementFromScriptCompletionEvent(
          readOutcome.value,
          input.executionId,
        );
      } finally {
        disposeIgnoredRpcResult(readOutcome.value);
      }
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
