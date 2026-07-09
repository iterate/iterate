import { z } from "zod";
import type { StreamEvent } from "../streams/schemas.ts";
import { StreamProcessor } from "../streams/stream-processor.ts";
import {
  AgentProcessorContract,
  DEFAULT_AGENT_LLM_REQUEST_DEBOUNCE_MS,
  DEFAULT_AGENT_MAX_AUTONOMOUS_TURNS,
  totalTokensFromUsage,
  type AgentFileAttachment,
} from "./agent-processor-contract.ts";
import {
  buildCompactionRequestMessages,
  planCompaction,
  renderCompactionSummaryMessage,
} from "./agent-compaction.ts";

type AgentState = z.infer<typeof AgentProcessorContract.stateSchema>;
type AgentConsumedEvent = ReturnType<typeof AgentProcessorContract.parseEvent>;

/**
 * Host-provided deps beyond the stream plumbing. `writeWorkspaceFile` writes
 * one file into THIS agent's own workspace (the same checkout `itx.workspace`
 * resolves to) so oversized script results can spill to a file the model pages
 * through with plain JavaScript. Optional: without it (bare test hosts),
 * oversized results fall back to inline truncation.
 */
type AgentProcessorDeps = {
  writeWorkspaceFile?: (input: { content: string; path: string }) => Promise<void>;
};

export class AgentProcessor extends StreamProcessor<AgentProcessorContract, AgentProcessorDeps> {
  readonly contract = AgentProcessorContract;
  readonly #scheduledRequestsWithActiveTimers = new Set<string>();

  protected override reduce({
    event,
    state,
  }: Parameters<StreamProcessor<AgentProcessorContract>["reduce"]>[0]) {
    return reduceAgentEvent({ event, state });
  }

