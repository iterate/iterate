import { RunSettled } from "iterate/stream/run";
import { appendText, sliceText, type StreamText } from "../chunked-text.ts";
import { AgentLlmRequestCancelReason } from "../../../../../configs/with-agents/agents/contract.ts";
import type { StreamEvent } from "./stream-event.ts";

// The agent UI is a clean chat: user message → activity ("Ran code 2× · 3
// requests · 7.4 s") → assistant message, with pause and resume dividers.
// Reduced from raw events: settled items, plus the in-flight activity and its
// streamed text.

export type AgentUiLlmStep = {
  kind: "llm";
  id: string;
  /** Offset of the llm-request-requested event this step tracks. */
  llmRequestOffset: number;
  status: "running" | "done";
  model?: string;
  /** Streamed reasoning summary ("thinking") text. */
  thinkingText: StreamText;
  /** Streamed response text — for code-mode agents this is source code. */
  responseText: StreamText;
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
      interruptedWithPartialResponse ||=
        step.thinkingText.length > 0 || step.responseText.length > 0;
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
  const summary = options.summary || summarizeAgentUiActivity(activity);
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
  const totalMs =
    activity.endedAtMs == null ? null : Math.max(0, activity.endedAtMs - activity.startedAtMs);
  if (totalMs != null && totalMs > 0) parts.push(formatAgentUiDuration(totalMs));
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
 * the llm half). The agent feed groups through this one function.
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

export function isAgentUiActivityWorking(activity: AgentUiActivity | null): boolean {
  return Boolean(activity?.steps.some((step) => step.status === "running"));
}

/** What the live activity is doing right now, from journal facts alone. */
export type AgentUiLivePhase =
  | "working"
  | "waiting"
  | "thinking"
  | "writing"
  | "running"
  | "processing";

export type AgentUiLiveStatus = {
  phase: AgentUiLivePhase;
  /** Agent-authored `activity` text set during THIS turn (a summary-updated
   * folded since the live activity started), or null — code steps inherit
   * `summaryActivity` at birth, so their stamp alone can be stale
   * previous-turn text and is deliberately not used here. */
  statusText: string | null;
};

/**
 * The live activity's current phase plus this turn's agent-set status text.
 * "processing" covers the two owed-but-not-yet-journaled gaps, both derived
 * from facts already in the journal — no timer debounce, no new events:
 * - the last step is a script that durably settled WITH a returned value
 *   (codemode contract: a returned value means another LLM round follows);
 * - the last step is a COMPLETED llm response whose text carries a codemode
 *   script block — the extraction's script-run-requested event is coming,
 *   and without this the card flashed settled between "writing code" and
 *   "running code".
 */
export function deriveAgentUiLiveStatus(state: AgentUiState): AgentUiLiveStatus | null {
  const live = state.live;
  if (!live) return null;
  const statusText =
    state.summaryActivity &&
    state.summaryActivityUpdatedAtMs !== null &&
    state.summaryActivityUpdatedAtMs >= live.startedAtMs
      ? state.summaryActivity
      : null;
  const phase = () => {
    const current = live.steps.findLast((step) => step.status === "running");
    if (current?.kind === "code") return "running";
    if (current?.kind === "llm" && current.responseText.length > 0) return "writing";
    if (current?.kind === "llm" && current.thinkingText.length > 0) return "thinking";
    if (current?.kind === "llm") return "waiting";
    const last = live.steps.at(-1);
    // A paused loop owes no follow-up, whatever the last step promised — a
    // pause folded mid-request must not leave a permanent claim after that
    // request's outcome lands.
    if (!state.paused && last?.kind === "code") {
      if (
        last.status === "done" &&
        last.outcomeSource === "durable" &&
        last.success === true &&
        last.result !== undefined
      ) {
        return "processing";
      }
    }
    if (!state.paused && last?.kind === "llm") {
      // The response finished and visibly contains a script: what follows is
      // a journal fact either way — script-run-requested when it extracts,
      // or the format's rejection feedback driving another llm request — so
      // the turn is not over.
      if (
        last.status === "done" &&
        last.outcome === "completed" &&
        sliceText(last.responseText).includes("<codemode")
      ) {
        return "processing";
      }
    }
    return "working";
  };
  return { phase: phase(), statusText };
}

/** A file attachment shown alongside a user message in the agent UI. */
export type AgentUiFileAttachment = {
  contentType: string;
  filename: string;
  path: string;
  size: number;
};

