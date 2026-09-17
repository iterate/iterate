// The agent's log as the shared agent-UI reducer (packages/ui) reads it. os-next's agent speaks
// apps/os's event vocabulary, so the feed model IS apps/os's: `reduceAgentUi` folds every committed
// event into messages and activities (an LLM step that wrote a script, the code step that ran it,
// grouped into rounds). Two differences are adapted here: an attachment carries no `url` on os-next (the
// page signs one when it renders), and a failed script settlement carries fewer fields than
// apps/os's strict schema (the missing ones follow from `failureKind`).
import { z } from "zod";
import { sliceText, type StreamText } from "@iterate-com/shared/chunked-text";
import { ZERO_AGENT_RUNTIME } from "@iterate-com/shared/agent-events";
import {
  formatAgentUiDuration,
  initialAgentUiState,
  reduceAgentUi,
  reduceAgentUiRuntime,
  type AgentUiItem,
  type AgentUiState,
  type AgentUiStep,
} from "@iterate-com/ui/components/events/agent-ui-reducer";
import type { Event } from "@iterate-com/ui/components/events/types";

// Loose: the Events view is the raw log, so every envelope field the wire carries survives.
const Committed = z.looseObject({
  offset: z.number().int().positive(),
  type: z.string(),
  createdAt: z.string(),
  payload: z.unknown().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  idempotencyKey: z.string().optional(),
});

/** A wire event (a capnweb proxy value or a plain object) as the reducer's `Event`, or null when it
 *  is not a committed row. */
export function toAgentEvent(raw: unknown, streamPath: string): Event | null {
  const parsed = Committed.safeParse(JSON.parse(JSON.stringify(raw)));
  if (!parsed.success) return null;
  const event = parsed.data;
  const payload = isRecord(event.payload) ? { ...event.payload } : event.payload;
  if (isRecord(payload) && Array.isArray(payload.files))
    payload.files = payload.files.map((file: unknown) =>
      isRecord(file) && typeof file.url !== "string" ? { ...file, url: "" } : file,
    );
  if (
    event.type === "events.iterate.com/capability-host/script-run-settled" &&
    isRecord(payload) &&
    isRecord(payload.settlement) &&
    payload.settlement.status === "failed"
  ) {
    const expired = payload.settlement.failureKind === "expired";
    payload.settlement = {
      phase: expired ? "before-execution" : "execution",
      executionMayHaveOccurred: !expired,
      cancellation: "not-applicable",
      ...payload.settlement,
    };
  }
  return { ...event, payload, streamPath };
}

/** The whole feed from the log: every event in offset order through the shared reducer, then —
 *  when the agent facet reports itself idle and no step is still running — the turn boundary
 *  apps/os learns from its runtime-changed event, dated at the last fact. */
export function reduceAgentFeed(
  events: readonly Event[],
  idle: boolean,
): { state: AgentUiState; items: AgentUiItem[] } {
  let state = initialAgentUiState();
  const items: AgentUiItem[] = [];
  for (const event of events) {
    const reduced = reduceAgentUi(state, event);
    state = reduced.endState;
    items.push(...reduced.items);
  }
  // A bare reply runs as a `reply:` script (the plain-response handler) — its message shows as a
  // normal bubble, so the redundant activity card is dropped from the feed (the trace still has it).
  const shown = items.filter(
    (item) =>
      item.kind !== "activity" ||
      !item.steps.some((step) => step.kind === "code") ||
      item.steps.some((step) => step.kind === "code" && !step.executionId.startsWith("reply:")),
  );
  items.length = 0;
  items.push(...shown);
  const last = events.at(-1);
  if (idle && last && state.live && !state.live.steps.some((step) => step.status === "running")) {
    const reduced = reduceAgentUiRuntime(state, {
      runtime: ZERO_AGENT_RUNTIME,
      sinceOffset: last.offset,
      since: last.createdAt,
    });
    state = reduced.endState;
    items.push(...reduced.items);
  }
  return { state, items };
}

