import { AgentLlmRequestCancelReason, type AgentRuntime } from "@iterate-com/shared/agent-events";
import { ScriptExecutionSettlement } from "@iterate-com/shared/script-execution";
import { z } from "zod";
import type { Event } from "./types.ts";

// ---------------------------------------------------------------------------
// Reduced state model + pure batch planner
//
// The agent UI is a clean chat: user message → activity ("Ran code 2× · 3
// requests · 7.4 s") → assistant message, with quiet stream wake dividers.
// SETTLED items are emitted in order; the browser-feed projector
// (apps/os .../processors/browser-feed) interleaves them with raw feed rows
// and allocates each one a `feed_items.local_index`. The reduced state holds
// only what is still in flight — the live activity with partially streamed
// thinking/response text and the presence roster. The live part renders as
// one element below the list, straight from this state, and exists only
// while work is active.
//
// `reduce` advances state one event at a time; `processEventBatch` plans the
// whole batch from the same entry state to produce one idempotent SQLite
// transaction.
// ---------------------------------------------------------------------------

export type AgentUiLlmStep = {
  kind: "llm";
  id: string;
  /** Offset of the llm-request-requested event this step tracks. */
  llmRequestOffset: number;
  status: "running" | "done";
  model?: string;
  /** Streamed reasoning summary ("thinking") text. */
  thinkingText: string;
  /** Streamed response text — for code-mode agents this is source code. */
  responseText: string;
  /** Offset of the committed assistant context-added event carrying this
   * step's final text; links interpretation events back to the step. */
  assistantEventOffset?: number;
  /** True once ANOTHER event derived from this response committed (an
   * extracted chat message pointing at the request, or a script extracted
   * from the assistant event). The derived views are then the story: pretty
   * rendering collapses the raw response text behind the raw toggles. */
  interpreted?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  outcome?: "completed" | "failed" | "cancelled";
  /** Why a cancelled request stopped, when the UI recognizes the reason. */
  cancelReason?: AgentLlmRequestCancelReason;
  errorMessage?: string;
  startedAtMs: number;
};

export type AgentUiCodeStep = {
  kind: "code";
  id: string;
  executionId: string;
  status: "running" | "done";
  code: string;
  result?: unknown;
  errorMessage?: string;
  durationMs?: number;
  success?: boolean;
  /** Whether the outcome came from the durable settlement or a UI boundary inference. */
  outcomeSource?: "durable" | "inferred";
  startedAtMs: number;
  /** Absolute server-side execution deadline from the strict request contract. */
  expiresAtMs: number;
  /**
   * The agent's summary `activity` line as of this step (the latest
   * agent/summary-updated fold when the step settled — scripts usually append
   * it mid-run). Round headers show this instead of a bare start time.
   */
  activitySummary?: string;
};

export type AgentUiStep = AgentUiLlmStep | AgentUiCodeStep;

export type AgentUiActivity = {
  kind: "activity";
  id: string;
  status: "running" | "done";
  steps: AgentUiStep[];
  startedAtMs: number;
  endedAtMs?: number;
};

export type AgentUiActivitySummary = {
  codeCount: number;
  requestCount: number;
  outcome: "clean" | "interrupted" | "failed";
  interruptedWithPartialResponse: boolean;
};

/** One canonical interpretation of activity attempts for every UI surface. */
export function summarizeAgentUiActivity(
  activity: AgentUiActivity,
  steps: readonly AgentUiStep[] = activity.steps,
): AgentUiActivitySummary {
  let codeCount = 0;
  let requestCount = 0;
  let failed = false;
  let interrupted = false;
  let interruptedWithPartialResponse = false;

  for (const step of steps) {
    if (step.kind === "code") {
      codeCount += 1;
      failed ||= step.success === false;
      continue;
    }

    requestCount += 1;
    const cancelled = step.outcome === "cancelled";
    if (cancelled && step.cancelReason === "interrupted-by-user-input") {
      interrupted = true;
      interruptedWithPartialResponse ||= step.thinkingText !== "" || step.responseText !== "";
    } else if (step.outcome === "failed" || cancelled) {
      // Any cancellation other than the user's own interrupt (expired, or a
      // reason this UI doesn't recognize) means the turn produced nothing.
      failed = true;
    }
  }

  const outcome: AgentUiActivitySummary["outcome"] = failed
    ? "failed"
    : interrupted
      ? "interrupted"
      : "clean";
  return {
    codeCount,
    requestCount,
    outcome,
    interruptedWithPartialResponse,
  };
}

/** Shared collapsed copy, parameterized only by a surface-specific interaction hint. */
export function formatAgentUiActivitySummary(
  activity: AgentUiActivity,
  options: {
    summary?: AgentUiActivitySummary;
    interruptedPartialHint?: string;
  } = {},
): string {
  const summary = options.summary ?? summarizeAgentUiActivity(activity);
  const parts: string[] = [];
  if (summary.codeCount > 0) parts.push(`Ran code ${summary.codeCount}×`);
  parts.push(`${summary.requestCount} request${summary.requestCount === 1 ? "" : "s"}`);
  if (summary.outcome === "interrupted") {
    parts.push(
      summary.interruptedWithPartialResponse && options.interruptedPartialHint
        ? `interrupted (${options.interruptedPartialHint})`
        : "interrupted",
    );
  }
  if (summary.outcome === "failed") parts.push("failed");
  const totalMs = !Number.isFinite(activity.endedAtMs)
    ? null
    : Math.max(0, activity.endedAtMs - activity.startedAtMs);
  if (Number.isFinite(totalMs) && totalMs > 0) parts.push(formatAgentUiDuration(totalMs));
  return parts.join(" · ");
}

/** One activity round: the llm step that writes a script and the code step that runs it. */
export type AgentUiActivityRound = {
  llm: AgentUiLlmStep | null;
  code: AgentUiCodeStep | null;
};

/**
 * Group an activity's steps into ROUNDS: the llm step that writes a script
 * and the code step that runs it belong together, and an agent that returns
 * itself a value for the next attempt produces round 2, 3, … A round opens at
 * every llm step (or at a code step with no llm before it — replays can drop
 * the llm half). Both round renderers — mobile's activity card
 * (apps/mobile/src/components/activity-card.tsx) and the os web feed
 * (apps/os/src/components/agent-feed.tsx) — group through this one function.
 */
export function groupActivityRounds(steps: readonly AgentUiStep[]) {
  const rounds: AgentUiActivityRound[] = [];
  for (const step of steps) {
    const current = rounds.at(-1);
    if (step.kind === "llm") {
      rounds.push({ llm: step, code: null });
    } else if (current && !current.code) {
      current.code = step;
    } else {
      rounds.push({ llm: null, code: step });
    }
  }
  return rounds;
}