export type AgentUiMessageItem = {
  kind: "user" | "assistant";
  id: string;
  text: string;
  timestampMs: number;
  files?: AgentUiFileAttachment[];
};

export type AgentUiStreamPauseItem = {
  kind: "stream-paused" | "stream-resumed";
  id: string;
  text: string;
  reason?: string;
  timestampMs: number;
};

export type AgentUiItem = AgentUiMessageItem | AgentUiActivity | AgentUiStreamPauseItem;

export type AgentUiState = {
  /** The running activity (streaming thinking/code), or null when no work is active. */
  live: AgentUiActivity | null;
  /** Assistant bubbles held until the grouped activity closes. */
  deferredAssistantMessages: AgentUiMessageItem[];
  /** User messages that landed while the current request was already running. */
  queuedUserMessages: AgentUiMessageItem[];
  /**
   * Settled activities whose script outcome was inferred at a boundary rather
   * than supplied by a durable completion. A late completion replaces the
   * same feed item instead of leaving the inferred failure as permanent truth.
   */
  provisionalActivities: Record<string, AgentUiActivity>;
  /** Latest agent/summary-updated `activity` text — stamped onto code steps. */
  summaryActivity: string | null;
  /** When that text was folded. Compared against the live activity's start
   * to tell a this-turn status from stale previous-turn text (code steps
   * inherit `summaryActivity` at birth regardless of age). */
  summaryActivityUpdatedAtMs: number | null;
  /** The stream/agent is paused (agent/paused or itx/paused, uncleared by
   * a resume). A paused loop owes no follow-up round, so the "processing"
   * inference must not claim one. */
  paused: boolean;
};

/**
 * A durable completion normally follows its idle boundary immediately. Keep a
 * small correction window, but never let malformed streams with permanently
 * missing completions grow the reducer state without bound.
 */
export const AGENT_UI_PROVISIONAL_ACTIVITY_LIMIT = 32;

export function initialAgentUiState(): AgentUiState {
  return {
    live: null,
    deferredAssistantMessages: [],
    queuedUserMessages: [],
    provisionalActivities: {},
    summaryActivity: null,
    summaryActivityUpdatedAtMs: null,
    paused: false,
  };
}

/**
 * Fold ONE event into settled items + the resulting state. Items are appended
 * to `items` in emission order; the caller owns
 * list positions. Idempotent by construction: replaying the same event from
 * the same entry state yields the same items.
 */
export function reduceAgentUi(
  start: AgentUiState,
  event: StreamEvent,
): { endState: AgentUiState; items: AgentUiItem[] } {
  const items: AgentUiItem[] = [];
  const endState = reduceAgentUiEvent(start, event, items);
  return { endState, items };
}

/**
 * Close the journal-reduced UI state at an idle boundary the agent reports
 * outside the journal, dated `since`: overdue scripts expire, the live
 * activity settles and deferred messages flush. Callers render the returned
 * items as a transient tail; the reduction itself stays journal facts only.
 */
export function settleAgentUiAtIdleBoundary(
  start: AgentUiState,
  since: string,
): { endState: AgentUiState; items: AgentUiItem[] } {
  const boundaryAtMs = Date.parse(since);
  if (!Number.isFinite(boundaryAtMs)) {
    return { endState: start, items: [] };
  }

  const items: AgentUiItem[] = [];
  const expired = expireOverdueCodeSteps(start, boundaryAtMs);
  const endState = flushDeferredMessages(settleLive(expired, boundaryAtMs, items), items);
  return { endState, items };
}