// ── display formatters (apps/os's feed-format, the ones this page needs) ──

export const formatSeconds = (durationMs: number): string => formatAgentUiDuration(durationMs);

/** CLI-style elapsed clock for the live phase indicator: one decimal, no space (`0.9s`, `12.3s`). */
export function formatElapsedSeconds(durationMs: number): string {
  return `${(Math.max(0, durationMs) / 1000).toFixed(1)}s`;
}

export function formatClockTime(timestampMs: number): string {
  return new Date(timestampMs).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function formatDateTime(timestampMs: number): string {
  return new Date(timestampMs).toLocaleString([], { dateStyle: "medium", timeStyle: "medium" });
}

export function formatFileSize(size: number): string {
  if (size < 1024) return `${String(size)} B`;
  const kilobytes = size / 1024;
  if (kilobytes < 1024) return `${kilobytes.toFixed(1).replace(/\.0$/, "")} KB`;
  return `${(kilobytes / 1024).toFixed(1).replace(/\.0$/, "")} MB`;
}

const CODE_START_PATTERN = /^\s*(async|await|function|const|let|import)\b/;
const CODEMODE_TAG_PATTERN = /^[ \t]*<codemode(\s|>)/m;
/** A codemode answer renders as code; prose renders as markdown. */
export function looksLikeCode(text: StreamText): boolean {
  const prefix = typeof text === "string" ? text : sliceText(text, 0, 4096);
  return (
    prefix.includes("```") || CODE_START_PATTERN.test(prefix) || CODEMODE_TAG_PATTERN.test(prefix)
  );
}

/** What the live activity is doing, from its running steps. */
export function liveActivityLabel(runningSteps: readonly AgentUiStep[]): string {
  if (runningSteps.some((step) => step.kind === "code")) return "Running code";
  const llm = runningSteps.findLast((step) => step.kind === "llm");
  if (!llm) return "Working…";
  return "Waiting for a response";
}

/** A returned string is itself; anything else is pretty JSON (apps/os's stringifyScriptResult). */
export function stringifyScriptResult(result: unknown): string {
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result, null, 2) || String(result);
  } catch {
    return String(result);
  }
}

/** The event type without its `events.iterate.com/` prefix. */
export const shortEventType = (type: string): string => type.replace(/^events\.iterate\.com\//, "");

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === "[object Object]";
}

// ── traces ── what the model was sent and what it answered, rebuilt from the log the way the
// agent builds its request (every context item before the request, in order).

export type LlmTrace = {
  llmRequestOffset: number;
  model: string;
  requestedAtMs: number;
  messages: { offset: number; role: string; content: string }[];
  outcome:
    | { status: "in flight" }
    | { status: "succeeded"; text: string; durationMs?: number }
    | { status: "failed"; errorMessage: string; durationMs?: number }
    | { status: "cancelled"; reason?: string };
  /** What the loop derived from the answer: the prose it sent, the script it ran. */
  derived: { prose?: string; scriptExecutionId?: string };
};

