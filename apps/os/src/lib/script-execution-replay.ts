import { StreamEvent, type StreamEvent as StreamEventValue } from "~/domains/streams/schemas.ts";
import {
  ScriptExecutionSettlement,
  type ScriptExecutionSettlement as ScriptExecutionSettlementValue,
} from "~/domains/capability-host/script-execution-settlement.ts";

export const SCRIPT_EXECUTION_REQUESTED_EVENT_TYPE =
  "events.iterate.com/capability-host/script-execution-requested";
export const SCRIPT_EXECUTION_STARTED_EVENT_TYPE =
  "events.iterate.com/capability-host/script-execution-started";
export const SCRIPT_EXECUTION_COMPLETED_EVENT_TYPE =
  "events.iterate.com/capability-host/script-execution-completed";

export const SCRIPT_EXECUTION_REPLAY_EVENT_TYPES = [
  SCRIPT_EXECUTION_REQUESTED_EVENT_TYPE,
  SCRIPT_EXECUTION_STARTED_EVENT_TYPE,
  SCRIPT_EXECUTION_COMPLETED_EVENT_TYPE,
] as const;

const DEADLINE_BEFORE_START_ERROR =
  "The script deadline elapsed before a start or completion was recorded. The script did not run.";
const DEADLINE_AFTER_START_ERROR =
  "The script deadline elapsed after execution started without a completion event. It may have partially executed and was NOT re-run.";
const INVALID_COMPLETION_ERROR = "The durable script completion contained no valid settlement.";

export type ScriptExecutionReplay = {
  executionId: string;
  requestedOffset: number;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  expiresAtMs: number;
  code: string;
  outcome: {
    status: "queued" | "running" | "completed" | "failed";
    durationMs: number | null;
    errorMessage: string | null;
    settlement: ScriptExecutionSettlementValue | null;
    hasResult: boolean;
    result: unknown;
  };
};

/**
 * Rebuild one script run from the immutable requested/started/completed facts
 * in the browser's raw-event mirror. Malformed rows are skipped, matching the
 * mirror's other replay inspectors.
 */
export function replayScriptExecution(input: {
  rawEventJsons: readonly string[];
  executionId: string;
  nowMs: number;
}): ScriptExecutionReplay | null {
  if (!Number.isFinite(input.nowMs)) throw new Error(`invalid replay clock ${input.nowMs}`);
  const events = parseEventRows(input.rawEventJsons);
  const requested = events.find(
    (event) =>
      event.type === SCRIPT_EXECUTION_REQUESTED_EVENT_TYPE &&
      readExecutionId(event.payload) === input.executionId,
  );
  if (requested == null || !isRecord(requested.payload)) return null;

  const started = events.find(
    (event) =>
      event.type === SCRIPT_EXECUTION_STARTED_EVENT_TYPE &&
      readExecutionId(event.payload) === input.executionId,
  );
  const completed = events.find(
    (event) =>
      event.type === SCRIPT_EXECUTION_COMPLETED_EVENT_TYPE &&
      readExecutionId(event.payload) === input.executionId,
  );
  const expiresAtMs = requested.payload.expiresAt;
  // The current script-request contract requires one absolute deadline. A row
  // without it is malformed input, not an alternate lifecycle to support.
  if (typeof expiresAtMs !== "number" || !Number.isSafeInteger(expiresAtMs) || expiresAtMs <= 0) {
    return null;
  }
  const deadlineElapsed = completed == null && input.nowMs >= expiresAtMs;
  const completionPayload = isRecord(completed?.payload) ? completed.payload : null;
  const settlement = readSettlement(completionPayload?.settlement);
  const invalidCompletion = completed != null && settlement == null;
  const completionError = settlement?.status === "failed" ? settlement.error : null;
  const errorMessage = deadlineElapsed
    ? started == null
      ? DEADLINE_BEFORE_START_ERROR
      : DEADLINE_AFTER_START_ERROR
    : invalidCompletion
      ? INVALID_COMPLETION_ERROR
      : completionError;
  const failed = deadlineElapsed || invalidCompletion || settlement?.status === "failed";
  const hasResult = settlement?.status === "succeeded" && "result" in settlement;
  const result = settlement?.status === "succeeded" ? settlement.result : undefined;
  const durationMs = deadlineElapsed
    ? deriveDurationThrough(started ?? requested, expiresAtMs)
    : completed == null
      ? deriveDurationThrough(started ?? requested, input.nowMs)
      : deriveDurationMs(started ?? requested, completed);

  return {
    executionId: input.executionId,
    requestedOffset: requested.offset,
    requestedAt: requested.createdAt,
    startedAt: started?.createdAt ?? null,
    completedAt: completed?.createdAt ?? null,
    expiresAtMs,
    code: typeof requested.payload.code === "string" ? requested.payload.code : "",
    outcome: {
      status: failed
        ? "failed"
        : completed == null
          ? started == null
            ? "queued"
            : "running"
          : "completed",
      durationMs,
      errorMessage,
      settlement,
      hasResult,
      result,
    },
  };
}

function deriveDurationThrough(start: StreamEventValue, endMs: number): number | null {
  const startMs = Date.parse(start.createdAt);
  if (Number.isNaN(startMs)) return null;
  return Math.max(0, endMs - startMs);
}

function readExecutionId(payload: unknown): string | null {
  return isRecord(payload) && typeof payload.executionId === "string" ? payload.executionId : null;
}

function deriveDurationMs(
  start: StreamEventValue,
  completed: StreamEventValue | undefined,
): number | null {
  if (completed == null) return null;
  const startMs = Date.parse(start.createdAt);
  const completedMs = Date.parse(completed.createdAt);
  if (Number.isNaN(startMs) || Number.isNaN(completedMs)) return null;
  return Math.max(0, completedMs - startMs);
}

function parseEventRows(rawEventJsons: readonly string[]): StreamEventValue[] {
  const events: StreamEventValue[] = [];
  for (const rawJson of rawEventJsons) {
    try {
      const parsed = StreamEvent.safeParse(JSON.parse(rawJson));
      if (parsed.success) events.push(parsed.data);
    } catch {
      // Raw appends can be malformed; one bad row must not hide a valid run.
    }
  }
  return events;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function readSettlement(value: unknown): ScriptExecutionSettlementValue | null {
  const parsed = ScriptExecutionSettlement.safeParse(value);
  return parsed.success ? parsed.data : null;
}
