import { tracing, WorkerEntrypoint } from "cloudflare:workers";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import type { JsonValue } from "../workers/schemas.ts";
import {
  DYNAMIC_WORKER_COMPATIBILITY_DATE,
  DYNAMIC_WORKER_COMPATIBILITY_FLAGS,
} from "../workers/worker-runtime-configuration.ts";
import { stableSha256 } from "../workers/utils.ts";
import { settleByDeadline } from "./execution-deadline.ts";
import type { ScriptExecutionSettlement } from "./script-execution-settlement.ts";

const DEADLINE_EXCEEDED_ERROR =
  "Script execution exceeded its absolute deadline after it started. Its worker execution context ended, but arbitrary external work cannot be proven terminated. It may have partially executed; it was NOT re-run.";

// Sessionless sandbox exec uses up to six seconds after its timeout to TERM,
// KILL, and verify the Linux process group. Keep a larger margin for Workers
// RPC propagation and the durable completion append.
export const SCRIPT_EXTERNAL_CLEANUP_GRACE_MS = 15_000;

/**
 * Compute the timeout forwarded to one sandbox command inside a script. This
 * function is embedded into the generated worker, so tests and deployed code
 * share the exact deadline calculation.
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

type ScriptExecutorEnv = {
  CAPABILITY_HOST: DurableObjectNamespace;
  LOADER: WorkerLoader;
  PROJECT: DurableObjectNamespace;
};

/**
 * The authority a capability host lends to one script execution.
 *
 * Only durable coordinates cross from the host. The executor mints stable DO
 * stubs from its cross-script namespaces, so neither a native ServiceStub nor
 * a non-persistent incoming RpcStub has to be forwarded through Workers RPC.
 */
export type ScriptExecutionAuthority = {
  ownerWorkerName: string;
  projectId: string;
  scopePath: string;
};

export type ScriptExecutorRunInput = {
  authority: ScriptExecutionAuthority;
  code: string;
  /** Typechecker output whose default export is the script function. */
  emittedJs?: string;
  /** Absolute epoch-ms deadline for the complete dynamic-worker call. */
  expiresAt: number;
};

/**
 * Small, dedicated loader owner for itx scripts.
 *
 * CapabilityHostDurableObject owns the durable request/started/completed
 * journal. This stateless sidecar owns only Dynamic Worker load + invocation,
 * so every concurrent script receives an independent loader-owning request
 * without cold-starting the full OS application bundle.
 */
export class ScriptExecutorEntrypoint extends WorkerEntrypoint<ScriptExecutorEnv> {
  override fetch(): Response {
    return Response.json({ worker: "os-script-executor" }, { status: 404 });
  }

  async run(input: ScriptExecutorRunInput): Promise<ScriptExecutionSettlement> {
    return tracing.enterSpan("dynamic_worker.run_script.call", async (span) => {
      span.setAttribute("iterate.worker.kind", "run_script");
      span.setAttribute("iterate.worker.operation", "call");
      span.setAttribute("iterate.worker.source", "inline");
      span.setAttribute("iterate.worker.type", "stateless");

      const modules = scriptWorkerModules(input);
      const sourceHash = await stableSha256({
        mainModule: "main.js",
        modules,
        type: "itx-script",
      });
      const cacheKey = [
        "script-executor",
        input.authority.ownerWorkerName,
        input.authority.projectId,
        input.authority.scopePath,
        sourceHash,
      ].join(":");
      const capabilityHost = this.env.CAPABILITY_HOST.getByName(
        DurableObjectNameCodec.stringify({
          path: input.authority.scopePath,
          projectId: input.authority.projectId,
        }),
      );
      const globalOutbound = this.env.PROJECT.getByName(
        DurableObjectNameCodec.stringify({ path: "/", projectId: input.authority.projectId }),
      ) as unknown as Fetcher;
      const worker = this.env.LOADER.get(cacheKey, () => ({
        compatibilityDate: DYNAMIC_WORKER_COMPATIBILITY_DATE,
        compatibilityFlags: DYNAMIC_WORKER_COMPATIBILITY_FLAGS,
        env: { ITX_HOST: capabilityHost },
        globalOutbound,
        mainModule: "main.js",
        modules,
      }));
      const entrypoint = worker.getEntrypoint("ScriptEntrypoint", { props: {} }) as unknown as {
        run(): Promise<unknown>;
      };
      const runPromise = entrypoint.run();
      const outcome = await settleByDeadline(runPromise, input.expiresAt, Date.now);
      if (outcome.status === "deadline") {
        (runPromise as Promise<unknown> & Partial<Disposable>)[Symbol.dispose]?.();
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
          cancellation: "external-work-may-continue",
        };
      }
      const serializedResult =
        outcome.value === undefined ? undefined : JSON.stringify(outcome.value);
      return {
        status: "succeeded",
        ...(serializedResult === undefined
          ? {}
          : { result: JSON.parse(serializedResult) as JsonValue }),
      };
    });
  }
}

export function scriptWorkerModules(
  input: Pick<ScriptExecutorRunInput, "code" | "emittedJs" | "expiresAt">,
): Record<string, string> {
  // Preferred shape: run the gate's emitted module. When the permissive gate
  // was skipped or could not emit, embed the raw expression so ordinary
  // JavaScript still runs and TypeScript-only syntax fails explicitly in the
  // loader rather than being silently rewritten.
  const importLine = input.emittedJs === undefined ? "" : `import scriptModule from "./script.js";`;
  const fnSource = input.emittedJs === undefined ? input.code : "scriptModule";
  const sandboxExecTimeoutSource = sandboxExecTimeout.toString();
  const main = `
    import { WorkerEntrypoint } from "cloudflare:workers";
    ${importLine}
    const fn = ${fnSource};
    const executionDeadline = ${input.expiresAt};
    const externalCleanupGraceMs = ${SCRIPT_EXTERNAL_CLEANUP_GRACE_MS};
    const sandboxExecTimeout = ${sandboxExecTimeoutSource};

    function sandboxWithExecutionDeadline(sandbox) {
      return new Proxy(sandbox, {
        get(target, property) {
          if (property === "execStream") {
            return () => {
              throw new Error(
                "sandbox.execStream is unavailable inside scripts because the sandbox SDK cannot prove that cancelling its stream terminates the command process tree; use sandbox.exec instead",
              );
            };
          }
          if (property !== "exec") return Reflect.get(target, property, target);
          return (command, options = {}) => {
            const timeout = sandboxExecTimeout({
              executionDeadline,
              externalCleanupGraceMs,
              nowMs: Date.now(),
              requestedTimeout: options.timeout,
            });
            return target.exec(command, { ...options, timeout });
          };
        },
      });
    }

    function itxWithExecutionDeadline(itx) {
      const sandboxes = itx.sandboxes;
      const guardedSandboxes = new Proxy(sandboxes, {
        get(target, property) {
          if (property !== "get") return Reflect.get(target, property, target);
          return async (...args) => sandboxWithExecutionDeadline(await target.get(...args));
        },
      });
      return new Proxy(itx, {
        get(target, property) {
          return property === "sandboxes"
            ? guardedSandboxes
            : Reflect.get(target, property, target);
        },
      });
    }

    export class ScriptEntrypoint extends WorkerEntrypoint {
      async run() {
        using itx = await this.env.ITX_HOST.getItxForScript();
        return await fn(itxWithExecutionDeadline(itx));
      }
    }
  `;
  return input.emittedJs === undefined
    ? { "main.js": main }
    : { "main.js": main, "script.js": input.emittedJs };
}
