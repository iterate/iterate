// The agent's log as the shared agent-UI reducer (packages/ui) reads it. The agent speaks the
// shared reducer's event vocabulary for the loop, so `reduceAgentUi` folds every committed event
// into messages and activities (an LLM step that wrote a script, the code step that ran it, grouped
// into rounds). Two differences are adapted here: an attachment carries no `url` on apps/os (the
// page signs one when it renders); and a SCRIPT is the CONTEXT's on apps/os —
// `context/run-requested` / `context/run-settled`, identified by the request's offset
// (apps/os/src/stream/core-processor.ts) — where the shared reducer reads
// `capability-host/script-run-*` with an `executionId`. `adaptContextRuns` renames the one into the
// other and fills in the fields a failed settlement lacks under the shared reducer's strict schema.
import { z } from "zod";
import { sliceText, type StreamText } from "@iterate-com/shared/chunked-text";
import {
  initialAgentUiState,
  reduceAgentUi,
  settleAgentUiAtIdleBoundary,
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
  return { ...event, payload, streamPath };
}

/** apps/os's script events as the shared reducer reads them. A `context/run-requested` the agent
 *  appended while processing an assistant item (`source.processor.whileProcessing`, the engine's
 *  stamp) is the shared reducer's `script-run-requested` with the id it keys on,
 *  `agent-output:<that offset>`, and one any other caller asked for (`itx.run` on the agent's path)
 *  is `run:<its offset>`; its `context/run-settled` names the request by offset, so the settlement
 *  takes the same id. `expiresAt` is the run's deadline — apps/os's runner settles a script
 *  still running ten minutes after it started as failed (`deadline`, apps/os/src/library.ts
 *  RUN_DEADLINE_MS) — which the reducer's inferred close needs; the request's offset rides along as
 *  `requestOffset`, what a settlement's developer item names (`actor`). */
export function adaptContextRuns(events: readonly Event[]): Event[] {
  const executionIdByRequestOffset = new Map<number, string>();
  return events.map((event) => {
    if (event.type === "events.iterate.com/context/run-requested") {
      const payload = isRecord(event.payload) ? event.payload : {};
      const askedWhile = event.source?.processor?.whileProcessing?.offset;
      const executionId =
        askedWhile === undefined
          ? `run:${String(event.offset)}`
          : `agent-output:${String(askedWhile)}`;
      executionIdByRequestOffset.set(event.offset, executionId);
      return {
        ...event,
        type: "events.iterate.com/capability-host/script-run-requested",
        payload: {
          code: typeof payload.code === "string" ? payload.code : "",
          executionId,
          expiresAt: Date.parse(event.createdAt) + 10 * 60_000,
          requestOffset: event.offset,
        },
      };
    }
    if (event.type === "events.iterate.com/context/run-settled") {
      const payload = isRecord(event.payload) ? event.payload : {};
      const requestOffset = typeof payload.requestOffset === "number" ? payload.requestOffset : NaN;
      const settlement = isRecord(payload.settlement) ? payload.settlement : {};
      return {
        ...event,
        type: "events.iterate.com/capability-host/script-run-settled",
        payload: {
          executionId:
            executionIdByRequestOffset.get(requestOffset) ?? `run:${String(requestOffset)}`,
          requestOffset,
          settlement:
            settlement.status === "failed"
              ? {
                  // `interrupted` (the context restarted mid-run) or `deadline`: the script may have run.
                  phase: "execution",
                  executionMayHaveOccurred: true,
                  cancellation: "not-applicable",
                  ...settlement,
                }
              : settlement,
        },
      };
    }
    return event;
  });
}

/** The whole feed from the log: every event in offset order through the shared reducer, then —
 *  when the agent facet reports itself idle and no step is still running — the turn boundary,
 *  dated at the last fact. */
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
  const last = events.at(-1);
  if (idle && last && state.live && !state.live.steps.some((step) => step.status === "running")) {
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
export function traceOffsetByMessage(events: readonly Event[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const event of events) {
    if (event.type !== "events.iterate.com/agent/web-message-sent") continue;
    const p = isRecord(event.payload) ? event.payload : {};
    if (typeof p.llmRequestOffset === "number")
      map.set(`assistant-${String(event.offset)}`, p.llmRequestOffset);
  }
  return map;
}

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
  // The script a response produced: its codemode action, keyed off the assistant event's offset.
  const actionId = assistant ? `agent-output:${String(assistant.offset)}` : undefined;
  const scriptExecutionId =
    actionId &&
    events.some((event) => {
      if (event.type !== "events.iterate.com/capability-host/script-run-requested") return false;
      const p = isRecord(event.payload) ? event.payload : {};
      return p.executionId === actionId;
    })
      ? actionId
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

type ScriptTrace = {
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
  // The developer item names the run by its request offset (apps/os's actor), the adapted request
  // carries that offset beside its executionId.
  const rendered = events.find((event) => {
    if (event.type !== "events.iterate.com/agent/context-added") return false;
    const p = isRecord(event.payload) ? event.payload : {};
    const actor = isRecord(p.actor) ? p.actor : {};
    return actor.type === "script" && actor.requestOffset === payload.requestOffset;
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