export function formatAgentUiDuration(durationMs: number): string {
  if (durationMs < 1000) return `${Math.round(durationMs)} ms`;
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1).replace(/\.0$/, "")} s`;
  const seconds = Math.round(durationMs / 1000);
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function isAgentRuntimeVisiblyActive(runtime: AgentRuntime | undefined): boolean {
  return (
    !!runtime &&
    (runtime.triggers.runnable > 0 ||
      runtime.llmRequests.scheduled > 0 ||
      runtime.llmRequests.requested > 0 ||
      runtime.llmRequests.started > 0 ||
      runtime.runningScripts > 0)
  );
}

export function isAgentUiActivityWorking(
  activity: AgentUiActivity | null,
  runtime?: AgentRuntime,
): boolean {
  return (
    !!activity &&
    (isAgentRuntimeVisiblyActive(runtime) ||
      activity.steps.some((step) => step.status === "running"))
  );
}

/** A file attachment shown alongside a user message in the agent UI. */
export type AgentUiFileAttachment = {
  contentType: string;
  filename: string;
  path: string;
  size: number;
  url: string;
};

/** Marks a message that arrived through an external chat integration, or from another agent. */
export type AgentUiMessageVia = {
  service: "slack" | "telegram" | "agent" | "email" | "github";
  /** Best-effort sender label: slack user id, telegram username, email address,
   * github login, or agent path. */
  sender?: string;
};

export type AgentUiMessageItem = {
  kind: "user" | "assistant";
  id: string;
  text: string;
  timestampMs: number;
  files?: AgentUiFileAttachment[];
  via?: AgentUiMessageVia;
};

export type AgentUiStreamWakeItem = {
  kind: "stream-woken";
  id: string;
  text: string;
  timestampMs: number;
  /** Adjacent wake markers represented by this final wake. */
  count?: number;
};

export type AgentUiChildStreamItem = {
  kind: "child-stream-created";
  id: string;
  childPath: string;
  timestampMs: number;
};

export type AgentUiStreamPauseItem = {
  kind: "stream-paused" | "stream-resumed";
  id: string;
  text: string;
  reason?: string;
  timestampMs: number;
};

/** The platform revived a processor whose incarnation died owing background
 * work. Recovery is adoption — the open request survives and settles normally
 * — so this renders as a subtle marker, never as a cancelled/failed step. */
export type AgentUiProcessorRevivedItem = {
  kind: "processor-revived";
  id: string;
  processorSlug?: string;
  /** Lifetime revival count for this processor, when the payload carries it. */
  revivals?: number;
  timestampMs: number;
};

export type AgentUiItem =
  | AgentUiMessageItem
  | AgentUiActivity
  | AgentUiStreamWakeItem
  | AgentUiChildStreamItem
  | AgentUiStreamPauseItem
  | AgentUiProcessorRevivedItem;

export type AgentUiProcessorAnnouncement = {
  slug: string;
  version: string;
  description: string;
  consumes: string[];
  emits: string[];
  ownedEvents: Array<{ type: string; description?: string }>;
};

export type AgentUiPresenceEntry = {
  connectionKey: string;
  connectionKind: "hosted" | "session";
  connected: boolean;
  description?: string;
  user?: { id?: string; email: string; name?: string; picture?: string };
  processor?: AgentUiProcessorAnnouncement;
};

/**
 * Token accounting folded from agent/token-usage-reported (the agent
 * processor's normalized per-request reports): lifetime totals plus the most
 * recent report, whose input+output against maxContextTokens is the context
 * fullness the next turn starts from. A compaction context clears the last
 * report — the conversation it measured is gone.
 */
export type AgentUiTokenUsage = {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedInputTokens: number;
  totalReasoningOutputTokens: number;
  lastReport: {
    model: string;
    maxContextTokens: number;
    inputTokens: number;
    outputTokens: number;
  } | null;
};

export function initialAgentUiTokenUsage(): AgentUiTokenUsage {
  return {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCachedInputTokens: 0,
    totalReasoningOutputTokens: 0,
    lastReport: null,
  };
}

export type AgentUiState = {
  /** The running activity (streaming thinking/code), or null when no work is active. */
  live: AgentUiActivity | null;
  /** Assistant bubbles held until the grouped activity closes. */
  deferredAssistantMessages: AgentUiMessageItem[];
  /** User messages that landed while the current request was already running. */
  queuedUserMessages: AgentUiMessageItem[];
  eventCount: number;
  /** Connection roster reduced from connection-opened/connection-closed facts. */
  presence: AgentUiPresenceEntry[];
  /** Lifetime token totals + the latest report (context fullness). */
  tokenUsage: AgentUiTokenUsage;
  /**
   * Settled activities whose script outcome was inferred at a boundary rather
   * than supplied by a durable completion. A late completion replaces the
   * same feed item instead of leaving the inferred failure as permanent truth.
   */
  provisionalActivities: Record<string, AgentUiActivity>;
  /** Latest agent/summary-updated `activity` text — stamped onto code steps. */
  summaryActivity: string | null;
};

const AgentUiLlmStepSchema = z
  .strictObject({
    kind: z.literal("llm"),
    id: z.string(),
    llmRequestOffset: z.number().int().nonnegative(),
    status: z.enum(["running", "done"]),
    model: z.string().optional(),
    thinkingText: z.string(),
    responseText: z.string(),
    assistantEventOffset: z.number().int().positive().optional(),
    interpreted: z.boolean().optional(),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    durationMs: z.number().finite().nonnegative().optional(),
    outcome: z.enum(["completed", "failed", "cancelled"]).optional(),
    cancelReason: AgentLlmRequestCancelReason.optional(),
    errorMessage: z.string().optional(),
    startedAtMs: z.number().finite(),
  })
  .refine((step) => !step.cancelReason || step.outcome === "cancelled", {
    message: "cancelReason requires a cancelled outcome",
    path: ["cancelReason"],
  }) satisfies z.ZodType<AgentUiLlmStep>;

const AgentUiCodeStepSchema = z.strictObject({
  kind: z.literal("code"),
  id: z.string(),
  executionId: z.string(),
  status: z.enum(["running", "done"]),
  code: z.string(),
  result: z.unknown().optional(),
  errorMessage: z.string().optional(),
  durationMs: z.number().finite().nonnegative().optional(),
  success: z.boolean().optional(),
  outcomeSource: z.enum(["durable", "inferred"]).optional(),
  startedAtMs: z.number().finite(),
  expiresAtMs: z.number().finite(),
  activitySummary: z.string().optional(),
}) satisfies z.ZodType<AgentUiCodeStep>;

export const AgentUiActivitySchema = z.strictObject({
  kind: z.literal("activity"),
  id: z.string(),
  status: z.enum(["running", "done"]),
  steps: z.array(z.discriminatedUnion("kind", [AgentUiLlmStepSchema, AgentUiCodeStepSchema])),
  startedAtMs: z.number().finite(),
  endedAtMs: z.number().finite().optional(),
}) satisfies z.ZodType<AgentUiActivity>;

const AgentUiFileAttachmentSchema = z.strictObject({
  contentType: z.string(),
  filename: z.string(),
  path: z.string(),
  size: z.number().finite().nonnegative(),
  url: z.string(),
}) satisfies z.ZodType<AgentUiFileAttachment>;

const AgentUiMessageViaSchema = z.strictObject({
  service: z.enum(["slack", "telegram", "agent", "email", "github"]),
  sender: z.string().optional(),
}) satisfies z.ZodType<AgentUiMessageVia>;

const AgentUiMessageItemSchema = z.strictObject({
  kind: z.enum(["user", "assistant"]),
  id: z.string(),
  text: z.string(),
  timestampMs: z.number().finite(),
  files: z.array(AgentUiFileAttachmentSchema).optional(),
  via: AgentUiMessageViaSchema.optional(),
}) satisfies z.ZodType<AgentUiMessageItem>;

const AgentUiProcessorAnnouncementSchema = z.strictObject({
  slug: z.string(),
  version: z.string(),
  description: z.string(),
  consumes: z.array(z.string()),
  emits: z.array(z.string()),
  ownedEvents: z.array(z.strictObject({ type: z.string(), description: z.string().optional() })),
}) satisfies z.ZodType<AgentUiProcessorAnnouncement>;

const AgentUiPresenceEntrySchema = z.strictObject({
  connectionKey: z.string(),
  connectionKind: z.enum(["hosted", "session"]),
  connected: z.boolean(),
  description: z.string().optional(),
  user: z
    .strictObject({
      id: z.string().optional(),
      email: z.string(),
      name: z.string().optional(),
      picture: z.string().optional(),
    })
    .optional(),
  processor: AgentUiProcessorAnnouncementSchema.optional(),
}) satisfies z.ZodType<AgentUiPresenceEntry>;

const AgentUiTokenUsageSchema = z.strictObject({
  totalInputTokens: z.number().int().nonnegative(),
  totalOutputTokens: z.number().int().nonnegative(),
  totalCachedInputTokens: z.number().int().nonnegative(),
  totalReasoningOutputTokens: z.number().int().nonnegative(),
  lastReport: z
    .strictObject({
      model: z.string(),
      maxContextTokens: z.number().int().nonnegative(),
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
    })
    .nullable(),
}) satisfies z.ZodType<AgentUiTokenUsage>;

export const AgentUiStateSchema = z
  .strictObject({
    live: AgentUiActivitySchema.nullable(),
    deferredAssistantMessages: z.array(AgentUiMessageItemSchema),
    queuedUserMessages: z.array(AgentUiMessageItemSchema),
    eventCount: z.number().int().nonnegative(),
    presence: z.array(AgentUiPresenceEntrySchema),
    tokenUsage: AgentUiTokenUsageSchema,
    provisionalActivities: z.record(z.string(), AgentUiActivitySchema),
    summaryActivity: z.string().nullable(),
  })
  .superRefine((state, context) => {
    for (const [id, activity] of Object.entries(state.provisionalActivities)) {
      if (id !== activity.id) {
        context.addIssue({
          code: "custom",
          message: `provisional activity key ${JSON.stringify(id)} does not match its id`,
          path: ["provisionalActivities", id, "id"],
        });
      }
    }
  }) satisfies z.ZodType<AgentUiState>;

export function isAgentActivity(value: unknown): value is AgentUiActivity {
  return AgentUiActivitySchema.safeParse(value).success;
}

export function isCurrentAgentUiState(value: unknown): value is AgentUiState {
  return AgentUiStateSchema.safeParse(value).success;
}

/**
 * A durable completion normally follows its idle boundary immediately. Keep a
 * small correction window, but never let malformed streams with permanently
 * missing completions grow the browser's persisted reducer state without
 * bound.
 */
export const AGENT_UI_PROVISIONAL_ACTIVITY_LIMIT = 32;

export function initialAgentUiState(): AgentUiState {
  return {
    live: null,
    deferredAssistantMessages: [],
    queuedUserMessages: [],
    eventCount: 0,
    presence: [],
    tokenUsage: initialAgentUiTokenUsage(),
    provisionalActivities: {},
    summaryActivity: null,
  };
}

/**
 * Fold ONE event into settled items + the resulting state. Items are appended
 * to `items` in emission order; the caller (the browser-feed projector) owns
 * list positions. Idempotent by construction: replaying the same event from
 * the same entry state yields the same items.
 */
export function reduceAgentUi(
  start: AgentUiState,
  event: Event,
): { endState: AgentUiState; items: AgentUiItem[] } {
  const items: AgentUiItem[] = [];
  const endState = reduceAgentUiEvent(start, event, items);
  return { endState, items };
}

/**
 * Exact runtime state exposed by the individual Agent processor. This is a
 * live presentation boundary, deliberately not an event in the agent journal.
 */
export type AgentUiRuntimeTransition = {
  runtime: AgentRuntime;
  sinceOffset: number;
  since: string;
};

/**
 * Project the journal-reduced UI state through the Agent processor's current
 * runtime. Callers render the returned items as a transient tail; the browser
 * feed database remains a reduction of journal facts only.
 */
export function reduceAgentUiRuntime(
  start: AgentUiState,
  transition: AgentUiRuntimeTransition,
): { endState: AgentUiState; items: AgentUiItem[] } {
  const boundaryAtMs = Date.parse(transition.since);
  if (!Number.isFinite(boundaryAtMs)) {
    return { endState: start, items: [] };
  }

  if (isAgentRuntimeVisiblyActive(transition.runtime)) {
    return {
      endState: {
        ...start,
        live: ensureLive(start, transition.sinceOffset, boundaryAtMs),
      },
      items: [],
    };
  }

  const items: AgentUiItem[] = [];
  const expired = expireOverdueCodeSteps(start, boundaryAtMs);
  const endState = flushDeferredMessages(settleLive(expired, boundaryAtMs, items), items);
  return { endState, items };
}

/** Append a settled item in emission order. */
function emitItem(state: AgentUiState, items: AgentUiItem[], item: AgentUiItem): AgentUiState {
  items.push(item);
  return state;
}

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

const AGENT_LLM_REQUEST_REQUESTED = "events.iterate.com/agent/llm-request-requested";
const AGENT_LLM_REQUEST_SETTLED = "events.iterate.com/agent/llm-request-settled";
const AGENT_CONTEXT_ADDED = "events.iterate.com/agents/context-added";
const AGENT_TOKEN_USAGE_REPORTED = "events.iterate.com/agent/token-usage-reported";
const AGENT_LLM_RESPONSE_CHUNK = "events.iterate.com/agent/llm-response-chunk";
const SCRIPT_EXECUTION_REQUESTED = "events.iterate.com/capability-host/script-run-requested";
const SCRIPT_EXECUTION_COMPLETED = "events.iterate.com/capability-host/script-run-settled";
const SLACK_WEBHOOK_RECEIVED = "events.iterate.com/slack/webhook-received";
const TELEGRAM_WEBHOOK_RECEIVED = "events.iterate.com/telegram/webhook-received";
const TELEGRAM_SEND_REQUESTED = "events.iterate.com/telegram/send-requested";
const STREAM_CONNECTION_OPENED = "events.iterate.com/stream/connection-opened";
const STREAM_CONNECTION_CLOSED = "events.iterate.com/stream/connection-closed";
const STREAM_WOKEN = "events.iterate.com/stream/woken";
const STREAM_PROCESSOR_REVIVED = "events.iterate.com/stream/processor-revived";
const STREAM_CHILD_STREAM_CREATED = "events.iterate.com/stream/child-stream-created";
const STREAM_PAUSED = "events.iterate.com/stream/paused";
const STREAM_RESUMED = "events.iterate.com/stream/resumed";
const AGENT_PAUSED = "events.iterate.com/agent/paused";
const AGENT_RESUMED = "events.iterate.com/agent/resumed";
const AGENT_SUMMARY_UPDATED = "events.iterate.com/agent/summary-updated";
const STREAM_WAKE_LABEL = "Stream durable object woke";

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

function reduceAgentUiEvent(
  previous: AgentUiState,
  event: Event,
  items: AgentUiItem[],
): AgentUiState {
  const state: AgentUiState = {
    ...previous,
    eventCount: previous.eventCount + 1,
  };
  const timestampMs = Date.parse(event.createdAt);
  // Committed events are expected to carry an ISO timestamp. A malformed
  // timestamp must not manufacture NaN durations or accidentally trip a
  // script deadline comparison; keep the raw event visible, but do not fold
  // it into the typed agent projection.
  if (!Number.isFinite(timestampMs)) return state;

  switch (event.type) {
    // The canonical model-visible context event. User context renders as a
    // bubble; assistant context replaces the streamed LLM text; developer
    // context from another human-facing integration renders with its source.
    // Script-produced developer context is model input, not another bubble.
    case AGENT_CONTEXT_ADDED: {
      const role = readString(event, "role");
      const text = readString(event, "content");
      if (!text) return state;
      let contextState = state;
      const compaction = readRecord(event, "compaction");
      if (
        typeof compaction?.replacesHistoryThrough === "number" &&
        compaction.replacesHistoryThrough < event.offset &&
        state.tokenUsage.lastReport
      ) {
        contextState = {
          ...state,
          tokenUsage: { ...state.tokenUsage, lastReport: null },
        };
      }

      if (role === "assistant") {
        const llmRequestOffset = readLlmRequestOffset(event);
        if (!Number.isFinite(llmRequestOffset)) return contextState;
        return updateLlmStep(contextState, llmRequestOffset, (step) =>
          step.status === "running"
            ? { ...step, responseText: text, assistantEventOffset: event.offset }
            : step,
        );
      }
      if (role === "system") return contextState;

      const actor = readRecord(event, "actor");
      const actorType = typeof actor?.type === "string" ? actor.type : undefined;
      const files = readFileAttachments(event);
      if (role === "user") {
        return emitUserMessageItem(contextState, items, {
          kind: "user",
          id: `user-${event.offset}`,
          text,
          ...(files.length === 0 ? {} : { files }),
          timestampMs,
        });
      }
      if (
        actorType === "agent" ||
        actorType === "slack" ||
        actorType === "telegram" ||
        actorType === "email" ||
        actorType === "github"
      ) {
        const rendersFromRawEvent = actorType === "slack" || actorType === "telegram";
        if (rendersFromRawEvent && !files.length) return contextState;
        const senderValue =
          actorType === "agent"
            ? actor?.path
            : actorType === "slack"
              ? actor?.userId
              : actorType === "telegram"
                ? (actor?.username ?? actor?.userId)
                : actorType === "email"
                  ? actor?.address
                  : actor?.login;
        const sender = typeof senderValue === "string" ? senderValue : undefined;
        return emitUserMessageItem(contextState, items, {
          kind: "user",
          id: `user-${event.offset}`,
          text: rendersFromRawEvent ? "" : text,
          ...(files.length === 0 ? {} : { files }),
          timestampMs,
          via: { service: actorType, ...(!sender ? {} : { sender }) },
        });
      }
      return contextState;
    }

    case "events.iterate.com/agents/web-message-sent": {
      const text = readString(event, "message");
      if (!text) return state;
      // An llmRequestOffset marks the message as EXTRACTED from that request's
      // response (a userland response interpreter) — the raw response text is
      // now redundant in pretty rendering.
      const extractedFromRequest = readLlmRequestOffset(event);
      const marked = !Number.isFinite(extractedFromRequest)
        ? state
        : updateLlmStep(state, extractedFromRequest, (step) => ({ ...step, interpreted: true }));
      const files = readFileAttachments(event);
      const item: AgentUiMessageItem = {
        kind: "assistant",
        id: `assistant-${event.offset}`,
        text,
        ...(files.length === 0 ? {} : { files }),
        timestampMs,
      };
      return emitAssistantMessageItem(marked, items, item);
    }

    case AGENT_LLM_REQUEST_REQUESTED: {
      const base =
        state.queuedUserMessages.length === 0 ? state : settleLive(state, timestampMs, items);
      const ready =
        !base.live && (base.deferredAssistantMessages.length || base.queuedUserMessages.length)
          ? flushDeferredMessages(base, items)
          : base;
      const live = ensureLive(ready, event.offset, timestampMs);
      const model = readString(event, "model");
      const step: AgentUiLlmStep = {
        kind: "llm",
        id: `llm-${event.offset}`,
        llmRequestOffset: event.offset,
        status: "running",
        ...(!model ? {} : { model }),
        thinkingText: "",
        responseText: "",
        startedAtMs: timestampMs,
      };
      return { ...ready, live: { ...live, steps: [...live.steps, step] } };
    }

    case AGENT_LLM_RESPONSE_CHUNK: {
      const llmRequestOffset = readLlmRequestOffset(event);
      const chunk = readPayloadRecord(event)?.chunk;
      if (!Number.isFinite(llmRequestOffset)) return state;
      const { responseDelta, thinkingDelta } = extractCloudflareChunkDeltas(chunk);
      if (responseDelta === "" && thinkingDelta === "") return state;
      return updateLlmStep(state, llmRequestOffset, (step) => ({
        ...step,
        responseText:
          step.status === "running" ? step.responseText + responseDelta : step.responseText,
        thinkingText:
          step.status === "running" ? step.thinkingText + thinkingDelta : step.thinkingText,
      }));
    }

    case AGENT_LLM_REQUEST_SETTLED: {
      // The ONE terminal fact for a request (succeeded | failed | cancelled),
      // pointing back at the requested event's offset via `requestOffset`.
      const payload = readPayloadRecord(event);
      const requestOffset = payload?.requestOffset;
      if (!payload || typeof requestOffset !== "number") return state;
      const result = isRecord(payload.result) ? payload.result : undefined;
      const status = typeof result?.status === "string" ? result.status : "succeeded";
      const usage = readUsageTokens(result?.usage);
      const errorMessage =
        typeof result?.errorMessage === "string" ? result.errorMessage : undefined;
      const parsedCancelReason = AgentLlmRequestCancelReason.safeParse(result?.reason);
      const cancelReason = parsedCancelReason.success ? parsedCancelReason.data : null;
      // The durable record of what streamed before an interrupt. Chunks are
      // ephemeral, so a rebuild from the journal (refresh, TUI/mobile) has an
      // empty responseText — the settled fact fills it in.
      const partialText = typeof result?.partialText === "string" ? result.partialText : null;
      return updateLlmStep(state, requestOffset, (step) =>
        step.outcome
          ? step
          : {
              ...step,
              status: "done",
              outcome:
                status === "succeeded" ? "completed" : status === "failed" ? "failed" : "cancelled",
              ...(!!partialText && step.responseText === "" && { responseText: partialText }),
              ...(typeof payload.durationMs === "number"
                ? { durationMs: payload.durationMs }
                : status === "cancelled"
                  ? { durationMs: Math.max(0, timestampMs - step.startedAtMs) }
                  : {}),
              ...(!Number.isFinite(usage.input) ? {} : { inputTokens: usage.input }),
              ...(!Number.isFinite(usage.output) ? {} : { outputTokens: usage.output }),
              ...(!errorMessage ? {} : { errorMessage }),
              ...(!cancelReason ? {} : { cancelReason }),
            },
      );
    }

    case SCRIPT_EXECUTION_REQUESTED: {
      const payload = readPayloadRecord(event);
      const executionId = typeof payload?.executionId === "string" ? payload.executionId : null;
      const code = typeof payload?.code === "string" ? payload.code : null;
      const expiresAtMs = payload?.expiresAt;
      if (
        !executionId ||
        !code ||
        typeof expiresAtMs !== "number" ||
        !Number.isSafeInteger(expiresAtMs) ||
        expiresAtMs <= 0
      ) {
        return state;
      }
      // A script extracted from an assistant response (`agent-output:<offset>`)
      // marks that response's llm step interpreted: the Script tab now carries
      // the code, so pretty rendering can fold the raw response away.
      const extractedFromAssistantOffset = /^agent-output:(\d+)$/.exec(executionId);
      const interpretedState = !extractedFromAssistantOffset
        ? state
        : markLlmStepInterpretedByAssistantOffset(state, Number(extractedFromAssistantOffset[1]));
      const live = ensureLive(interpretedState, event.offset, timestampMs);
      const step: AgentUiCodeStep = {
        kind: "code",
        id: `code-${executionId}`,
        executionId,
        status: "running",
        code,
        startedAtMs: timestampMs,
        expiresAtMs,
        // Inherit the stream's summary status from birth, so live headers and
        // inferred (deadline/idle) closes carry it — not only durable settles.
        ...(!state.summaryActivity ? {} : { activitySummary: state.summaryActivity }),
      };
      return { ...interpretedState, live: { ...live, steps: [...live.steps, step] } };
    }

    case SCRIPT_EXECUTION_COMPLETED: {
      const payload = readPayloadRecord(event);
      if (!payload) return state;
      const executionId = typeof payload.executionId === "string" ? payload.executionId : null;
      // Completion identity is mandatory in the current contract. Guessing
      // the last running step can stamp one script's result onto another.
      if (!executionId) return state;
      const outcome = readCodeOutcome(payload);
      if (!state.live) {
        return correctProvisionalCodeStep(state, executionId, outcome, timestampMs, items);
      }
      const steps = [...state.live.steps];
      const index = steps.findIndex(
        (step) => step.kind === "code" && step.executionId === executionId,
      );
      const step = steps[index];
      if (!step || step.kind !== "code") {
        return correctProvisionalCodeStep(state, executionId, outcome, timestampMs, items);
      }
      steps[index] = {
        ...applyDurableCodeOutcome(step, outcome, timestampMs),
        // The stream's summary status as of this round — inherited from an
        // earlier round when this one's script didn't update it.
        ...(!state.summaryActivity ? {} : { activitySummary: state.summaryActivity }),
      };
      const next = { ...state, live: { ...state.live, steps } };
      // A visible reply the script sent was deferred while its step ran (see
      // emitAssistantMessageItem). If this settle is the turn's last journal
      // fact — nothing running, no follow-up round — no later event exists to
      // flush it, and the runtime-transition flush is a transient overlay on
      // a lane that can lag or wedge independently. Journal facts alone must
      // surface a sent message: settle the activity here and flush.
      if (
        (next.deferredAssistantMessages.length || next.queuedUserMessages.length) &&
        !steps.some((candidate) => candidate.status === "running")
      ) {
        return flushDeferredMessages(settleLive(next, timestampMs, items), items);
      }
      return next;
    }

    case AGENT_SUMMARY_UPDATED: {
      const activity = readString(event, "activity");
      if (!activity || activity === "") return state;
      // Summaries are usually appended by the running script itself, so the
      // running code step picks the new text up immediately (live rounds show
      // it before the settle stamp lands).
      if (state.live) {
        const steps = state.live.steps.map((step) =>
          step.kind === "code" && step.status === "running"
            ? { ...step, activitySummary: activity }
            : step,
        );
        return { ...state, summaryActivity: activity, live: { ...state.live, steps } };
      }
      return { ...state, summaryActivity: activity };
    }

    case AGENT_TOKEN_USAGE_REPORTED: {
      const model = readString(event, "model");
      const maxContextTokens = readNumber(event, "maxContextTokens");
      const inputTokens = readNumber(event, "inputTokens");
      const outputTokens = readNumber(event, "outputTokens");
      if (
        !model ||
        !Number.isFinite(maxContextTokens) ||
        !Number.isFinite(inputTokens) ||
        !Number.isFinite(outputTokens)
      )
        return state;
      const usage = state.tokenUsage;
      return {
        ...state,
        tokenUsage: {
          totalInputTokens: usage.totalInputTokens + inputTokens,
          totalOutputTokens: usage.totalOutputTokens + outputTokens,
          totalCachedInputTokens:
            usage.totalCachedInputTokens + (readNumber(event, "cachedInputTokens") ?? 0),
          totalReasoningOutputTokens:
            usage.totalReasoningOutputTokens + (readNumber(event, "reasoningOutputTokens") ?? 0),
          lastReport: { model, maxContextTokens, inputTokens, outputTokens },
        },
      };
    }

    case SLACK_WEBHOOK_RECEIVED: {
      const message = readSlackWebhookMessage(event);
      if (!message) return state;
      const item: AgentUiMessageItem = {
        kind: message.kind,
        id: `slack-${event.offset}`,
        text: message.text,
        timestampMs,
        via: {
          service: "slack",
          ...(!message.sender ? {} : { sender: message.sender }),
        },
      };
      // Our bot's echoes land mid-turn (it posts from inside a code step), so
      // they emit directly like web-message-sent; humans and third-party bots
      // queue while steps are running, like web user messages.
      return message.kind === "assistant"
        ? emitAssistantMessageItem(state, items, item)
        : emitUserMessageItem(state, items, item);
    }

    case TELEGRAM_WEBHOOK_RECEIVED: {
      // Always a user bubble: Telegram never delivers the bot's own messages
      // through the webhook (the outbound side renders from send-requested).
      const message = readTelegramWebhookMessage(event);
      if (!message) return state;
      return emitUserMessageItem(state, items, {
        kind: "user",
        id: `telegram-${event.offset}`,
        text: message.text,
        timestampMs,
        via: {
          service: "telegram",
          ...(!message.sender ? {} : { sender: message.sender }),
        },
      });
    }

    case TELEGRAM_SEND_REQUESTED: {
      // The journaled send IS the bot's outbound message (the telegram-agent
      // processor is obliged to deliver it and Telegram won't echo it back),
      // so it renders as the assistant bubble.
      const text = readString(event, "text");
      if (!text || text === "") return state;
      return emitAssistantMessageItem(state, items, {
        kind: "assistant",
        id: `telegram-send-${event.offset}`,
        text,
        timestampMs,
        via: { service: "telegram" },
      });
    }

    case STREAM_CONNECTION_OPENED: {
      const payload = readPayloadRecord(event);
      if (!payload) return state;
      const connectionKey =
        typeof payload.connectionKey === "string" ? payload.connectionKey : null;
      if (!connectionKey) return state;
      const connectionKind = payload.kind === "hosted" ? "hosted" : "session";
      const openedBy = isRecord(payload.openedBy) ? payload.openedBy : undefined;
      const announcement = readProcessorAnnouncement(openedBy?.processor);
      const openerUser = isRecord(openedBy?.user) ? openedBy.user : undefined;
      const user =
        typeof openerUser?.email === "string"
          ? {
              ...(typeof openerUser.id === "string" && { id: openerUser.id }),
              email: openerUser.email,
              ...(typeof openerUser.name === "string" && { name: openerUser.name }),
              ...(typeof openerUser.picture === "string" && { picture: openerUser.picture }),
            }
          : undefined;
      const entry: AgentUiPresenceEntry = {
        connectionKey,
        connectionKind,
        connected: true,
        ...(typeof openedBy?.description === "string" && { description: openedBy.description }),
        ...(!user ? {} : { user }),
        ...(!announcement ? {} : { processor: announcement }),
      };
      const existingIndex = state.presence.findIndex(
        (candidate) => candidate.connectionKey === connectionKey,
      );
      const presence =
        existingIndex === -1
          ? [...state.presence, entry]
          : state.presence.map((candidate, index) => (index === existingIndex ? entry : candidate));
      return { ...state, presence };
    }

    case STREAM_CONNECTION_CLOSED: {
      const connectionKey = readString(event, "connectionKey");
      if (!connectionKey) return state;
      return {
        ...state,
        presence: state.presence.map((entry) =>
          entry.connectionKey === connectionKey ? { ...entry, connected: false } : entry,
        ),
      };
    }

    case STREAM_WOKEN: {
      // Every connection died with the previous stream incarnation; survivors
      // re-dial and re-land as fresh connected facts.
      const next = {
        ...state,
        presence: state.presence.map((entry) =>
          entry.connected ? { ...entry, connected: false } : entry,
        ),
      };
      if (isInitialStreamWake(event)) return next;
      return emitItem(next, items, {
        kind: "stream-woken",
        id: `stream-woken-${event.offset}`,
        text: STREAM_WAKE_LABEL,
        timestampMs,
      });
    }

    case STREAM_PROCESSOR_REVIVED: {
      // A processor incarnation died owing background work and the platform
      // revived it. The open request was ADOPTED and settles normally, so
      // this is a subtle marker — never a cancelled or failed step.
      const payload = readPayloadRecord(event);
      const processorSlug =
        typeof payload?.processorSlug === "string" ? payload.processorSlug : undefined;
      const revivals = typeof payload?.revivals === "number" ? payload.revivals : undefined;
      return emitItem(state, items, {
        kind: "processor-revived",
        id: `processor-revived-${event.offset}`,
        ...(!processorSlug ? {} : { processorSlug }),
        ...(!Number.isFinite(revivals) ? {} : { revivals }),
        timestampMs,
      });
    }

    case STREAM_CHILD_STREAM_CREATED: {
      const childPath = readString(event, "childPath");
      if (!childPath) return state;
      return emitItem(state, items, {
        kind: "child-stream-created",
        id: `child-stream-created-${event.offset}`,
        childPath,
        timestampMs,
      });
    }

    // The stream-level facts (the whole stream stops accepting appends) and
    // the agent-level facts (the turn loop parks — the autonomous breaker, or
    // an operator) render as the same pause/resume marker rows.
    case STREAM_PAUSED:
    case AGENT_PAUSED:
      return emitItem(state, items, {
        kind: "stream-paused",
        id: `stream-paused-${event.offset}`,
        text: "Agent paused",
        ...readOptionalReason(event),
        timestampMs,
      });

    case STREAM_RESUMED:
    case AGENT_RESUMED:
      return emitItem(state, items, {
        kind: "stream-resumed",
        id: `stream-resumed-${event.offset}`,
        text: "Agent resumed",
        ...readOptionalReason(event),
        timestampMs,
      });

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Reducer helpers
// ---------------------------------------------------------------------------

function ensureLive(state: AgentUiState, offset: number, startedAtMs: number): AgentUiActivity {
  // Multiple simultaneous steps render as one live activity.
  if (state.live) return { ...state.live, status: "running" };
  return {
    kind: "activity",
    id: `activity-${offset}`,
    status: "running",
    steps: [],
    startedAtMs,
  };
}

function isInitialStreamWake(event: Event): boolean {
  // Brand-new streams commit stream/created at offset 1 and stream/woken at offset 2.
  return event.offset <= 2;
}

function settleLiveIfIdle(
  state: AgentUiState,
  endedAtMs: number,
  items: AgentUiItem[],
): AgentUiState {
  if (isAgentUiActivityWorking(state.live, undefined)) return state;
  return settleLive(state, endedAtMs, items);
}

const SCRIPT_DEADLINE_WITHOUT_COMPLETION_ERROR =
  "Script execution exceeded its deadline without a completion event. It may have partially executed and was NOT re-run.";
const LLM_IDLE_WITHOUT_COMPLETION_ERROR =
  "The agent became idle without a durable LLM completion or cancellation event.";
const SCRIPT_IDLE_WITHOUT_COMPLETION_ERROR =
  "The agent became idle without a durable script completion event. Its execution outcome is unknown; do not assume it is safe to re-run.";

/**
 * A requested code step whose server-side deadline passed without a durable
 * completion cannot remain live forever. At a visible run boundary, preserve
 * the uncertain side-effect outcome and close the UI step explicitly.
 */
function expireOverdueCodeSteps(state: AgentUiState, boundaryAtMs: number): AgentUiState {
  if (!state.live) return state;
  let changed = false;
  const steps = state.live.steps.map((step): AgentUiStep => {
    if (step.kind !== "code" || step.status !== "running" || boundaryAtMs < step.expiresAtMs) {
      return step;
    }
    changed = true;
    return {
      ...step,
      status: "done",
      success: false,
      outcomeSource: "inferred",
      durationMs: Math.max(0, step.expiresAtMs - step.startedAtMs),
      errorMessage: SCRIPT_DEADLINE_WITHOUT_COMPLETION_ERROR,
    };
  });
  if (!changed) return state;

  return {
    ...state,
    live: {
      ...state.live,
      steps,
    },
  };
}

function settleActivityAtBoundary(
  state: AgentUiState,
  boundaryAtMs: number,
  items: AgentUiItem[],
): AgentUiState {
  return settleLiveIfIdle(expireOverdueCodeSteps(state, boundaryAtMs), boundaryAtMs, items);
}

/** Closes the live activity (if any) and emits it as a settled item. */
function settleLive(state: AgentUiState, endedAtMs: number, items: AgentUiItem[]): AgentUiState {
  if (!state.live) return state;
  if (!state.live.steps.length) return { ...state, live: null };
  const settled: AgentUiActivity = {
    ...state.live,
    status: "done",
    endedAtMs,
    steps: state.live.steps.map((step): AgentUiStep => {
      if (step.status !== "running") return step;
      const durationMs = Math.max(0, endedAtMs - step.startedAtMs);
      return step.kind === "llm"
        ? {
            ...step,
            status: "done",
            outcome: "failed",
            durationMs,
            errorMessage: LLM_IDLE_WITHOUT_COMPLETION_ERROR,
          }
        : {
            ...step,
            status: "done",
            success: false,
            outcomeSource: "inferred",
            durationMs,
            errorMessage: SCRIPT_IDLE_WITHOUT_COMPLETION_ERROR,
          };
    }),
  };
  const provisionalActivities = { ...state.provisionalActivities };
  if (settled.steps.some((step) => step.kind === "code" && step.outcomeSource === "inferred")) {
    provisionalActivities[settled.id] = settled;
    while (Object.keys(provisionalActivities).length > AGENT_UI_PROVISIONAL_ACTIVITY_LIMIT) {
      const oldestId = Object.keys(provisionalActivities)[0];
      if (!oldestId) break;
      delete provisionalActivities[oldestId];
    }
  }
  return emitItem({ ...state, live: null, provisionalActivities }, items, settled);
}

function flushQueuedUserMessages(state: AgentUiState, items: AgentUiItem[]): AgentUiState {
  let next: AgentUiState = { ...state, queuedUserMessages: [] };
  for (const item of state.queuedUserMessages) {
    next = emitItem(next, items, item);
  }
  return next;
}

/**
 * Emit the current turn's assistant output before user messages queued for the
 * next turn. Keeping the two queues separate also prevents assistant bubbles
 * from appearing in the composer's "queued messages" affordance.
 */
function flushDeferredMessages(state: AgentUiState, items: AgentUiItem[]): AgentUiState {
  let next: AgentUiState = { ...state, deferredAssistantMessages: [] };
  for (const item of state.deferredAssistantMessages) {
    next = emitItem(next, items, item);
  }
  return flushQueuedUserMessages(next, items);
}

// A user message while steps are still running must not archive those steps
// as finished — the agent is still working. Queue it for the next flush;
// otherwise emit directly. Shared by plain user messages and file-attachment
// inputs.
function emitUserMessageItem(
  state: AgentUiState,
  items: AgentUiItem[],
  item: AgentUiMessageItem,
): AgentUiState {
  const settled = settleActivityAtBoundary(state, item.timestampMs, items);
  if (isAgentUiActivityWorking(settled.live, undefined)) {
    return { ...settled, queuedUserMessages: [...settled.queuedUserMessages, item] };
  }
  const flushed = !settled.live ? flushDeferredMessages(settled, items) : settled;
  return emitItem(flushed, items, item);
}

/**
 * Assistant output belongs after the activity that produced it. Transport
 * adapters all use this path so a Slack/Telegram echo cannot split a running
 * script group while web output remains deferred.
 */
function emitAssistantMessageItem(
  state: AgentUiState,
  items: AgentUiItem[],
  item: AgentUiMessageItem,
): AgentUiState {
  const settled = settleActivityAtBoundary(state, item.timestampMs, items);
  if (isAgentUiActivityWorking(settled.live, undefined)) {
    return {
      ...settled,
      deferredAssistantMessages: [...settled.deferredAssistantMessages, item],
    };
  }
  const flushed = !settled.live ? flushDeferredMessages(settled, items) : settled;
  return emitItem(flushed, items, item);
}

function correctProvisionalCodeStep(
  state: AgentUiState,
  executionId: string,
  outcome: Partial<AgentUiCodeStep>,
  completedAtMs: number,
  items: AgentUiItem[],
): AgentUiState {
  const activity = Object.values(state.provisionalActivities).find((candidate) =>
    candidate.steps.some(
      (step) =>
        step.kind === "code" &&
        step.executionId === executionId &&
        step.outcomeSource === "inferred",
    ),
  );
  if (!activity) return state;
  const steps = activity.steps.map((step): AgentUiStep => {
    if (step.kind !== "code" || step.executionId !== executionId) return step;
    return applyDurableCodeOutcome(step, outcome, completedAtMs);
  });
  const corrected: AgentUiActivity = { ...activity, steps };
  const provisionalActivities = { ...state.provisionalActivities };
  if (corrected.steps.some((step) => step.kind === "code" && step.outcomeSource === "inferred")) {
    provisionalActivities[corrected.id] = corrected;
  } else {
    delete provisionalActivities[corrected.id];
  }
  return emitItem({ ...state, provisionalActivities }, items, corrected);
}

function applyDurableCodeOutcome(
  step: AgentUiCodeStep,
  outcome: Partial<AgentUiCodeStep>,
  completedAtMs: number,
): AgentUiCodeStep {
  // A provisional boundary writes a failure. A later durable success must
  // replace that outcome, not produce the impossible combination
  // `success: true` plus the stale inferred error (or stale result fields in
  // the opposite direction).
  const base = { ...step };
  delete base.errorMessage;
  delete base.result;
  delete base.success;
  return {
    ...base,
    status: "done",
    durationMs: outcome.durationMs ?? Math.max(0, completedAtMs - step.startedAtMs),
    outcomeSource: "durable",
    ...outcome,
  };
}

/** Mark the llm step whose committed assistant event is `assistantEventOffset`
 * as interpreted (a script was extracted from it). */
function markLlmStepInterpretedByAssistantOffset(
  state: AgentUiState,
  assistantEventOffset: number,
): AgentUiState {
  if (!state.live) return state;
  const match = state.live.steps.find(
    (step) => step.kind === "llm" && step.assistantEventOffset === assistantEventOffset,
  );
  if (!match || match.kind !== "llm") return state;
  return updateLlmStep(state, match.llmRequestOffset, (step) => ({ ...step, interpreted: true }));
}

function updateLlmStep(
  state: AgentUiState,
  llmRequestOffset: number,
  update: (step: AgentUiLlmStep) => AgentUiLlmStep,
): AgentUiState {
  if (!state.live) return state;
  const index = state.live.steps.findIndex(
    (step) => step.kind === "llm" && step.llmRequestOffset === llmRequestOffset,
  );
  const step = state.live.steps[index];
  if (!step || step.kind !== "llm") return state;
  const steps = [...state.live.steps];
  steps[index] = update(step);
  return { ...state, live: { ...state.live, steps } };
}

/**
 * The response/thinking text deltas inside one streamed LLM chunk, across the
 * vendor dialects we receive (Workers AI, OpenAI chat completions, Anthropic).
 * Exported as the ONE place that knows chunk shapes: the live feed folds these
 * into the streaming tail, and the LLM trace panel re-assembles a request's
 * partial response from the same chunks.
 */
export function extractCloudflareChunkDeltas(chunk: unknown): {
  responseDelta: string;
  thinkingDelta: string;
} {
  if (typeof chunk === "string") return { responseDelta: chunk, thinkingDelta: "" };
  if (!isRecord(chunk)) return { responseDelta: "", thinkingDelta: "" };

  // Workers AI: { response: "tok" }
  if (typeof chunk.response === "string") {
    return { responseDelta: chunk.response, thinkingDelta: "" };
  }
  // OpenAI-compatible chat completions: { choices: [{ delta: { content, reasoning_content } }] }
  if (Array.isArray(chunk.choices) && isRecord(chunk.choices[0])) {
    const delta = isRecord(chunk.choices[0].delta) ? chunk.choices[0].delta : undefined;
    return {
      responseDelta: typeof delta?.content === "string" ? delta.content : "",
      thinkingDelta: typeof delta?.reasoning_content === "string" ? delta.reasoning_content : "",
    };
  }
  // Anthropic: { delta: { text, thinking } }
  if (isRecord(chunk.delta)) {
    return {
      responseDelta: typeof chunk.delta.text === "string" ? chunk.delta.text : "",
      thinkingDelta: typeof chunk.delta.thinking === "string" ? chunk.delta.thinking : "",
    };
  }
  return { responseDelta: "", thinkingDelta: "" };
}

function readCodeOutcome(payload: Record<string, unknown>): Partial<AgentUiCodeStep> {
  const parsed = ScriptExecutionSettlement.safeParse(payload.settlement);
  if (!parsed.success) {
    return {
      success: false,
      errorMessage: "The durable script settlement is invalid.",
    };
  }
  const settlement = parsed.data;
  if (settlement.status === "succeeded") {
    return {
      success: true,
      ...(Object.hasOwn(settlement, "result") && { result: settlement.result }),
    };
  }
  return { success: false, errorMessage: settlement.error };
}

function readUsageTokens(usage: unknown): { input?: number; output?: number } {
  if (!isRecord(usage)) return {};
  // The settled event's normalized usage (the contract's camelCase shape).
  return {
    ...(typeof usage.inputTokens === "number" && { input: usage.inputTokens }),
    ...(typeof usage.outputTokens === "number" && { output: usage.outputTokens }),
  };
}

function readProcessorAnnouncement(value: unknown): AgentUiProcessorAnnouncement | null {
  if (!isRecord(value)) return null;
  const announcement = isRecord(value.announcement) ? value.announcement : value;
  if (typeof announcement.slug !== "string" || typeof announcement.version !== "string")
    return null;
  return {
    slug: announcement.slug,
    version: announcement.version,
    description: typeof announcement.description === "string" ? announcement.description : "",
    consumes: readStringArray(announcement.consumes),
    emits: readStringArray(announcement.emits),
    ownedEvents: Array.isArray(announcement.ownedEvents)
      ? announcement.ownedEvents
          .filter((owned): owned is Record<string, unknown> => isRecord(owned))
          .filter((owned) => typeof owned.type === "string")
          .map((owned) => ({
            type: owned.type as string,
            ...(typeof owned.description === "string" && { description: owned.description }),
          }))
      : [],
  };
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

// Best-effort view of a Telegram Update webhook, mirroring the shape the
// telegram-agent processor parses (apps/os
// telegram-agent-processor-implementation.ts) without depending on it: the
// reducer only needs enough to render a chat bubble. Edits and non-message
// updates (membership changes, callback queries, ...) return null; media-only
// messages render their caption plus bracketed placeholders, matching the
// transcription the agent sees.
function readTelegramWebhookMessage(event: Event): { text: string; sender?: string } | null {
  const body = readRecord(event, "body");
  const message = isRecord(body?.message)
    ? body.message
    : isRecord(body?.channel_post)
      ? body.channel_post
      : null;
  if (!message) return null;
  const from = isRecord(message.from) ? message.from : null;
  if (from?.is_bot === true) return null;
  const caption = typeof message.caption === "string" ? message.caption : "";
  const rawText = typeof message.text === "string" ? message.text : caption;
  const placeholders = TELEGRAM_MEDIA_PLACEHOLDERS.filter(([key]) => !!message[key])
    .map(([, placeholder]) => placeholder)
    .join(" ");
  const text = [rawText, rawText === caption ? "" : "", placeholders]
    .filter((part) => part !== "")
    .join(" ")
    .trim();
  if (text === "") return null;
  const username = typeof from?.username === "string" ? from.username : "";
  const firstName = typeof from?.first_name === "string" ? from.first_name : "";
  const sender = username || firstName;
  return { text, ...(sender === "" ? {} : { sender }) };
}

/** Mirrors telegramMediaPlaceholders in apps/os
 * telegram-agent-processor-implementation.ts (kept import-free — the ui
 * package cannot depend on apps/os). */
const TELEGRAM_MEDIA_PLACEHOLDERS: Array<[key: string, placeholder: string]> = [
  ["photo", "[photo]"],
  ["voice", "[voice message]"],
  ["audio", "[audio]"],
  ["video", "[video]"],
  ["video_note", "[video note]"],
  ["sticker", "[sticker]"],
  ["document", "[document]"],
  ["animation", "[animation]"],
  ["location", "[location]"],
  ["contact", "[contact]"],
  ["poll", "[poll]"],
  ["venue", "[venue]"],
];

// Best-effort view of a Slack Events API `event_callback` message webhook.
// Mirrors the shape the slack-agent processor parses (see apps/os
// slack-agent-processor-implementation.ts) without depending on it: the
// reducer only needs enough to render a chat bubble. Non-message webhooks
// (reactions, channel joins) and edit/delete subtypes return null.
function readSlackWebhookMessage(
  event: Event,
): { text: string; kind: "user" | "assistant"; sender?: string } | null {
  const body = readRecord(event, "body");
  if (body?.type !== "event_callback") return null;
  const slackEvent = isRecord(body.event) ? body.event : null;
  if (!slackEvent || slackEvent.type !== "message") return null;
  const subtype = typeof slackEvent.subtype === "string" ? slackEvent.subtype : null;
  if (subtype && subtype !== "bot_message" && subtype !== "file_share") return null;
  const text = typeof slackEvent.text === "string" ? slackEvent.text : "";
  if (text === "") return null;
  const botProfile = isRecord(slackEvent.bot_profile) ? slackEvent.bot_profile : null;
  const fromBot =
    subtype === "bot_message" || typeof slackEvent.bot_id === "string" || !!botProfile;
  const botName = typeof botProfile?.name === "string" ? botProfile.name : "";
  const username = typeof slackEvent.username === "string" ? slackEvent.username : "";
  const userId = typeof slackEvent.user === "string" ? slackEvent.user : "";
  const sender = fromBot ? botName || username : userId;
  // Only OUR bot's messages are the assistant speaking; a third-party bot is
  // just another participant and renders as a user bubble (its name stays on
  // the via label). Identity comes from the webhook's `authorizations`
  // envelope, mirroring the slack-agent processor's isOwnBotMessage — and
  // like it, an incomparable identity is assumed to be our own.
  const kind = !fromBot ? "user" : isOwnSlackBotMessage(body, slackEvent) ? "assistant" : "user";
  return {
    text: slackMrkdwnToMarkdown(text),
    kind,
    ...(sender === "" ? {} : { sender }),
  };
}

function isOwnSlackBotMessage(
  body: Record<string, unknown>,
  slackEvent: Record<string, unknown>,
): boolean {
  const authorizations = Array.isArray(body.authorizations) ? body.authorizations : [];
  const botAuth = authorizations
    .filter(isRecord)
    .find((authorization) => authorization.is_bot === true);
  const authBotId = typeof botAuth?.bot_id === "string" ? botAuth.bot_id : null;
  const authUserId = typeof botAuth?.user_id === "string" ? botAuth.user_id : null;
  const botProfile = isRecord(slackEvent.bot_profile) ? slackEvent.bot_profile : null;
  const messageBotId = typeof slackEvent.bot_id === "string" ? slackEvent.bot_id : null;
  const messageUserId =
    typeof slackEvent.user === "string"
      ? slackEvent.user
      : typeof botProfile?.user_id === "string"
        ? botProfile.user_id
        : null;

  let compared = false;
  if (authBotId && messageBotId) {
    compared = true;
    if (messageBotId === authBotId) return true;
  }
  if (authUserId && messageUserId) {
    compared = true;
    if (messageUserId === authUserId) return true;
  }
  return !compared;
}

/**
 * Light mrkdwn → markdown: unwrap mentions and links, decode the three HTML
 * entities slack escapes. Deliberately does not touch bold/italic markers —
 * close enough is the goal.
 */
function slackMrkdwnToMarkdown(text: string): string {
  return text
    .replace(/<@([A-Z0-9]+)(?:\|([^>]+))?>/g, (_, id: string, label?: string) => `@${label || id}`)
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "[$2]($1)")
    .replace(/<(https?:\/\/[^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function readFileAttachments(event: Event): AgentUiFileAttachment[] {
  const value = readPayloadRecord(event)?.files;
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): AgentUiFileAttachment[] => {
    if (!isRecord(item)) return [];
    const contentType = typeof item.contentType === "string" ? item.contentType : null;
    const filename = typeof item.filename === "string" ? item.filename : null;
    const path = typeof item.path === "string" ? item.path : null;
    const size = typeof item.size === "number" && Number.isFinite(item.size) ? item.size : null;
    const url = typeof item.url === "string" ? item.url : null;
    if (!contentType || !filename || !path || !Number.isFinite(size) || !url) {
      return [];
    }
    return [{ contentType, filename, path, size, url }];
  });
}

function readString(event: Event, key: string): string | null {
  const value = readPayloadRecord(event)?.[key];
  return typeof value === "string" ? value : null;
}

function readOptionalReason(event: Event): { reason: string } | Record<string, never> {
  const reason = readString(event, "reason");
  return !reason ? {} : { reason };
}

function readNumber(event: Event, key: string): number | null {
  const value = readPayloadRecord(event)?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The llm-request-requested offset an LLM lifecycle event references. */
function readLlmRequestOffset(event: Event): number | null {
  return readNumber(event, "llmRequestOffset");
}

function readRecord(event: Event, key: string): Record<string, unknown> | null {
  const value = readPayloadRecord(event)?.[key];
  return isRecord(value) ? value : null;
}

function readPayloadRecord(event: Event): Record<string, unknown> | null {
  return isRecord(event.payload) ? event.payload : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