  protected override processEvent({
    append,
    blockProcessorWhile,
    event,
    previousState,
    runInBackground,
    state,
  }: Parameters<StreamProcessor<AgentProcessorContract>["processEvent"]>[0]): undefined {
    switch (event.type) {
      case "events.iterate.com/agent/config-updated": {
        if (event.payload.systemPrompt === undefined) return;
        const { systemPrompt } = event.payload;
        blockProcessorWhile(() =>
          append({
            type: "events.iterate.com/agent/system-prompt-updated",
            idempotencyKey: `agent/system-prompt-updated@${event.offset}`,
            payload: { systemPrompt },
          }),
        );
        return;
      }
      case "events.iterate.com/agents/user-message-received":
        blockProcessorWhile(() =>
          append({
            type: "events.iterate.com/agent/input-added",
            idempotencyKey: `agent/render-web-message@${event.offset}`,
            payload: {
              content: event.payload.content,
              llmRequestPolicy: { behaviour: "after-current-request" },
            },
          }),
        );
        return;
      case "events.iterate.com/agents/web-message-sent": {
        // Files the agent attached to its own message ride the reflection too,
        // so the model SEES what it sent (vision) on later turns.
        const files = event.payload.files;
        blockProcessorWhile(() =>
          append({
            type: "events.iterate.com/agent/input-added",
            idempotencyKey: `agent/render-web-response@${event.offset}`,
            payload: {
              content: `The assistant sent this visible web-chat message: ${event.payload.message}`,
              ...(files === undefined || files.length === 0 ? {} : { files }),
              llmRequestPolicy: { behaviour: "dont-trigger-request" },
            },
          }),
        );
        return;
      }
      case "events.iterate.com/agent/input-added": {
        // Scheduling the next LLM request is derived from reduced state at the
        // end of the batch (see #settleLlmRequestScheduling); the only
        // per-event side effect is interrupting a request already underway.
        if (event.payload.llmRequestPolicy.behaviour !== "interrupt-current-request") return;
        const interrupted = previousState.currentRequest;
        if (interrupted === null) return;
        blockProcessorWhile(() => append(cancelEventForCurrentRequest(interrupted)));
        return;
      }
      case "events.iterate.com/agent/llm-request-scheduled":
        this.#scheduledRequestsWithActiveTimers.add(event.payload.requestId);
        runInBackground(async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, event.payload.debounceMs));
          try {
            await append({
              type: "events.iterate.com/agent/llm-request-requested",
              idempotencyKey: `agent/llm-request-requested@${event.offset}`,
              payload: {
                model: event.payload.model,
                provider: event.payload.provider,
                requestId: event.payload.requestId,
                ...(event.payload.purpose === undefined ? {} : { purpose: event.payload.purpose }),
              },
            });
          } finally {
            this.#scheduledRequestsWithActiveTimers.delete(event.payload.requestId);
          }
        });
        return;
      case "events.iterate.com/agent/output-added": {
        // A compaction request's output is the checkpoint document: it
        // becomes compaction-completed (folded by the reducer into a
        // compacted history) and is never scanned for scripts — a summarizer
        // hallucinating a code block must not cause side effects.
        const request = previousState.currentRequest;
        if (
          request?.phase === "requested" &&
          request.purpose === "compaction" &&
          request.llmRequestId === event.payload.llmRequestId
        ) {
          const pending = previousState.pendingCompaction;
          if (pending === null) return;
          blockProcessorWhile(async () => {
            if (event.payload.content.trim() === "") {
              await append({
                type: "events.iterate.com/agent/compaction-failed",
                idempotencyKey: `agent/compaction-failed@${event.offset}`,
                payload: {
                  error: { message: "Summarizer returned empty output." },
                  requestedOffset: pending.requestedOffset,
                },
              });
              return;
            }
            await append({
              type: "events.iterate.com/agent/compaction-completed",
              idempotencyKey: `agent/compaction-completed@${event.offset}`,
              payload: {
                summary: event.payload.content,
                firstKeptOffset: pending.firstKeptOffset,
                tokensBefore: pending.tokensBefore,
              },
            });
          });
          return;
        }
        blockProcessorWhile(async () => {
          const code = extractAsyncJsSnippet(event.payload.content);
          if (code === null) return;
          await append({
            type: "events.iterate.com/capability-host/script-execution-requested",
            idempotencyKey: `itx/script-execution-requested@${event.offset}`,
            payload: {
              code,
              executionId: `${AGENT_SCRIPT_EXECUTION_ID_PREFIX}${event.offset}`,
            },
          });
        });
        return;
      }
      case "events.iterate.com/capability-host/script-execution-completed": {
        // Rendering may spill an oversized result into the agent's workspace
        // first (a durable write that can wait on the checkout's first-use
        // clone), so the whole render-then-append runs inside the blocking
        // section — the input must not land before the file it references.
        blockProcessorWhile(async () => {
          const content = await scriptResultAgentInput(event, this.deps.writeWorkspaceFile);
          if (content === null) return;
          await append({
            type: "events.iterate.com/agent/input-added",
            idempotencyKey: `agent/render-script-result@${event.offset}`,
            payload: {
              content,
              llmRequestPolicy: { behaviour: "after-current-request" },
            },
          });
        });
        return;
      }
      // A failed request must never brick the stream: the error becomes a
      // model-visible input, exactly like a thrown script. Below the
      // consecutive-failure cap the input triggers a retry so the model can
      // react (fix its request, tell the user what happened); at the cap it
      // sits in context untriggered so a persistent provider failure (bad key,
      // outage) cannot retry-loop — the next user message resumes normally.
      case "events.iterate.com/agent/llm-request-completed": {
        const result = event.payload.result;
        if (result.status !== "failure") return;
        if (
          previousState.currentRequest?.phase !== "requested" ||
          previousState.currentRequest.llmRequestId !== event.payload.llmRequestId
        ) {
          // Stale completion (e.g. the request was already cancelled) — the
          // reducer ignored it, so don't render an error input for it either.
          return;
        }
        if (previousState.currentRequest.purpose === "compaction") {
          // A failed summarization never touches history and never renders a
          // model-visible error: journal the failure and move on. The trigger
          // won't retry until fresh usage arrives (lastCompactionAttempt), so
          // a broken summarizer degrades to "no compaction".
          const pending = previousState.pendingCompaction;
          blockProcessorWhile(() =>
            append({
              type: "events.iterate.com/agent/compaction-failed",
              idempotencyKey: `agent/compaction-failed@${event.offset}`,
              payload: {
                error: { message: result.error.message },
                requestedOffset:
                  pending === null ? event.payload.llmRequestId : pending.requestedOffset,
              },
            }),
          );
          return;
        }
        const retry = state.consecutiveLlmFailures < MAX_CONSECUTIVE_LLM_FAILURES;
        blockProcessorWhile(() =>
          append({
            type: "events.iterate.com/agent/input-added",
            idempotencyKey: `agent/render-llm-failure@${event.offset}`,
            payload: {
              content:
                `Your LLM request failed (${event.payload.provider}):\n\`\`\`\n${result.error.message}\n\`\`\`` +
                (retry
                  ? ""
                  : `\nConsecutive failure ${state.consecutiveLlmFailures} — automatic retries stopped; this stays in your context for the next turn.`),
              llmRequestPolicy: {
                behaviour: retry ? "after-current-request" : "dont-trigger-request",
              },
            },
          }),
        );
        return;
      }
      default:
        return;
    }
  }

  protected override async processEventBatch(
    args: Parameters<StreamProcessor<AgentProcessorContract>["processEventBatch"]>[0],
  ): Promise<void> {
    await super.processEventBatch(args);
    await this.#settleLlmRequestScheduling(args);
  }

  /**
   * The LLM-request scheduling decision, derived from reduced state once per
   * batch after the whole fold — never per event, where appends made earlier
   * in the same batch are invisible. "A trigger is pending and no request is
   * current" means exactly one llm-request-scheduled for the current request
   * generation; the generation-keyed idempotency makes every re-derivation
   * (many inputs in one batch, chunked delivery, crash replay) collapse into
   * the same stream event.
   */
  async #settleLlmRequestScheduling(
    args: Parameters<StreamProcessor<AgentProcessorContract>["processEventBatch"]>[0],
  ): Promise<void> {
    const { state } = args;
    if (state.currentRequest === null) {
      // A pending compaction owns the request slot: its summarization call
      // runs before any chat request, and the chat trigger stays pending
      // until the compaction settles (completed, failed, or cancelled). Keyed
      // on the compaction's own offset, not the request generation, so
      // re-derivations while the completion is still landing collapse into
      // the one scheduled event.
      if (state.pendingCompaction !== null) {
        await args.append({
          type: "events.iterate.com/agent/llm-request-scheduled",
          idempotencyKey: `agent/llm-request-scheduled@compaction:${state.pendingCompaction.requestedOffset}`,
          payload: {
            debounceMs: 0,
            model: state.llmConfig.model,
            provider: state.llmProvider,
            purpose: "compaction",
            requestId: `llm-request:compaction-${state.pendingCompaction.requestedOffset}`,
          },
        });
        return;
      }
      if (state.pendingTriggerOffset === null) return;
      if (
        state.pendingTriggerSource === "agent-loop" &&
        state.autonomousTurnCount >= DEFAULT_AGENT_MAX_AUTONOMOUS_TURNS
      ) {
        await args.append({
          type: "events.iterate.com/agent/loop-stopped",
          idempotencyKey: `agent/autonomous-turn-limit:${state.pendingTriggerOffset}`,
          payload: {
            maxAutonomousTurns: DEFAULT_AGENT_MAX_AUTONOMOUS_TURNS,
            reason: `Agent circuit breaker stopped after ${DEFAULT_AGENT_MAX_AUTONOMOUS_TURNS} consecutive autonomous turns.`,
            triggerOffset: state.pendingTriggerOffset,
          },
        });
        return;
      }
      // Over the context budget? Compact before answering: the summarization
      // request runs first and the pending trigger schedules right after the
      // compaction folds. One attempt per usage measurement (the idempotency
      // key and lastCompactionAttempt), so a failed compaction falls through
      // to a normal request on the next settle instead of looping.
      const compactionPlan = planCompaction(state);
      if (compactionPlan !== null) {
        await args.append({
          type: "events.iterate.com/agent/compaction-requested",
          idempotencyKey: `agent/compaction-requested@usage:${compactionPlan.usageLlmRequestId}`,
          payload: {
            reason: "threshold",
            firstKeptOffset: compactionPlan.firstKeptOffset,
            tokensBefore: compactionPlan.tokensBefore,
          },
        });
        return;
      }
      await args.append({
        type: "events.iterate.com/agent/llm-request-scheduled",
        idempotencyKey: `agent/llm-request-scheduled@generation:${state.requestGeneration}`,
        payload: {
          debounceMs: DEFAULT_AGENT_LLM_REQUEST_DEBOUNCE_MS,
          model: state.llmConfig.model,
          provider: state.llmProvider,
          requestId: `llm-request:gen-${state.requestGeneration}`,
        },
      });
      return;
    }
    if (state.currentRequest.phase !== "scheduled") return;
    if (this.#scheduledRequestsWithActiveTimers.has(state.currentRequest.requestId)) return;
    // No active timer for this scheduled request: the DO restarted and lost the
    // debounce. Fire llm-request-requested immediately. The idempotency key
    // makes this safe if the timer also fires concurrently.
    await args.append({
      type: "events.iterate.com/agent/llm-request-requested",
      idempotencyKey: `agent/llm-request-requested@${state.currentRequest.scheduledOffset}`,
      payload: {
        model: state.llmConfig.model,
        provider: state.llmProvider,
        requestId: state.currentRequest.requestId,
        ...(state.currentRequest.purpose === undefined
          ? {}
          : { purpose: state.currentRequest.purpose }),
      },
    });
  }
}