function reduceAgentUiEvent(
  state: AgentUiState,
  event: StreamEvent,
  items: AgentUiItem[],
): AgentUiState {
  const timestampMs = Date.parse(event.createdAt);
  // Committed events are expected to carry an ISO timestamp. A malformed
  // timestamp must not manufacture NaN durations or accidentally trip a
  // script deadline comparison; keep the raw event visible, but do not fold
  // it into the typed agent projection.
  if (!Number.isFinite(timestampMs)) return state;

  switch (event.type) {
    // The canonical model-visible context event. User context renders as a
    // bubble; assistant context replaces the streamed LLM text; the loop's
    // own developer context (actor `agent`, a format correction) renders as a
    // bubble too. Script-produced developer context is model input, not another bubble.
    case "events.iterate.com/agent/context-added": {
      const role = readString(event, "role");
      const text = readString(event, "content");
      // oxlint-disable-next-line iterate/simple-truthiness-check -- empty content is a real message: a person can send attachments alone (configs/with-agents/agents/durable-object.ts message()), and an assistant's committed text replaces the streamed preview even when empty
      if (text == null) return state;
      const actor = readRecord(event, "actor");
      const actorType = typeof actor?.type === "string" ? actor.type : undefined;

      if (role === "assistant") {
        const llmRequestOffset = readLlmRequestOffset(event);
        if (llmRequestOffset == null) return state;
        return updateLlmStep(state, llmRequestOffset, (step) =>
          step.status === "running"
            ? {
                ...step,
                responseText: text,
                assistantEventOffset: event.offset,
              }
            : step,
        );
      }
      if (role === "system") return state;

      const files = readFileAttachments(event);
      if (role === "user") {
        return emitUserMessageItem(state, items, {
          kind: "user",
          id: `user-${event.offset}`,
          text,
          ...(files.length === 0 ? {} : { files }),
          timestampMs,
        });
      }
      if (actorType === "agent") {
        return emitUserMessageItem(state, items, {
          kind: "user",
          id: `user-${event.offset}`,
          text,
          ...(files.length === 0 ? {} : { files }),
          timestampMs,
        });
      }
      return state;
    }

    case "events.iterate.com/agent/web-message-sent": {
      const text = readString(event, "message");
      // oxlint-disable-next-line iterate/simple-truthiness-check -- an empty message is still a sent message: it can carry attachments alone
      if (text == null) return state;
      // An llmRequestOffset marks the message as EXTRACTED from that request's
      // response (a userland response interpreter) — the raw response text is
      // now redundant in pretty rendering.
      const extractedFromRequest = readLlmRequestOffset(event);
      const marked =
        extractedFromRequest == null
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

    case "events.iterate.com/agent/llm-request-requested": {
      const base =
        state.queuedUserMessages.length === 0 ? state : settleLive(state, timestampMs, items);
      const ready =
        !base.live &&
        (base.deferredAssistantMessages.length > 0 || base.queuedUserMessages.length > 0)
          ? flushDeferredMessages(base, items)
          : base;
      const live = ensureLive(ready, event.offset, timestampMs);
      const model = readString(event, "model");
      const step: AgentUiLlmStep = {
        kind: "llm",
        id: `llm-${event.offset}`,
        llmRequestOffset: event.offset,
        status: "running",
        model: model || undefined,
        thinkingText: "",
        responseText: "",
        startedAtMs: timestampMs,
      };
      return { ...ready, live: { ...live, steps: [...live.steps, step] } };
    }

    case "events.iterate.com/agent/llm-response-frame": {
      const llmRequestOffset = readLlmRequestOffset(event);
      if (llmRequestOffset == null) return state;
      const payload = readPayloadRecord(event);
      // One coalesced window: the provider chunks it carries, in order.
      const chunks = Array.isArray(payload?.chunks) ? payload.chunks : [];
      let responseDelta = "";
      let thinkingDelta = "";
      for (const chunk of chunks) {
        const deltas = llmChunkDeltas(chunk);
        responseDelta += deltas.responseDelta;
        thinkingDelta += deltas.thinkingDelta;
      }
      if (responseDelta === "" && thinkingDelta === "") return state;
      return updateLlmStep(state, llmRequestOffset, (step) => ({
        ...step,
        responseText:
          step.status === "running" && responseDelta !== ""
            ? appendText(step.responseText, responseDelta)
            : step.responseText,
        thinkingText:
          step.status === "running" && thinkingDelta !== ""
            ? appendText(step.thinkingText, thinkingDelta)
            : step.thinkingText,
      }));
    }

    case "events.iterate.com/agent/llm-request-settled": {
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
              // partialText is the authoritative superset: it accrued per
              // provider chunk, while responseText only holds FLUSHED windows
              // — an interrupt can strand up to one coalescing window's tail
              // in the buffer. Adopt the recorded text when it extends the preview.
              ...(partialText &&
                partialText.length > step.responseText.length &&
                partialText.startsWith(sliceText(step.responseText)) && {
                  responseText: partialText,
                }),
              ...(typeof payload.durationMs === "number"
                ? { durationMs: payload.durationMs }
                : status === "cancelled"
                  ? { durationMs: Math.max(0, timestampMs - step.startedAtMs) }
                  : {}),
              inputTokens: usage.input,
              outputTokens: usage.output,
              errorMessage,
              cancelReason: cancelReason || undefined,
            },
      );
    }

    case "events.iterate.com/capability-host/script-run-requested": {
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
      const interpretedState = extractedFromAssistantOffset
        ? markLlmStepInterpretedByAssistantOffset(state, Number(extractedFromAssistantOffset[1]))
        : state;
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
        activitySummary: state.summaryActivity || undefined,
      };
      return { ...interpretedState, live: { ...live, steps: [...live.steps, step] } };
    }

    case "events.iterate.com/capability-host/script-run-settled": {
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
        activitySummary: state.summaryActivity || undefined,
      };
      const next = { ...state, live: { ...state.live, steps } };
      // A visible reply the script sent was deferred while its step ran (see
      // emitAssistantMessageItem). If this settle is the turn's last journal
      // fact — nothing running, no follow-up round — no later event exists to
      // flush it, and the idle-boundary flush is a transient overlay driven
      // by the agent's idle report, which can lag or wedge. Journal facts alone must
      // surface a sent message: settle the activity here and flush. A paused
      // loop is the same situation even with no deferred messages: the pause
      // fact already landed (possibly mid-request), no follow-up round is
      // coming, and no second pause will arrive to close the activity.
      if (
        (next.deferredAssistantMessages.length > 0 ||
          next.queuedUserMessages.length > 0 ||
          next.paused) &&
        !steps.some((candidate) => candidate.status === "running")
      ) {
        return flushDeferredMessages(settleLive(next, timestampMs, items), items);
      }
      return next;
    }

    case "events.iterate.com/agent/summary-updated": {
      const activity = readString(event, "activity");
      if (!activity) return state;
      // Summaries are usually appended by the running script itself, so the
      // running code step picks the new text up immediately (live rounds show
      // it before the settle stamp lands).
      if (state.live) {
        const steps = state.live.steps.map((step) =>
          step.kind === "code" && step.status === "running"
            ? { ...step, activitySummary: activity }
            : step,
        );
        return {
          ...state,
          summaryActivity: activity,
          summaryActivityUpdatedAtMs: timestampMs,
          live: { ...state.live, steps },
        };
      }
      return { ...state, summaryActivity: activity, summaryActivityUpdatedAtMs: timestampMs };
    }

    // The stream-level facts (the whole stream stops accepting appends) and
    // the agent-level facts (the turn loop parks — the autonomous breaker, or
    // an operator) render as the same pause/resume marker rows. A pause is
    // also a run boundary: no more work is coming, so an idle live activity
    // (e.g. mid-turn after a script returned a value — the "processing" gap)
    // settles from this journal fact alone instead of waiting on the
    // idle-boundary overlay. A still-running step keeps the activity
    // live: agent/paused is operator/script-appendable while a request is
    // open, and that request settles normally.
    case "events.iterate.com/itx/paused":
    case "events.iterate.com/agent/paused": {
      const settled = settleActivityAtBoundary({ ...state, paused: true }, timestampMs, items);
      const flushed = settled.live ? settled : flushDeferredMessages(settled, items);
      items.push({
        kind: "stream-paused",
        id: `stream-paused-${event.offset}`,
        text: "Agent paused",
        ...readOptionalReason(event),
        timestampMs,
      });
      return flushed;
    }

    case "events.iterate.com/itx/resumed":
    case "events.iterate.com/agent/resumed":
      items.push({
        kind: "stream-resumed",
        id: `stream-resumed-${event.offset}`,
        text: "Agent resumed",
        ...readOptionalReason(event),
        timestampMs,
      });
      return { ...state, paused: false };

    default:
      return state;
  }
}

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

