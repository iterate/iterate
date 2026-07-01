import { z } from "zod";
import type { StreamEvent } from "../../types.ts";
import { StreamProcessor } from "../streams/stream-processor.ts";
import {
  AgentProcessorContract,
  DEFAULT_AGENT_LLM_REQUEST_DEBOUNCE_MS,
} from "./agent-processor-contract.ts";

type AgentState = z.infer<typeof AgentProcessorContract.stateSchema>;
type AgentConsumedEvent = ReturnType<typeof AgentProcessorContract.parseEvent>;
type LlmRequestPolicy = Extract<
  AgentConsumedEvent,
  { type: "events.iterate.com/agent/input-added" }
>["payload"]["llmRequestPolicy"];

export class AgentProcessor extends StreamProcessor<typeof AgentProcessorContract> {
  readonly contract = AgentProcessorContract;

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
      case "events.iterate.com/agents/web-message-sent":
        blockProcessorWhile(() =>
          append({
            type: "events.iterate.com/agent/input-added",
            idempotencyKey: `agent/render-web-response@${event.offset}`,
            payload: {
              content: `The assistant sent this visible web-chat message: ${event.payload.message}`,
              llmRequestPolicy: { behaviour: "dont-trigger-request" },
            },
          }),
        );
        return;
      case "events.iterate.com/agent/input-added":
        blockProcessorWhile(async () => {
          await this.#handleInputAdded({
            append,
            event,
            policy: event.payload.llmRequestPolicy,
            previousState,
            state,
          });
        });
        return;
      case "events.iterate.com/agent/llm-request-scheduled":
        runInBackground(async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, event.payload.debounceMs));
          await append({
            type: "events.iterate.com/agent/llm-request-requested",
            idempotencyKey: `agent/llm-request-requested@${event.offset}`,
            payload: {
              model: event.payload.model,
              provider: event.payload.provider,
              requestId: event.payload.requestId,
            },
          });
        });
        return;
      case "events.iterate.com/agent/output-added":
        blockProcessorWhile(async () => {
          const code = extractAsyncJsSnippet(event.payload.content);
          if (code === null) return;
          await append({
            type: "events.iterate.com/itx/script-execution-requested",
            idempotencyKey: `itx/script-execution-requested@${event.offset}`,
            payload: {
              code,
              executionId: `agent-output:${event.offset}`,
            },
          });
        });
        return;
      case "events.iterate.com/agent/llm-request-completed":
      case "events.iterate.com/agent/llm-request-cancelled":
        if (state.currentRequest !== null || state.pendingTriggerOffset === null) return;
        blockProcessorWhile(() =>
          this.#appendLlmRequestScheduled({
            append,
            sourceOffset: state.pendingTriggerOffset!,
            state,
          }),
        );
        return;
      default:
        return;
    }
  }

  async #handleInputAdded(input: {
    append: Parameters<StreamProcessor<typeof AgentProcessorContract>["processEvent"]>[0]["append"];
    event: Extract<AgentConsumedEvent, { type: "events.iterate.com/agent/input-added" }>;
    policy: LlmRequestPolicy;
    previousState: AgentState;
    state: AgentState;
  }) {
    if (input.policy.behaviour === "dont-trigger-request") return;

    if (
      input.policy.behaviour === "interrupt-current-request" &&
      input.previousState.currentRequest !== null
    ) {
      await input.append(cancelEventForCurrentRequest(input.previousState.currentRequest));
      await this.#appendLlmRequestScheduled({
        append: input.append,
        sourceOffset: input.event.offset,
        state: input.state,
      });
      return;
    }

    if (input.previousState.currentRequest !== null) return;
    await this.#appendLlmRequestScheduled({
      append: input.append,
      sourceOffset: input.event.offset,
      state: input.state,
    });
  }

  async #appendLlmRequestScheduled(input: {
    append: Parameters<StreamProcessor<typeof AgentProcessorContract>["processEvent"]>[0]["append"];
    sourceOffset: number;
    state: AgentState;
  }) {
    const requestId = `llm-request:${input.sourceOffset}`;
    await input.append({
      type: "events.iterate.com/agent/llm-request-scheduled",
      idempotencyKey: `agent/llm-request-scheduled@${input.sourceOffset}`,
      payload: {
        debounceMs: DEFAULT_AGENT_LLM_REQUEST_DEBOUNCE_MS,
        model: input.state.llmConfig.model,
        provider: input.state.llmProvider,
        requestId,
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

function buildLlmChatRequest(state: AgentState) {
  return {
    messages: [{ role: "system" as const, content: state.systemPrompt }, ...state.history],
  };
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
      const shouldTrigger = event.payload.llmRequestPolicy.behaviour !== "dont-trigger-request";
      return {
        ...state,
        history: [...state.history, { role: "user", content: event.payload.content }],
        pendingTriggerOffset: shouldTrigger ? event.offset : state.pendingTriggerOffset,
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
      return { ...state, currentRequest: null };
    case "events.iterate.com/agent/llm-request-cancelled":
      if (
        event.payload.phase === "scheduled" &&
        state.currentRequest?.phase === "scheduled" &&
        state.currentRequest.requestId === event.payload.requestId
      ) {
        return { ...state, currentRequest: null };
      }
      if (
        event.payload.phase === "requested" &&
        state.currentRequest?.phase === "requested" &&
        state.currentRequest.llmRequestId === event.payload.llmRequestId
      ) {
        return { ...state, currentRequest: null };
      }
      return state;
    case "events.iterate.com/itx/script-execution-completed":
      return {
        ...state,
        scriptExecutionsCompleted: [...state.scriptExecutionsCompleted, event.payload.executionId],
      };
    default:
      return state;
  }
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

function extractAsyncJsSnippet(content: string): string | null {
  const fenced = content.match(/```(?:js|javascript|ts|typescript)?\s*([\s\S]*?)```/i);
  const code = (fenced?.[1] ?? content).trim();
  return /^async\s*(?:function|\()/.test(code) || /^\(?async\s*\(/.test(code) ? code : null;
}