export function reduceAgentEvents(events: readonly StreamEvent[]): AgentState {
  let state = AgentProcessorContract.stateSchema.parse({});
  for (const event of events) {
    try {
      state = reduceAgentEvent({
        event: AgentProcessorContract.parseEvent(event) as AgentConsumedEvent,
        state,
      });
    } catch {
      continue;
    }
  }
  return state;
}

/** One agent-history message as providers receive it. */
export type AgentChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
  files?: AgentFileAttachment[];
};

function buildLlmChatRequest(state: AgentState): { messages: AgentChatMessage[] } {
  return {
    messages: [
      { role: "system" as const, content: state.systemPrompt },
      // Internal bookkeeping fields (offset/summary compaction tags) never
      // reach the provider: the LLM-facing message shape is role/content/files.
      ...state.history.map(({ role, content, files }) => ({
        role,
        content,
        ...(files === undefined || files.length === 0 ? {} : { files }),
      })),
    ],
  };
}

/**
 * The model-visible text for a file the current model cannot ingest natively:
 * never fail the turn — tell the agent where the bytes live and how to read
 * or convert them, and let it act (fetch via itx.files, convert via
 * itx.ai.toMarkdown) on its next script.
 */
export function renderFileHintLine(file: AgentFileAttachment): string {
  return (
    `[Attached file: ${file.filename} (${file.contentType}, ${file.size} bytes) — ` +
    `bytes: await itx.files.get(${JSON.stringify(file.path)}).bytes(); ` +
    `convert: itx.ai.toMarkdown; public url: ${file.url}]`
  );
}

