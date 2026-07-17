import { tracing } from "cloudflare:workers";
import type { StreamEvent } from "../streams/schemas.ts";
import { StreamIdempotencyWaitTimeoutError } from "../streams/wait-for-idempotency-key.ts";
import { DEFAULT_SCRIPT_EXECUTION_EXPIRY_MS } from "./capability-host-processor-contract.ts";
import {
  SCRIPT_COMPLETION_OBSERVATION_GRACE_MS,
  scriptSettlementFromEvent,
  type ScriptExecutionSettlement,
} from "./script-execution-settlement.ts";
import {
  commitForegroundScriptSettlement,
  executeForegroundScript,
  type ForegroundScriptExecutor,
} from "./script-execution-foreground.ts";
import type { ScriptExecutionAuthority } from "./script-executor-entrypoint.ts";

export type { ForegroundScriptExecutor } from "./script-execution-foreground.ts";

/** One caller-owned, durably identifiable request to run a script. */
export type ScriptExecutionIntent = {
  code: string;
  executionId: string;
  expiresAt: number;
};

/** Resolve a caller-selected absolute lifetime without allowing one request to
 * extend the platform's bounded recovery window. */
export function scriptExecutionExpiresAt(now: number, timeoutMs?: number): number {
  const resolvedTimeoutMs = timeoutMs ?? DEFAULT_SCRIPT_EXECUTION_EXPIRY_MS;
  if (
    !Number.isSafeInteger(resolvedTimeoutMs) ||
    resolvedTimeoutMs < 1 ||
    resolvedTimeoutMs > DEFAULT_SCRIPT_EXECUTION_EXPIRY_MS
  ) {
    throw new Error(
      `script timeoutMs must be a positive safe integer no greater than ${DEFAULT_SCRIPT_EXECUTION_EXPIRY_MS}`,
    );
  }
  const expiresAt = now + resolvedTimeoutMs;
  if (!Number.isSafeInteger(expiresAt)) {
    throw new Error("script expiry must be an epoch-millisecond safe integer");
  }
  return expiresAt;
}

/**
 * The capability host's one-way handoff to an explicit execution driver.
 * `ready` is the only permission to invoke userspace. `observe` means an
 * obligation is still open but another driver owns (or may have owned) the
 * attempt; `settled` means its completion is already durable. Both replay
 * states may only wait for the exact durable outcome.
 */
export type ScriptExecutionHandoff = {
  completionIdempotencyKey: string;
  executionId: string;
  expiresAt: number;
  preparation:
    | { status: "observe" }
    | { status: "settled" }
    | {
        status: "ready";
        code: string;
        emittedJs?: string;
      };
};

/** The narrow durable-host surface needed by an execution driver. */
export type ScriptExecutionHost = {
  requestScript(input: ScriptExecutionIntent): Promise<ScriptExecutionHandoff>;
  settleScriptExecution(input: {
    executionId: string;
    settlement: ScriptExecutionSettlement;
  }): Promise<StreamEvent>;
};

type ScriptExecutionDriveResult = {
  completedEvent: StreamEvent;
  executionId: string;
  settlement: ScriptExecutionSettlement;
};

/**
 * Drive one deterministic script intent from a caller that is outside the
 * capability-host Durable Object. The host journals and grants at most one
 * `ready` handoff; replaying callers receive `observe`, so userspace is never
 * retried. Only the idempotent settlement handoff is retried.
 *
 * A failed userspace settlement is returned, not thrown. Public ITX converts
 * it to a caller error, while an Agent processor consumes the same durable
 * event as model-visible input without wedging its checkpoint.
 */
export async function driveScriptExecution(input: {
  authority: ScriptExecutionAuthority;
  executor: ForegroundScriptExecutor;
  host: ScriptExecutionHost;
  intent: ScriptExecutionIntent;
  observeCompletion(args: { idempotencyKey: string; timeoutMs: number }): Promise<StreamEvent>;
  /** Test seam only. */
  now?: () => number;
  /** Telemetry seam only. */
  onCommitFailure?: (input: { attempt: number; error: unknown }) => void;
}): Promise<ScriptExecutionDriveResult> {
  const now = input.now ?? Date.now;
  const handoff = await input.host.requestScript(input.intent);
  const observeCompletion = () =>
    input.observeCompletion({
      idempotencyKey: handoff.completionIdempotencyKey,
      timeoutMs: Math.max(1, handoff.expiresAt + SCRIPT_COMPLETION_OBSERVATION_GRACE_MS - now()),
    });

  let completedEvent: StreamEvent;
  try {
    if (handoff.preparation.status === "ready") {
      const preparation = handoff.preparation;
      // Do not open the completion WebSocket before invoking the executor.
      // It is intentionally long-lived and can otherwise occupy the exact
      // outbound request lane needed to create the event it waits for.
      const settlement = await tracing.enterSpan(
        "capability_host.script_foreground_execute",
        async (span) => {
          span.setAttribute("iterate.capability_host.execution_id", handoff.executionId);
          return await executeForegroundScript({
            authority: input.authority,
            executor: input.executor,
            preparation: {
              ...preparation,
              expiresAt: handoff.expiresAt,
            },
            now,
          });
        },
      );
      completedEvent = await tracing.enterSpan(
        "capability_host.script_settlement_commit",
        async (span) => {
          span.setAttribute("iterate.capability_host.execution_id", handoff.executionId);
          return await commitForegroundScriptSettlement({
            commit: () =>
              input.host.settleScriptExecution({
                executionId: handoff.executionId,
                settlement,
              }),
            observe: observeCompletion,
            onCommitFailure: input.onCommitFailure,
          });
        },
      );
    } else {
      completedEvent = await observeCompletion();
    }
  } catch (error) {
    if (error instanceof StreamIdempotencyWaitTimeoutError) {
      throw new Error(
        `Script execution "${handoff.executionId}" did not settle before its absolute deadline.`,
        { cause: error },
      );
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Script execution "${handoff.executionId}" settlement observation failed: ${detail}`,
      { cause: error },
    );
  }

  const settlement = scriptSettlementFromEvent(completedEvent, handoff.executionId);
  if (settlement === undefined) {
    throw new Error(`script execution "${handoff.executionId}" completed without a settlement`);
  }
  return {
    completedEvent,
    executionId: handoff.executionId,
    settlement,
  };
}