function settleLiveIfIdle(
  state: AgentUiState,
  endedAtMs: number,
  items: AgentUiItem[],
): AgentUiState {
  if (isAgentUiActivityWorking(state.live)) return state;
  return settleLive(state, endedAtMs, items);
}

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
      errorMessage:
        "Script execution exceeded its deadline without a completion event. It may have partially executed and was NOT re-run.",
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
  if (state.live.steps.length === 0) return { ...state, live: null };
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
            errorMessage:
              "The agent became idle without a durable LLM completion or cancellation event.",
          }
        : {
            ...step,
            status: "done",
            success: false,
            outcomeSource: "inferred",
            durationMs,
            errorMessage:
              "The agent became idle without a durable script completion event. Its execution outcome is unknown; do not assume it is safe to re-run.",
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
  items.push(settled);
  return { ...state, live: null, provisionalActivities };
}

function flushQueuedUserMessages(state: AgentUiState, items: AgentUiItem[]): AgentUiState {
  items.push(...state.queuedUserMessages);
  return { ...state, queuedUserMessages: [] };
}

/**
 * Emit the current turn's assistant output before user messages queued for the
 * next turn. Keeping the two queues separate also prevents assistant bubbles
 * from appearing in the composer's "queued messages" affordance.
 */
function flushDeferredMessages(state: AgentUiState, items: AgentUiItem[]): AgentUiState {
  items.push(...state.deferredAssistantMessages);
  return flushQueuedUserMessages({ ...state, deferredAssistantMessages: [] }, items);
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
  if (isAgentUiActivityWorking(settled.live)) {
    return { ...settled, queuedUserMessages: [...settled.queuedUserMessages, item] };
  }
  const flushed = settled.live ? settled : flushDeferredMessages(settled, items);
  items.push(item);
  return flushed;
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
  if (isAgentUiActivityWorking(settled.live)) {
    return {
      ...settled,
      deferredAssistantMessages: [...settled.deferredAssistantMessages, item],
    };
  }
  const flushed = settled.live ? settled : flushDeferredMessages(settled, items);
  items.push(item);
  return flushed;
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
  items.push(corrected);
  return { ...state, provisionalActivities };
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
 * The response/thinking text deltas inside one streamed LLM chunk, in the
 * shapes configs/with-agents/agents/processor.ts puts into `llm-response-frame`:
 * OpenAI Responses API events for a partner model, and a `@cf/` Workers AI
 * model's raw SSE events (`{ response }`, or `choices[].delta` from a model
 * that speaks the OpenAI chat format).
 */