/**
 * Flattens one history message to plain text: content plus a hint line per
 * attachment. Providers without native file support (or for non-image files)
 * render attachments this way.
 */
export function flattenMessageToText(message: AgentChatMessage): string {
  const files = message.files ?? [];
  if (files.length === 0) return message.content;
  return [message.content, ...files.map(renderFileHintLine)].join("\n");
}

export type AgentLlmRequestBody = {
  messages: AgentChatMessage[];
  /** "compaction" when this request is a summarization call (its output folds
   * into compaction-completed, never chat history). */
  purpose: "chat" | "compaction";
  /**
   * Compaction boundaries folded into this body. Providers with server-side
   * continuation (openai-ws `previous_response_id`) must full-resend when this
   * changes: the server-retained context still holds the UNcompacted history,
   * so reusing it would defeat the compaction and keep reported usage high.
   */
  compactionCount: number;
};

export function buildAgentLlmRequestBody(input: {
  events: readonly StreamEvent[];
  llmRequestId: number;
}): AgentLlmRequestBody {
  const events = input.events.filter((event) => event.offset <= input.llmRequestId);
  const state = reduceAgentEvents(events);
  const compactionCount = events.filter(
    (event) => event.type === "events.iterate.com/agent/compaction-completed",
  ).length;
  if (
    state.currentRequest?.phase === "requested" &&
    state.currentRequest.llmRequestId === input.llmRequestId &&
    state.currentRequest.purpose === "compaction" &&
    state.pendingCompaction !== null
  ) {
    return {
      messages: buildCompactionRequestMessages({
        history: state.history,
        firstKeptOffset: state.pendingCompaction.firstKeptOffset,
      }),
      purpose: "compaction",
      compactionCount,
    };
  }
  return { ...buildLlmChatRequest(state), purpose: "chat", compactionCount };
}