export function llmTrace(events: readonly Event[], llmRequestOffset: number): LlmTrace | null {
  const requested = events.find((event) => event.offset === llmRequestOffset);
  if (!requested || requested.type !== "events.iterate.com/agent/llm-request-requested")
    return null;
  const payload = isRecord(requested.payload) ? requested.payload : {};
  const messages = events.flatMap((event) => {
    if (event.offset >= llmRequestOffset) return [];
    if (event.type !== "events.iterate.com/agents/context-added") return [];
    const p = isRecord(event.payload) ? event.payload : {};
    return typeof p.role === "string" && typeof p.content === "string"
      ? [{ offset: event.offset, role: p.role, content: p.content }]
      : [];
  });
  const settled = events.find((event) => {
    if (event.type !== "events.iterate.com/agent/llm-request-settled") return false;
    const p = isRecord(event.payload) ? event.payload : {};
    return p.requestOffset === llmRequestOffset;
  });
  const settledPayload = isRecord(settled?.payload) ? settled.payload : {};
  const result = isRecord(settledPayload.result) ? settledPayload.result : null;
  const durationMs =
    typeof settledPayload.durationMs === "number" ? settledPayload.durationMs : undefined;
  const outcome: LlmTrace["outcome"] = !result
    ? { status: "in flight" }
    : result.status === "succeeded"
      ? { status: "succeeded", text: String(result.text ?? ""), durationMs }
      : result.status === "failed"
        ? { status: "failed", errorMessage: String(result.errorMessage ?? ""), durationMs }
        : {
            status: "cancelled",
            reason: typeof result.reason === "string" ? result.reason : undefined,
          };
  const assistant = events.find((event) => {
    if (event.type !== "events.iterate.com/agents/context-added") return false;
    const p = isRecord(event.payload) ? event.payload : {};
    return p.role === "assistant" && p.llmRequestOffset === llmRequestOffset;
  });
  const prose = events.find((event) => {
    if (event.type !== "events.iterate.com/agents/web-message-sent") return false;
    const p = isRecord(event.payload) ? event.payload : {};
    return p.llmRequestOffset === llmRequestOffset;
  });
  // The script a response produced: a codemode action (`agent-output:`) or, for a bare reply, the
  // plain-response handler the platform ran (`reply:`). Both key off the assistant event's offset.
  const scriptExecutionId = assistant
    ? [`agent-output:${String(assistant.offset)}`, `reply:${String(assistant.offset)}`].find((id) =>
        events.some((event) => {
          if (event.type !== "events.iterate.com/capability-host/script-run-requested")
            return false;
          const p = isRecord(event.payload) ? event.payload : {};
          return p.executionId === id;
        }),
      )
    : undefined;
  return {
    llmRequestOffset,
    model: typeof payload.model === "string" ? payload.model : "?",
    requestedAtMs: Date.parse(requested.createdAt),
    messages,
    outcome,
    derived: {
      prose:
        prose && isRecord(prose.payload) && typeof prose.payload.message === "string"
          ? prose.payload.message
          : undefined,
      scriptExecutionId,
    },
  };
}

export type ScriptTrace = {
  executionId: string;
  code: string;
  requestedAtMs: number;
  expiresAtMs: number;
  settlement?: { atMs: number; value: unknown };
  /** What the agent was told about the outcome — the developer item the settlement rendered to. */
  rendered?: string;
};

export function scriptTrace(events: readonly Event[], executionId: string): ScriptTrace | null {
  const requested = events.find((event) => {
    if (event.type !== "events.iterate.com/capability-host/script-run-requested") return false;
    const p = isRecord(event.payload) ? event.payload : {};
    return p.executionId === executionId;
  });
  if (!requested) return null;
  const payload = isRecord(requested.payload) ? requested.payload : {};
  const settled = events.find((event) => {
    if (event.type !== "events.iterate.com/capability-host/script-run-settled") return false;
    const p = isRecord(event.payload) ? event.payload : {};
    return p.executionId === executionId;
  });
  const rendered = events.find((event) => {
    if (event.type !== "events.iterate.com/agents/context-added") return false;
    const p = isRecord(event.payload) ? event.payload : {};
    const actor = isRecord(p.actor) ? p.actor : {};
    return actor.type === "script" && actor.executionId === executionId;
  });
  return {
    executionId,
    code: typeof payload.code === "string" ? payload.code : "",
    requestedAtMs: Date.parse(requested.createdAt),
    expiresAtMs: typeof payload.expiresAt === "number" ? payload.expiresAt : 0,
    settlement: settled
      ? {
          atMs: Date.parse(settled.createdAt),
          value: isRecord(settled.payload) ? settled.payload.settlement : undefined,
        }
      : undefined,
    rendered:
      rendered && isRecord(rendered.payload) && typeof rendered.payload.content === "string"
        ? rendered.payload.content
        : undefined,
  };
}
