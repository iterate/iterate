import { z } from "zod";
import type { StreamEvent } from "../streams/schemas.ts";
import { StreamProcessor } from "../streams/stream-processor.ts";
import { subagentParentPath } from "../../lib/subagent-paths.ts";
import { DEFAULT_SCRIPT_EXECUTION_EXPIRY_MS } from "../capability-host/capability-host-processor-contract.ts";
import {
  AGENT_LLM_REQUEST_BACKSTOP_MS,
  AgentProcessorContract,
  DEFAULT_AGENT_LLM_REQUEST_DEBOUNCE_MS,
  DEFAULT_AGENT_LLM_REQUEST_EXPIRY_MS,
  DEFAULT_AGENT_MAX_AUTONOMOUS_TURNS,
  type AgentFileAttachment,
} from "./agent-processor-contract.ts";

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
  /** Injected clock (expiry stamps + backstop deadline); defaults to Date.now. */
  now?: () => number;
};

export class AgentProcessor extends StreamProcessor<AgentProcessorContract, AgentProcessorDeps> {
  readonly contract = AgentProcessorContract;
  readonly #scheduledRequestsWithActiveTimers = new Set<string>();

  #now(): number {
    return (this.deps.now ?? Date.now)();
  }

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
            idempotencyKey: this.idempotencyKey("system-prompt-updated", event),
            payload: { systemPrompt },
          }),
        );
        return;
      }
      case "events.iterate.com/agents/message-received": {
        // The reducer folds the message straight into history (no input-added
        // reflection hop); the only per-event side effect is honoring an
        // interrupt policy, exactly like input-added below.
        if (event.payload.llmRequestPolicy.behaviour !== "interrupt-current-request") return;
        const interruptedRequest = previousState.currentRequest;
        if (interruptedRequest === null) return;
        blockProcessorWhile(() => append(this.#cancelEventForCurrentRequest(interruptedRequest)));
        return;
      }
      case "events.iterate.com/agents/web-message-sent": {
        // Files the agent attached to its own message ride the reflection too,
        // so the model SEES what it sent (vision) on later turns.
        const files = event.payload.files;
        blockProcessorWhile(() =>
          append({
            type: "events.iterate.com/agent/input-added",
            idempotencyKey: this.idempotencyKey("render-web-response", event),
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
        blockProcessorWhile(() => append(this.#cancelEventForCurrentRequest(interrupted)));
        return;
      }
      case "events.iterate.com/agent/llm-request-scheduled":
        // The debounce timer is a droppable ATTEMPT: the scheduled event is
        // the durable evidence, and #settleLlmRequestScheduling re-derives a
        // lost timer from the fold. Losing this closure costs latency, never
        // the request.
        this.#scheduledRequestsWithActiveTimers.add(event.payload.requestId);
        runInBackground(async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, event.payload.debounceMs));
          try {
            await append(
              this.#buildLlmRequestRequested({
                model: event.payload.model,
                provider: event.payload.provider,
                requestId: event.payload.requestId,
                scheduledOffset: event.offset,
              }),
            );
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
            idempotencyKey: this.idempotencyKey("script-execution-requested", event),
            payload: {
              code,
              executionId: `${AGENT_SCRIPT_EXECUTION_ID_PREFIX}${event.offset}`,
              expiresAt: this.#now() + DEFAULT_SCRIPT_EXECUTION_EXPIRY_MS,
            },
          });
        });
        return;
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
            idempotencyKey: this.idempotencyKey("render-script-result", event),
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
        const retry = state.consecutiveLlmFailures < MAX_CONSECUTIVE_LLM_FAILURES;
        blockProcessorWhile(() =>
          append({
            type: "events.iterate.com/agent/input-added",
            idempotencyKey: this.idempotencyKey("render-llm-failure", event),
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
    // At-head gate (see OpenAiWsProcessor.processEventBatch): scheduling
    // decisions and the backstop must never fire from a mid-catch-up fold —
    // a long-settled request transiently looks `requested` mid-refold, and
    // backstopping it would journal a false failure.
    if (args.checkpointOffset < args.streamMaxOffset) return;
    const { state } = args;
    if (state.currentRequest === null) {
      if (state.pendingTriggerOffset === null) return;
      if (
        state.pendingTriggerSource === "agent-loop" &&
        state.autonomousTurnCount >= DEFAULT_AGENT_MAX_AUTONOMOUS_TURNS
      ) {
        await args.append({
          type: "events.iterate.com/agent/loop-stopped",
          idempotencyKey: this.idempotencyKey(
            `autonomous-turn-limit:${state.pendingTriggerOffset}`,
          ),
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
        idempotencyKey: this.idempotencyKey(
          `llm-request-scheduled@generation:${state.requestGeneration}`,
        ),
        payload: {
          debounceMs: DEFAULT_AGENT_LLM_REQUEST_DEBOUNCE_MS,
          model: state.llmConfig.model,
          provider: state.llmProvider,
          requestId: `llm-request:gen-${state.requestGeneration}`,
        },
      });
      return;
    }
    if (state.currentRequest.phase === "requested") {
      // The BACKSTOP: providers settle their own undriven requests, so a
      // `requested` this old means the provider layer never answered at all.
      // Settling it un-wedges the queue — the failure input (rendered by
      // processEvent above on the next batch) tells the model what happened.
      const requestedAt = state.currentRequest.requestedAt;
      if (requestedAt === undefined) return;
      if (this.#now() - requestedAt < AGENT_LLM_REQUEST_BACKSTOP_MS) return;
      const llmRequestId = state.currentRequest.llmRequestId;
      await args.append({
        type: "events.iterate.com/agent/llm-request-completed",
        idempotencyKey: `agent/backstop-completed@${llmRequestId}`,
        payload: {
          durationMs: this.#now() - requestedAt,
          llmRequestId,
          provider: state.currentRequest.provider ?? state.llmProvider,
          result: {
            status: "failure",
            error: {
              message: `No LLM provider settled this request within ${AGENT_LLM_REQUEST_BACKSTOP_MS / 60_000} minutes; failed by the agent's backstop reconciler.`,
            },
          },
        },
      });
      return;
    }
    if (this.#scheduledRequestsWithActiveTimers.has(state.currentRequest.requestId)) return;
    // No active timer for this scheduled request: the DO restarted and lost the
    // debounce. Fire llm-request-requested immediately. The idempotency key
    // makes this safe if the timer also fires concurrently.
    await args.append(
      this.#buildLlmRequestRequested({
        model: state.llmConfig.model,
        provider: state.llmProvider,
        requestId: state.currentRequest.requestId,
        scheduledOffset: state.currentRequest.scheduledOffset,
      }),
    );
  }

  /** The one construction of llm-request-requested — the debounce timer and
   * the restart-recovery lane both fire the request for one
   * llm-request-scheduled event, and the SHARED key (per scheduled offset) is
   * what collapses that race to a single append; building the whole event in
   * one place also keeps the expiry stamp and key from drifting apart. */
  #buildLlmRequestRequested(input: {
    model: string;
    provider: AgentState["llmProvider"];
    requestId: string;
    scheduledOffset: number;
  }) {
    return {
      type: "events.iterate.com/agent/llm-request-requested" as const,
      idempotencyKey: this.idempotencyKey(`llm-request-requested@${input.scheduledOffset}`),
      payload: {
        model: input.model,
        provider: input.provider,
        requestId: input.requestId,
        expiresAt: this.#now() + DEFAULT_AGENT_LLM_REQUEST_EXPIRY_MS,
      },
    };
  }

  #cancelEventForCurrentRequest(request: NonNullable<AgentState["currentRequest"]>) {
    if (request.phase === "scheduled") {
      return {
        type: "events.iterate.com/agent/llm-request-cancelled" as const,
        idempotencyKey: this.idempotencyKey(
          `llm-request-cancelled@scheduled:${request.scheduledOffset}`,
        ),
        payload: {
          phase: "scheduled" as const,
          reason: "interrupted-by-user-input" as const,
          requestId: request.requestId,
        },
      };
    }

    return {
      type: "events.iterate.com/agent/llm-request-cancelled" as const,
      idempotencyKey: this.idempotencyKey(
        `llm-request-cancelled@requested:${request.llmRequestId}`,
      ),
      payload: {
        phase: "requested" as const,
        reason: "interrupted-by-user-input" as const,
        llmRequestId: request.llmRequestId,
      },
    };
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
    case "events.iterate.com/agents/message-received": {
      // Inbound messages fold straight into history. The trigger source keys
      // on WHO sent it: humans (web, MCP, Slack, email, GitHub) refill the
      // autonomous turn budget; another AGENT's mail counts against it — the
      // same breaker that stops script self-loops bounds parent↔subagent
      // reply ping-pong, because neither side's messages reset the other.
      const from = event.payload.from;
      const files = event.payload.files;
      const triggerSource =
        event.payload.llmRequestPolicy.behaviour === "dont-trigger-request"
          ? null
          : from.kind === "agent"
            ? ("agent-loop" as const)
            : ("user" as const);
      const content =
        from.kind === "agent"
          ? `Message from agent ${from.path}:\n${event.payload.content}`
          : event.payload.content;
      return {
        ...state,
        history: [
          ...state.history,
          {
            role: "user",
            content,
            ...(files === undefined || files.length === 0 ? {} : { files }),
          },
        ],
        pendingTriggerOffset: triggerSource === null ? state.pendingTriggerOffset : event.offset,
        pendingTriggerSource: triggerSource === null ? state.pendingTriggerSource : triggerSource,
        autonomousTurnCount: triggerSource === "user" ? 0 : state.autonomousTurnCount,
      };
    }
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
        currentRequest: {
          phase: "requested",
          llmRequestId: event.offset,
          requestedAt: Date.parse(event.createdAt),
          provider: event.payload.provider,
        },
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
    case "events.iterate.com/stream/child-stream-created": {
      // Every descendant stream announces its FULL path to every ancestor;
      // this agent's subagents are the announcements whose parent-agent path
      // is exactly this stream (event.path), so grandchildren stay out.
      const childPath = event.payload.childPath;
      if (subagentParentPath(childPath) !== event.path) return state;
      if (state.subagents.some((subagent) => subagent.path === childPath)) return state;
      return {
        ...state,
        subagents: [...state.subagents, { path: childPath, spawnedAt: event.createdAt }],
      };
    }
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
  // Workspace publishes commit every non-ignored local file — without this
  // nested ignore every spill would ride along into workspace snapshot
  // commits (the overlay publish honors .gitignore).
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
  // Fences count only at line starts: scripts legitimately carry ``` inside
  // string literals (chat messages formatted as markdown), and in valid JS
  // those always sit mid-line — a raw newline cannot appear in a string
  // literal, and an unescaped ``` would terminate a template literal. A fence
  // match anywhere used to cut the script at the first embedded ``` and
  // execute an unparseable prefix (unclosed string literal).
  const fenced = content.match(
    /^[ \t]*```(?:js|javascript|ts|typescript)?[ \t]*\n([\s\S]*?)\n[ \t]*```[ \t]*$/im,
  );
  const code = (fenced?.[1] ?? content).trim();
  return /^async\s*(?:function|\()/.test(code) || /^\(?async\s*\(/.test(code) ? code : null;
}