function reduceAgentEvent(input: { event: AgentConsumedEvent; state: AgentState }): AgentState {
  const { event, state } = input;
  switch (event.type) {
    case "events.iterate.com/agent/config-updated":
      return state;
    case "events.iterate.com/agent/system-prompt-updated":
      return { ...state, systemPrompt: event.payload.systemPrompt };
    case "events.iterate.com/agent/input-added": {
      const triggerSource = agentInputTriggerSource(event);
      const files = event.payload.files;
      return {
        ...state,
        history: [
          ...state.history,
          {
            role: "user",
            content: event.payload.content,
            offset: event.offset,
            ...(files === undefined || files.length === 0 ? {} : { files }),
          },
        ],
        pendingTriggerOffset: triggerSource === null ? state.pendingTriggerOffset : event.offset,
        pendingTriggerSource: triggerSource === null ? state.pendingTriggerSource : triggerSource,
        autonomousTurnCount: triggerSource === "user" ? 0 : state.autonomousTurnCount,
      };
    }
    case "events.iterate.com/agent/output-added":
      // A compaction request's output is the checkpoint document, not an
      // assistant turn: it folds into history via compaction-completed
      // (appended by processEvent), never directly.
      if (
        state.currentRequest?.phase === "requested" &&
        state.currentRequest.purpose === "compaction" &&
        state.currentRequest.llmRequestId === event.payload.llmRequestId
      ) {
        return state;
      }
      return {
        ...state,
        history: [
          ...state.history,
          { role: "assistant", content: event.payload.content, offset: event.offset },
        ],
      };
    case "events.iterate.com/agent/llm-provider-selected": {
      if (event.payload.ifUnset && state.llmProviderConfigured) return state;
      const contextWindowTokens = event.payload.contextWindowTokens;
      return {
        ...state,
        llmConfig: {
          model: event.payload.model,
          ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
        },
        llmProvider: event.payload.provider,
        llmProviderConfigured: true,
      };
    }
    case "events.iterate.com/agent/llm-request-scheduled":
      if (event.payload.purpose === "compaction") {
        // A compaction request occupies the request slot but is not a chat
        // turn: the pending trigger that provoked it stays pending (the chat
        // request fires after the compaction settles) and the autonomous-turn
        // circuit breaker is not charged.
        return {
          ...state,
          currentRequest: {
            phase: "scheduled",
            requestId: event.payload.requestId,
            scheduledOffset: event.offset,
            purpose: "compaction",
          },
        };
      }
      return {
        ...state,
        currentRequest: {
          phase: "scheduled",
          requestId: event.payload.requestId,
          scheduledOffset: event.offset,
        },
        pendingTriggerOffset: null,
        pendingTriggerSource: null,
        autonomousTurnCount:
          state.pendingTriggerSource === "agent-loop" ? state.autonomousTurnCount + 1 : 0,
      };
    case "events.iterate.com/agent/llm-request-requested": {
      if (
        state.currentRequest?.phase !== "scheduled" ||
        state.currentRequest.requestId !== event.payload.requestId
      )
        return state;
      const purpose = state.currentRequest.purpose;
      return {
        ...state,
        currentRequest: {
          phase: "requested",
          llmRequestId: event.offset,
          ...(purpose === undefined ? {} : { purpose }),
        },
        ...(purpose === "compaction" ? {} : { pendingTriggerOffset: null }),
      };
    }
    case "events.iterate.com/agent/llm-request-completed": {
      if (
        state.currentRequest?.phase !== "requested" ||
        state.currentRequest.llmRequestId !== event.payload.llmRequestId
      ) {
        return state;
      }
      const result = event.payload.result;
      // Compaction-request usage measures the summarization prompt, not the
      // conversation, so it must not feed the compaction trigger.
      const totalTokens =
        result.status === "success" && state.currentRequest.purpose !== "compaction"
          ? totalTokensFromUsage(result.usage)
          : null;
      return {
        ...state,
        consecutiveLlmFailures: result.status === "failure" ? state.consecutiveLlmFailures + 1 : 0,
        currentRequest: null,
        requestGeneration: state.requestGeneration + 1,
        ...(totalTokens === null
          ? {}
          : { lastUsage: { llmRequestId: event.payload.llmRequestId, totalTokens } }),
      };
    }
    case "events.iterate.com/agent/llm-request-cancelled": {
      const matchesCurrent =
        (event.payload.phase === "scheduled" &&
          state.currentRequest?.phase === "scheduled" &&
          state.currentRequest.requestId === event.payload.requestId) ||
        (event.payload.phase === "requested" &&
          state.currentRequest?.phase === "requested" &&
          state.currentRequest.llmRequestId === event.payload.llmRequestId);
      if (!matchesCurrent) return state;
      return {
        ...state,
        currentRequest: null,
        requestGeneration: state.requestGeneration + 1,
        // A cancelled compaction is abandoned, not retried: pendingCompaction
        // clears, and lastCompactionAttempt keeps the trigger quiet until the
        // next chat completion reports fresh usage.
        ...(state.currentRequest?.purpose === "compaction" ? { pendingCompaction: null } : {}),
      };
    }
    case "events.iterate.com/agent/compaction-requested":
      if (state.pendingCompaction !== null) return state;
      return {
        ...state,
        pendingCompaction: {
          requestedOffset: event.offset,
          firstKeptOffset: event.payload.firstKeptOffset,
          tokensBefore: event.payload.tokensBefore,
        },
        lastCompactionAttempt: {
          usageLlmRequestId: state.lastUsage === null ? 0 : state.lastUsage.llmRequestId,
        },
      };
    case "events.iterate.com/agent/compaction-completed": {
      if (state.pendingCompaction === null) return state;
      const firstKeptOffset = event.payload.firstKeptOffset;
      return {
        ...state,
        history: [
          // The checkpoint replaces everything below the cut. It carries no
          // offset, so the next compaction's fold drops it (offset 0 is
          // always below any firstKeptOffset) after rolling it into the new
          // checkpoint. Untagged legacy entries are dropped the same way —
          // they are the oldest history by construction.
          {
            role: "user" as const,
            content: renderCompactionSummaryMessage(event.payload.summary),
            summary: true as const,
          },
          ...state.history.filter((message) => (message.offset || 0) >= firstKeptOffset),
        ],
        pendingCompaction: null,
        // The last measurement described the pre-compaction context; the
        // trigger stays quiet until a post-compaction completion reports
        // fresh usage (the thrash guard).
        lastUsage: null,
      };
    }
    case "events.iterate.com/agent/compaction-failed":
      return { ...state, pendingCompaction: null };
    case "events.iterate.com/agent/loop-stopped":
      return {
        ...state,
        pendingTriggerOffset: null,
        pendingTriggerSource: null,
      };
    case "events.iterate.com/capability-host/script-execution-requested":
      return {
        ...state,
        inProgressScriptExecutions: [
          ...state.inProgressScriptExecutions.filter(
            (script) => script.executionId !== event.payload.executionId,
          ),
          {
            code: event.payload.code,
            executionId: event.payload.executionId,
            requestedOffset: event.offset,
            startedAt: event.createdAt,
          },
        ],
      };
    case "events.iterate.com/capability-host/script-execution-completed":
      return {
        ...state,
        inProgressScriptExecutions: state.inProgressScriptExecutions.filter(
          (script) => script.executionId !== event.payload.executionId,
        ),
        scriptExecutionsCompleted: [...state.scriptExecutionsCompleted, event.payload.executionId],
      };
    default:
      return state;
  }
}

