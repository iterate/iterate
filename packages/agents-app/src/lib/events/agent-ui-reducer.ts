import { RUN_DEADLINE_MS, RunRequested, RunSettled } from "iterate/stream/run";
import { AgentContract, AgentLlmRequestCancelReason } from "iterate/agents/contract";
import { appendText, sliceText, type StreamText } from "../chunked-text.ts";
import type { StreamEvent } from "./stream-event.ts";

// The agent UI is a clean chat: user message → activity ("Ran code 2× · 3
// requests · 7.4 s") → assistant message, with pause and resume dividers.
// Reduced from raw events: settled items, plus the in-flight activity and its
// streamed text. Only a durable fact closes a step: `agent/llm-request-settled`
// a model call, the context's `itx/run-settled` a script (the platform settles
// every run, `deadline` or `interrupted` included).

/** One streamed window of an answer, as the agent's contract spells it. */
const LlmResponseFrame =
  AgentContract.events["events.iterate.com/agent/llm-response-frame"].payloadSchema;

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
  /** True once this request's reply went out while only older work still ran
   * (see emitAssistantMessageItem): nothing is held for that work to release. */
  repliedAtOnce?: boolean;
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
  /** Offset of the `itx/run-requested` event: the run's identity, which its
   * `itx/run-settled` names back. */
  requestOffset: number;
  status: "running" | "done";
  code: string;
  result?: unknown;
  errorMessage?: string;
  durationMs?: number;
  success?: boolean;
  startedAtMs: number;
  /** When the platform gives up on the run and settles it `deadline`: the
   * request's time plus RUN_DEADLINE_MS. */
  deadlineAtMs: number;
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
 *   script block — the agent's `itx/run-requested` is coming,
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
      if (last.status === "done" && last.success && last.result !== undefined) {
        return "processing";
      }
    }
    if (!state.paused && last?.kind === "llm") {
      // The response finished and visibly contains a script: what follows is
      // a journal fact either way — itx/run-requested when it extracts,
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
  /** Offset of the event that carried the message. */
  offset: number;
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
  /** User messages that landed while a step ran and that no request has taken up yet. */
  queuedUserMessages: AgentUiMessageItem[];
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

export function initialAgentUiState(): AgentUiState {
  return {
    live: null,
    deferredAssistantMessages: [],
    queuedUserMessages: [],
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
 * Flush at an idle boundary the agent reports outside the journal, dated
 * `since`: once no step is running, the live activity closes and the deferred
 * and queued messages follow it. A running step stays running — only its own
 * settlement closes it. Callers render the returned items as a transient tail;
 * the reduction itself stays journal facts only.
 */
export function settleAgentUiAtIdleBoundary(
  start: AgentUiState,
  since: string,
): { endState: AgentUiState; items: AgentUiItem[] } {
  const boundaryAtMs = Date.parse(since);
  if (!Number.isFinite(boundaryAtMs) || isAgentUiActivityWorking(start.live)) {
    return { endState: start, items: [] };
  }
  const items: AgentUiItem[] = [];
  const endState = flushDeferredMessages(settleLive(start, boundaryAtMs, items), items);
  return { endState, items };
}

function reduceAgentUiEvent(
  state: AgentUiState,
  event: StreamEvent,
  items: AgentUiItem[],
): AgentUiState {
  const timestampMs = Date.parse(event.createdAt);
  // Committed events are expected to carry an ISO timestamp. A malformed
  // timestamp must not manufacture NaN durations or deadlines; keep the raw
  // event visible, but do not fold it into the typed agent projection.
  if (!Number.isFinite(timestampMs)) return state;

  switch (event.type) {
    // The canonical model-visible context event. User context renders as a
    // bubble; assistant context replaces the streamed LLM text; the loop's
    // own developer context (actor `agent`, a format correction) renders as a
    // bubble too. Script-produced developer context is model input, not another bubble.
    case "events.iterate.com/agent/context-added": {
      const role = readString(event, "role");
      const text = readString(event, "content");
      // oxlint-disable-next-line iterate/simple-truthiness-check -- empty content is a real message: a person can send attachments alone (iterate/agents durable-object.ts message()), and an assistant's committed text replaces the streamed preview even when empty
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
          offset: event.offset,
          text,
          ...(files.length === 0 ? {} : { files }),
          timestampMs,
        });
      }
      if (actorType === "agent") {
        return emitUserMessageItem(state, items, {
          kind: "user",
          id: `user-${event.offset}`,
          offset: event.offset,
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
        offset: event.offset,
        text,
        ...(files.length === 0 ? {} : { files }),
        timestampMs,
      };
      return emitAssistantMessageItem(marked, items, item, extractedFromRequest);
    }

    case "events.iterate.com/agent/llm-request-requested": {
      // The agent builds a request's prompt from the log, so this request
      // answers every queued input: the activity it waited behind closes, and
      // every held message moves into the transcript in log order. A step
      // that still runs (a script outlives the request that wrote it) keeps
      // its activity live, since only its settlement ends it; this request
      // joins that activity, and the script's later replies wait for it.
      const ready =
        state.queuedUserMessages.length === 0 && state.live
          ? state
          : flushDeferredMessages(settleLive(state, timestampMs, items), items);
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
      // One coalesced window: the text and thinking it adds, as the processor extracted them.
      const frame = LlmResponseFrame.safeParse(event.payload);
      if (!frame.success) return state;
      const { llmRequestOffset, responseDelta, thinkingDelta } = frame.data;
      if (!responseDelta && !thinkingDelta) return state;
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

    // The CONTEXT's script run (core/os runs it): the request's offset is the
    // run, and its settlement names that offset back.
    case "events.iterate.com/itx/run-requested": {
      const parsed = RunRequested.safeParse(event.payload);
      if (!parsed.success) return state;
      // The agent asks for a run while processing the assistant item that
      // wrote it (the engine's `whileProcessing` stamp): that response's llm
      // step is interpreted — the Script tab now carries the code, so pretty
      // rendering can fold the raw response away.
      const askedWhile = event.source?.processor?.whileProcessing?.offset;
      const interpretedState =
        askedWhile === undefined
          ? state
          : markLlmStepInterpretedByAssistantOffset(state, askedWhile);
      const live = ensureLive(interpretedState, event.offset, timestampMs);
      const step: AgentUiCodeStep = {
        kind: "code",
        id: `code-${event.offset}`,
        requestOffset: event.offset,
        status: "running",
        code: parsed.data.code,
        startedAtMs: timestampMs,
        deadlineAtMs: timestampMs + RUN_DEADLINE_MS,
        // Inherit the stream's summary status from birth, so live headers
        // carry it — not only settled rounds.
        activitySummary: state.summaryActivity || undefined,
      };
      return { ...interpretedState, live: { ...live, steps: [...live.steps, step] } };
    }

    case "events.iterate.com/itx/run-settled": {
      const parsed = RunSettled.safeParse(event.payload);
      if (!parsed.success || !state.live) return state;
      const { requestOffset, settlement } = parsed.data;
      const steps = [...state.live.steps];
      const index = steps.findIndex(
        (step) => step.kind === "code" && step.requestOffset === requestOffset,
      );
      const step = steps[index];
      // The first settlement wins; a run this feed never saw requested is not a step.
      if (!step || step.kind !== "code" || step.status !== "running") return state;
      steps[index] = {
        ...step,
        status: "done",
        durationMs: Math.max(0, timestampMs - step.startedAtMs),
        ...(settlement.status === "succeeded"
          ? {
              success: true,
              ...(Object.hasOwn(settlement, "result") && { result: settlement.result }),
            }
          : { success: false, errorMessage: settlement.error }),
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
      // coming, and no second pause will arrive to close the activity. A
      // reply that already went out at once is the same: when this script
      // returned nothing (the turn ends, no follow-up round) nothing else
      // closes the activity. A script that returned a value is followed by a
      // request that joins this activity, so it stays open for that.
      const turnEnds = settlement.status === "succeeded" && settlement.result === undefined;
      const repliedAtOnce = next.live.steps.some(
        (candidate) => candidate.kind === "llm" && candidate.repliedAtOnce,
      );
      if (
        (next.deferredAssistantMessages.length > 0 ||
          next.queuedUserMessages.length > 0 ||
          next.paused ||
          (repliedAtOnce && turnEnds)) &&
        !isAgentUiActivityWorking(next.live)
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
      const settled = settleLive({ ...state, paused: true }, timestampMs, items);
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

/**
 * Close the live activity once nothing in it runs — every step closed by its
 * own settlement — and emit it as a settled item. A working activity stays
 * live: nothing but a step's settlement ends it.
 */
function settleLive(state: AgentUiState, endedAtMs: number, items: AgentUiItem[]): AgentUiState {
  if (!state.live || isAgentUiActivityWorking(state.live)) return state;
  if (state.live.steps.length > 0) items.push({ ...state.live, status: "done", endedAtMs });
  return { ...state, live: null };
}

/**
 * Emit the held assistant and user messages in log order, so a reply never
 * lands above the question before it. The two queues stay separate so that
 * assistant bubbles never show in the composer's "queued messages" panel.
 */
function flushDeferredMessages(state: AgentUiState, items: AgentUiItem[]): AgentUiState {
  items.push(
    ...[...state.deferredAssistantMessages, ...state.queuedUserMessages].sort(
      (a, b) => a.offset - b.offset,
    ),
  );
  return { ...state, deferredAssistantMessages: [], queuedUserMessages: [] };
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
  const settled = settleLive(state, item.timestampMs, items);
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
 * script group while web output remains deferred. The one exception is the
 * answer of a finished request while only OLDER work still runs (input sent
 * during a long script): nothing that request started is running, so the
 * reply lands at once, above the still-live activity, after the held replies
 * before it in log order. The activity stays live and whole until its own
 * settlements close it; the request's step is marked, so a script settlement
 * that ends the turn closes it (see itx/run-settled).
 */
function emitAssistantMessageItem(
  state: AgentUiState,
  items: AgentUiItem[],
  item: AgentUiMessageItem,
  llmRequestOffset: number | null,
): AgentUiState {
  // A live activity that survives settleLive is working.
  const settled = settleLive(state, item.timestampMs, items);
  if (!settled.live) {
    const flushed = flushDeferredMessages(settled, items);
    items.push(item);
    return flushed;
  }
  if (llmRequestOffset !== null && onlyOlderWorkRuns(settled.live, llmRequestOffset)) {
    items.push(...settled.deferredAssistantMessages, item);
    const replied = updateLlmStep(settled, llmRequestOffset, (step) => ({
      ...step,
      repliedAtOnce: true,
    }));
    return { ...replied, deferredAssistantMessages: [] };
  }
  return {
    ...settled,
    deferredAssistantMessages: [...settled.deferredAssistantMessages, item],
  };
}

/** Whether the request at `llmRequestOffset` finished in `live` and every step still running there
 *  began before it: work the request did not start, so its answer does not wait for that work. */
function onlyOlderWorkRuns(live: AgentUiActivity, llmRequestOffset: number): boolean {
  const request = live.steps.find(
    (step) => step.kind === "llm" && step.llmRequestOffset === llmRequestOffset,
  );
  if (request?.status !== "done") return false;
  return live.steps.every(
    (step) =>
      step.status === "done" ||
      (step.kind === "code" ? step.requestOffset : step.llmRequestOffset) < llmRequestOffset,
  );
}

/** Mark the llm step whose committed assistant event is `assistantEventOffset`
 * as interpreted (the agent asked for its script's run). */
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