function llmChunkDeltas(chunk: unknown): {
  responseDelta: string;
  thinkingDelta: string;
} {
  if (typeof chunk === "string") return { responseDelta: chunk, thinkingDelta: "" };
  if (!isRecord(chunk)) return { responseDelta: "", thinkingDelta: "" };

  // OpenAI Responses API stream events: { type: "response.output_text.delta", delta } and the
  // reasoning summary's { type: "response.reasoning_summary_text.delta", delta }.
  if (typeof chunk.type === "string" && typeof chunk.delta === "string") {
    if (chunk.type === "response.output_text.delta")
      return { responseDelta: chunk.delta, thinkingDelta: "" };
    if (chunk.type === "response.reasoning_summary_text.delta")
      return { responseDelta: "", thinkingDelta: chunk.delta };
    return { responseDelta: "", thinkingDelta: "" };
  }
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
  return { responseDelta: "", thinkingDelta: "" };
}

function readCodeOutcome(payload: Record<string, unknown>): Partial<AgentUiCodeStep> {
  const parsed = RunSettled.shape.settlement.safeParse(payload.settlement);
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

function readFileAttachments(event: StreamEvent): AgentUiFileAttachment[] {
  const value = readPayloadRecord(event)?.files;
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): AgentUiFileAttachment[] => {
    if (!isRecord(item)) return [];
    const contentType = typeof item.contentType === "string" ? item.contentType : null;
    const filename = typeof item.filename === "string" ? item.filename : null;
    const path = typeof item.path === "string" ? item.path : null;
    const size = typeof item.size === "number" && Number.isFinite(item.size) ? item.size : null;
    if (!contentType || !filename || !path || size == null) return [];
    return [{ contentType, filename, path, size }];
  });
}

function readString(event: StreamEvent, key: string): string | null {
  const value = readPayloadRecord(event)?.[key];
  return typeof value === "string" ? value : null;
}

function readOptionalReason(event: StreamEvent): { reason: string } | Record<string, never> {
  const reason = readString(event, "reason");
  return reason ? { reason } : {};
}

function readNumber(event: StreamEvent, key: string): number | null {
  const value = readPayloadRecord(event)?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The llm-request-requested offset an LLM lifecycle event references. */
function readLlmRequestOffset(event: StreamEvent): number | null {
  return readNumber(event, "llmRequestOffset");
}

function readRecord(event: StreamEvent, key: string): Record<string, unknown> | null {
  const value = readPayloadRecord(event)?.[key];
  return isRecord(value) ? value : null;
}

function readPayloadRecord(event: StreamEvent): Record<string, unknown> | null {
  return isRecord(event.payload) ? event.payload : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && !!value && !Array.isArray(value);
}