function agentInputTriggerSource(
  event: Extract<AgentConsumedEvent, { type: "events.iterate.com/agent/input-added" }>,
): "user" | "agent-loop" | null {
  if (event.payload.llmRequestPolicy.behaviour === "dont-trigger-request") return null;
  // Inputs the loop generates for itself — script results, LLM-failure
  // retries — must count against the autonomous turn limit, not reset it.
  const agentLoopKeyPrefixes = ["agent/render-script-result@", "agent/render-llm-failure@"];
  return agentLoopKeyPrefixes.some((prefix) => event.idempotencyKey?.startsWith(prefix))
    ? "agent-loop"
    : "user";
}

function cancelEventForCurrentRequest(request: NonNullable<AgentState["currentRequest"]>) {
  if (request.phase === "scheduled") {
    return {
      type: "events.iterate.com/agent/llm-request-cancelled" as const,
      idempotencyKey: `agent/llm-request-cancelled@scheduled:${request.scheduledOffset}`,
      payload: {
        phase: "scheduled" as const,
        reason: "interrupted-by-user-input" as const,
        requestId: request.requestId,
      },
    };
  }

  return {
    type: "events.iterate.com/agent/llm-request-cancelled" as const,
    idempotencyKey: `agent/llm-request-cancelled@requested:${request.llmRequestId}`,
    payload: {
      phase: "requested" as const,
      reason: "interrupted-by-user-input" as const,
      llmRequestId: request.llmRequestId,
    },
  };
}

