// The agent's log as the agent-UI reducer (events/agent-ui-reducer.ts) reads it: `reduceAgentUi`
// folds every committed event, the agent's and the context's script runs (`itx/run-requested` /
// `itx/run-settled`, identified by the request's offset) alike, into messages and activities (an
// LLM step that wrote a script, the code step that ran it, grouped into rounds).
import { z } from "zod";
import { AgentContract } from "iterate/agents/contract";
import { RunRequested, RunSettled, type RunSettlement } from "iterate/stream/run";
import { sliceText, type StreamText } from "./chunked-text.ts";
import {
  initialAgentUiState,
  reduceAgentUi,
  settleAgentUiAtIdleBoundary,
  type AgentUiItem,
  type AgentUiState,
  type AgentUiStep,
} from "./events/agent-ui-reducer.ts";
import type { StreamEvent } from "./events/stream-event.ts";

// Loose: the Events view is the raw log, so every envelope field the wire carries survives.
const Committed = z.looseObject({
  offset: z.number().int().positive(),
  type: z.string(),
  createdAt: z.string(),
  payload: z.unknown().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  idempotencyKey: z.string().optional(),
});

/** A wire event (a capnweb proxy value or a plain object) as the reducer's `StreamEvent`, or null
 *  when it is not a committed row. */
export function toAgentEvent(raw: unknown): StreamEvent | null {
  const parsed = Committed.safeParse(JSON.parse(JSON.stringify(raw)));
  return parsed.success ? parsed.data : null;
}

/** The whole feed from the log: every event in offset order through the reducer, then — when the
 *  agent facet reports itself idle — the turn boundary, dated at the last fact, which flushes what
 *  waits behind an activity whose every step has settled. */
export function reduceAgentFeed(
  events: readonly StreamEvent[],
  idle: boolean,
): { state: AgentUiState; items: AgentUiItem[] } {
  let state = initialAgentUiState();
  const items: AgentUiItem[] = [];
  for (const event of events) {
    const reduced = reduceAgentUi(state, event);
    state = reduced.endState;
    items.push(...reduced.items);
  }
  const last = events.at(-1);
  if (idle && last) {
    const reduced = settleAgentUiAtIdleBoundary(state, last.createdAt);
    state = reduced.endState;
    items.push(...reduced.items);
  }
  return { state, items };
}

// ── display formatters ──

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

/** The llm request behind each assistant bubble (its item id → the request offset), so clicking the
 *  message opens its trace: a `web-message-sent` names its request directly. */
export function traceOffsetByMessage(events: readonly StreamEvent[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const event of events) {
    if (event.type !== "events.iterate.com/agent/web-message-sent") continue;
    const p = isRecord(event.payload) ? event.payload : {};
    if (typeof p.llmRequestOffset === "number")
      map.set(`assistant-${String(event.offset)}`, p.llmRequestOffset);
  }
  return map;
}

function isRecord(value: unknown): value is Record<string, unknown> {
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
  /** What the loop derived from the answer: the prose it sent, the run of the script it wrote (its
   *  `itx/run-requested` offset). */
  derived: { prose?: string; scriptRequestOffset?: number };
};

export function llmTrace(
  events: readonly StreamEvent[],
  llmRequestOffset: number,
): LlmTrace | null {
  const requested = events.find((event) => event.offset === llmRequestOffset);
  if (!requested || requested.type !== "events.iterate.com/agent/llm-request-requested")
    return null;
  const payload = isRecord(requested.payload) ? requested.payload : {};
  const messages = events.flatMap((event) => {
    if (event.offset >= llmRequestOffset) return [];
    if (event.type !== "events.iterate.com/agent/context-added") return [];
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
    if (event.type !== "events.iterate.com/agent/context-added") return false;
    const p = isRecord(event.payload) ? event.payload : {};
    return p.role === "assistant" && p.llmRequestOffset === llmRequestOffset;
  });
  const prose = events.find((event) => {
    if (event.type !== "events.iterate.com/agent/web-message-sent") return false;
    const p = isRecord(event.payload) ? event.payload : {};
    return p.llmRequestOffset === llmRequestOffset;
  });
  // The run of the script the response wrote: the one the agent asked for while processing the
  // assistant item (the engine's `whileProcessing` stamp).
  const scriptRequest = assistant
    ? events.find(
        (event) =>
          event.type === "events.iterate.com/itx/run-requested" &&
          event.source?.processor?.whileProcessing?.offset === assistant.offset,
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
      scriptRequestOffset: scriptRequest?.offset,
    },
  };
}

const ContextAdded = AgentContract.events["events.iterate.com/agent/context-added"].payloadSchema;

type ScriptTrace = {
  requestOffset: number;
  code: string;
  requestedAtMs: number;
  settlement?: { atMs: number; value: RunSettlement };
  /** What the agent was told about the outcome — the developer item the settlement rendered to. */
  rendered?: string;
};

/** One script run by its `itx/run-requested` offset: the code, its `itx/run-settled` and the
 *  developer item that told the agent (its script actor names the request's offset). */
export function scriptTrace(
  events: readonly StreamEvent[],
  requestOffset: number,
): ScriptTrace | null {
  const requested = events.find(
    (event) =>
      event.offset === requestOffset && event.type === "events.iterate.com/itx/run-requested",
  );
  const request = RunRequested.safeParse(requested?.payload);
  if (!requested || !request.success) return null;
  const [settlement] = events.flatMap((event) => {
    if (event.type !== "events.iterate.com/itx/run-settled") return [];
    const settled = RunSettled.safeParse(event.payload);
    return settled.success && settled.data.requestOffset === requestOffset
      ? [{ atMs: Date.parse(event.createdAt), value: settled.data.settlement }]
      : [];
  });
  const [rendered] = events.flatMap((event) => {
    if (event.type !== "events.iterate.com/agent/context-added") return [];
    const item = ContextAdded.safeParse(event.payload);
    return item.success &&
      item.data.actor?.type === "script" &&
      item.data.actor.requestOffset === requestOffset
      ? [item.data.content]
      : [];
  });
  return {
    requestOffset,
    code: request.data.code,
    requestedAtMs: Date.parse(requested.createdAt),
    settlement,
    rendered,
  };
}
