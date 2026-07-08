import { z } from "zod";
import type { StreamEvent } from "../../types.ts";
import { StreamProcessor } from "../streams/stream-processor.ts";
import {
  AgentProcessorContract,
  DEFAULT_AGENT_LLM_REQUEST_DEBOUNCE_MS,
  DEFAULT_AGENT_MAX_AUTONOMOUS_TURNS,
  type AgentFileAttachment,
} from "./agent-processor-contract.ts";

type AgentState = z.infer<typeof AgentProcessorContract.stateSchema>;
type AgentConsumedEvent = ReturnType<typeof AgentProcessorContract.parseEvent>;

export class AgentProcessor extends StreamProcessor<typeof AgentProcessorContract> {
  readonly contract = AgentProcessorContract;
  readonly #scheduledRequestsWithActiveTimers = new Set<string>();

  protected override reduce({
    event,
    state,
  }: Parameters<StreamProcessor<typeof AgentProcessorContract>["reduce"]>[0]) {
    return reduceAgentEvent({ event, state });
  }

  protected override processEvent({
    append,
    blockProcessorWhile,
    event,
    previousState,
    runInBackground,
    state,
  }: Parameters<StreamProcessor<typeof AgentProcessorContract>["processEvent"]>[0]): undefined {
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
              },
            });
          } finally {
            this.#scheduledRequestsWithActiveTimers.delete(event.payload.requestId);
          }
        });
        return;
      case "events.iterate.com/agent/output-added":
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
      case "events.iterate.com/capability-host/script-execution-completed": {
        const content = scriptResultAgentInput(event);
        if (content === null) return;
        blockProcessorWhile(() =>
          append({
            type: "events.iterate.com/agent/input-added",
            idempotencyKey: `agent/render-script-result@${event.offset}`,
            payload: {
              content,
              llmRequestPolicy: { behaviour: "after-current-request" },
            },
          }),
        );
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
      // The agent's own sandbox came (back) up. Record a model-visible FYI —
      // never a trigger — so that next time the agent acts it knows the state
      // of its `itx.sandbox`, and is reminded how it works. `dont-trigger-request`
      // means this sits in context for later, it does not start an LLM turn.
      case "events.iterate.com/sandbox/workspace-restored":
        blockProcessorWhile(() =>
          append({
            type: "events.iterate.com/agent/input-added",
            idempotencyKey: `agent/sandbox-restored@${event.offset}`,
            payload: {
              content:
                "FYI (no reply needed): your sandbox (`itx.sandbox`) resumed and `/workspace` was RESTORED from a snapshot — files you kept there are back. But gitignored paths were NOT snapshotted (e.g. `node_modules`, build outputs): reinstall/rebuild them before use if a task needs them. The container filesystem otherwise resets between sleeps, so treat anything outside `/workspace` as gone. (The repo at `/workspace/repos/project` is always checked out; if the snapshot lacked it, a separate FYI notes it was freshly cloned.)",
              llmRequestPolicy: { behaviour: "dont-trigger-request" },
            },
          }),
        );
        return;
      case "events.iterate.com/sandbox/workspace-cloned":
        blockProcessorWhile(() =>
          append({
            type: "events.iterate.com/agent/input-added",
            idempotencyKey: `agent/sandbox-cloned@${event.offset}`,
            payload: {
              content:
                "FYI (no reply needed): the project repo was freshly cloned in your sandbox (`itx.sandbox`) at `/workspace/repos/project` (your cwd) — no usable snapshot of the checkout existed, so uncommitted repo work from a previous container, if any, is gone. Baked tools (e.g. `codex`) are preinstalled; anything else a task needs must be installed. Work you want to keep across sleeps lives under `/workspace`; commit durable changes to the repo.",
              llmRequestPolicy: { behaviour: "dont-trigger-request" },
            },
          }),
        );
        return;
      case "events.iterate.com/sandbox/warmed-up":
        blockProcessorWhile(() =>
          append({
            type: "events.iterate.com/agent/input-added",
            idempotencyKey: `agent/sandbox-warmed-up@${event.offset}`,
            payload: {
              content:
                "FYI (no reply needed): your sandbox finished warming up — baked coding tools with a configured provider key (e.g. `codex` via the project's OpenAI secret) are logged in, no per-command login needed. If `codex` still reports an auth error, the project likely has no OpenAI key seeded — ask the user to add one rather than retrying.",
              llmRequestPolicy: { behaviour: "dont-trigger-request" },
            },
          }),
        );
        return;
      default:
        return;
    }
  }

  protected override async processEventBatch(
    args: Parameters<StreamProcessor<typeof AgentProcessorContract>["processEventBatch"]>[0],
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
    args: Parameters<StreamProcessor<typeof AgentProcessorContract>["processEventBatch"]>[0],
  ): Promise<void> {
    const { state } = args;
    if (state.currentRequest === null) {
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
    messages: [{ role: "system" as const, content: state.systemPrompt }, ...state.history],
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

export function buildAgentLlmRequestBody(input: {
  events: readonly StreamEvent[];
  llmRequestId: number;
}) {
  return buildLlmChatRequest(
    reduceAgentEvents(input.events.filter((event) => event.offset <= input.llmRequestId)),
  );
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
            ...(files === undefined || files.length === 0 ? {} : { files }),
          },
        ],
        pendingTriggerOffset: triggerSource === null ? state.pendingTriggerOffset : event.offset,
        pendingTriggerSource: triggerSource === null ? state.pendingTriggerSource : triggerSource,
        autonomousTurnCount: triggerSource === "user" ? 0 : state.autonomousTurnCount,
      };
    }
    case "events.iterate.com/agent/output-added":
      return {
        ...state,
        history: [...state.history, { role: "assistant", content: event.payload.content }],
      };
    case "events.iterate.com/agent/llm-provider-selected":
      if (event.payload.ifUnset && state.llmProviderConfigured) return state;
      return {
        ...state,
        llmConfig: { model: event.payload.model },
        llmProvider: event.payload.provider,
        llmProviderConfigured: true,
      };
    case "events.iterate.com/agent/llm-request-scheduled":
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
    case "events.iterate.com/agent/llm-request-requested":
      if (
        state.currentRequest?.phase !== "scheduled" ||
        state.currentRequest.requestId !== event.payload.requestId
      )
        return state;
      return {
        ...state,
        currentRequest: { phase: "requested", llmRequestId: event.offset },
        pendingTriggerOffset: null,
      };
    case "events.iterate.com/agent/llm-request-completed":
      if (
        state.currentRequest?.phase !== "requested" ||
        state.currentRequest.llmRequestId !== event.payload.llmRequestId
      ) {
        return state;
      }
      return {
        ...state,
        consecutiveLlmFailures:
          event.payload.result.status === "failure" ? state.consecutiveLlmFailures + 1 : 0,
        currentRequest: null,
        requestGeneration: state.requestGeneration + 1,
      };
    case "events.iterate.com/agent/llm-request-cancelled":
      if (
        event.payload.phase === "scheduled" &&
        state.currentRequest?.phase === "scheduled" &&
        state.currentRequest.requestId === event.payload.requestId
      ) {
        return { ...state, currentRequest: null, requestGeneration: state.requestGeneration + 1 };
      }
      if (
        event.payload.phase === "requested" &&
        state.currentRequest?.phase === "requested" &&
        state.currentRequest.llmRequestId === event.payload.llmRequestId
      ) {
        return { ...state, currentRequest: null, requestGeneration: state.requestGeneration + 1 };
      }
      return state;
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
function scriptResultAgentInput(
  event: Extract<
    AgentConsumedEvent,
    { type: "events.iterate.com/capability-host/script-execution-completed" }
  >,
): string | null {
  const payload = event.payload;
  if (!payload.executionId.startsWith(AGENT_SCRIPT_EXECUTION_ID_PREFIX)) return null;
  if (payload.error !== undefined) {
    return `Your script threw:\n\`\`\`\n${truncateScriptResult(payload.error)}\n\`\`\``;
  }
  if (payload.result === undefined) return null;
  return `Your script returned:\n\`\`\`json\n${truncateScriptResult(stringifyScriptResult(payload.result))}\n\`\`\``;
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

function extractAsyncJsSnippet(content: string): string | null {
  const fenced = content.match(/```(?:js|javascript|ts|typescript)?\s*([\s\S]*?)```/i);
  const code = (fenced?.[1] ?? content).trim();
  return /^async\s*(?:function|\()/.test(code) || /^\(?async\s*\(/.test(code) ? code : null;
}