const AGENT_SCRIPT_EXECUTION_ID_PREFIX = "agent-output:";

/**
 * Failed-request error inputs stop auto-retrying once this many failures land
 * in a row (counter resets on any success). Two automatic retries, then wait
 * for the user.
 */
const MAX_CONSECUTIVE_LLM_FAILURES = 3;

// The "tool result" half of the codemode loop: a finished script execution
// renders back into model-visible history so the next turn can look at the
// data. Two deliberate gaps end the loop instead of feeding it:
// - executions this agent did not request stay invisible (other scripts —
//   e.g. Slack bang commands — journal on the same stream);
// - a script that returned undefined and did not throw produces nothing.
//   Returning no value is how an agent ends its turn.
async function scriptResultAgentInput(
  event: Extract<
    AgentConsumedEvent,
    { type: "events.iterate.com/capability-host/script-execution-completed" }
  >,
  writeWorkspaceFile: AgentProcessorDeps["writeWorkspaceFile"],
): Promise<string | null> {
  const payload = event.payload;
  if (!payload.executionId.startsWith(AGENT_SCRIPT_EXECUTION_ID_PREFIX)) return null;
  if (payload.error !== undefined) {
    return `Your script threw:\n\`\`\`\n${truncateScriptResult(payload.error)}\n\`\`\``;
  }
  if (payload.result === undefined) return null;
  const text = stringifyScriptResult(payload.result);
  if (text.length > SCRIPT_RESULT_HISTORY_LIMIT && writeWorkspaceFile !== undefined) {
    try {
      const spilledPath = await spillScriptResult({
        executionId: payload.executionId,
        text,
        writeWorkspaceFile,
      });
      return [
        "Your script returned:",
        "```json",
        text.slice(0, SCRIPT_RESULT_HISTORY_LIMIT),
        "```",
        spillNotice({ path: spilledPath, totalChars: text.length }),
      ].join("\n");
    } catch (error) {
      // Spilling is best effort: a workspace that cannot clone or write must
      // not lose the result entirely — fall through to inline truncation.
      console.error("[agent] failed to spill oversized script result to workspace", {
        error,
        executionId: payload.executionId,
      });
    }
  }
  return `Your script returned:\n\`\`\`json\n${truncateScriptResult(text)}\n\`\`\``;
}

function stringifyScriptResult(result: unknown): string {
  try {
    return JSON.stringify(result, null, 2) ?? String(result);
  } catch {
    return String(result);
  }
}

const SCRIPT_RESULT_HISTORY_LIMIT = 30_000;

function truncateScriptResult(text: string): string {
  if (text.length <= SCRIPT_RESULT_HISTORY_LIMIT) return text;
  return `${text.slice(0, SCRIPT_RESULT_HISTORY_LIMIT)}\n… truncated (${text.length} chars total — return less: slice arrays, pick fields)`;
}

/**
 * Where oversized script results land inside the agent's workspace checkout:
 * scratch files for the model to page through with itx.workspace, never meant
 * to be committed. One file per execution, so replays overwrite idempotently.
 * Size is no concern — workspace files past the inline threshold are stored
 * in R2 transparently.
 */
const SCRIPT_RESULT_SPILL_DIR = "/script-results";

/** Writes the full result text into the agent's workspace; returns its path. */
async function spillScriptResult(input: {
  executionId: string;
  text: string;
  writeWorkspaceFile: NonNullable<AgentProcessorDeps["writeWorkspaceFile"]>;
}): Promise<string> {
  // The agent's documented publish flow is `git.add({ filepath: "." })` —
  // without this nested ignore every spill would ride along into workspace
  // commits (isomorphic-git's add respects .gitignore).
  await input.writeWorkspaceFile({ content: "*\n", path: `${SCRIPT_RESULT_SPILL_DIR}/.gitignore` });
  const path = `${SCRIPT_RESULT_SPILL_DIR}/${input.executionId.replace(/[^A-Za-z0-9._-]+/g, "-")}.json`;
  await input.writeWorkspaceFile({ content: input.text, path });
  return path;
}

/**
 * The model-facing text after a truncated preview: where the full result
 * lives and a concrete next-script recipe for paging it, so the model reads
 * the file with plain JavaScript instead of re-running the expensive fetch.
 */
function spillNotice(input: { path: string; totalChars: number }): string {
  return [
    `…truncated: showing the first ${SCRIPT_RESULT_HISTORY_LIMIT.toLocaleString("en-US")} of ${input.totalChars.toLocaleString("en-US")} chars. The full result is saved in your workspace at ${JSON.stringify(input.path)} — don't re-fetch; read and filter it with plain JavaScript in your next script, e.g.:`,
    "```js",
    "async (itx) => {",
    `  const data = JSON.parse(await itx.workspace.readFile(${JSON.stringify(input.path)}));`,
    "  return Object.keys(data); // then slice/filter/regex to return only what you need",
    "}",
    "```",
  ].join("\n");
}

function extractAsyncJsSnippet(content: string): string | null {
  const fenced = content.match(/```(?:js|javascript|ts|typescript)?\s*([\s\S]*?)```/i);
  const code = (fenced?.[1] ?? content).trim();
  return /^async\s*(?:function|\()/.test(code) || /^\(?async\s*\(/.test(code) ? code : null;
}
