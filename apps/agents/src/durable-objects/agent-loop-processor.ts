import type { GenericEventInput } from "@iterate-com/events-contract";
import { match } from "schematch";
import { z } from "zod";
import {
  AgentInputAddedEvent,
  AgentInputAddedEventInput,
  AgentStatusUpdatedEventInput,
  type AgentInputAddedPayload,
  AiChatRequest,
  type LlmCancellationReason,
  LlmConfigUpdatedEvent,
  LlmRequestCancelledEvent,
  LlmRequestCancelledEventInput,
  LlmRequestCompletedEvent,
  LlmRequestFailedEvent,
  LlmRequestQueuedEvent,
  LlmRequestQueuedEventInput,
  LlmRequestScheduledEvent,
  LlmRequestScheduledEventInput,
  LlmRequestStartedEvent,
  SystemPromptUpdatedEvent,
  type TriggerLlm,
  WebchatMessageReceivedEvent,
  WebchatResponseAddedEvent,
} from "./agent-loop-processor-types.ts";
import type { AfterAppendArgs, Append, ProcessorRuntime } from "./agent-processor-shared.ts";
import type { IterateAgentProcessorState } from "./agent-processor-types.ts";

/**
 * Agent-loop processor.
 *
 * The LLM never consumes raw stream events directly. It consumes
 * `state.history`, and `state.history` is made only from `agent-input-added`
 * rows. Raw ingress events such as `webchat-message-received`, plus selected
 * LLM lifecycle events, are first rendered into `agent-input-added` rows in
 * the rendering phase of `agentLoopAfterAppend` below.
 *
 * `agentLoopAfterAppend` is deliberately split into two match blocks:
 *
 * 1. **Rendering:** "Should this stream event become model-visible context?"
 *    This phase appends `agent-input-added` rows and never schedules work.
 * 2. **Control:** "Should this stream event affect the LLM request FSM?"
 *    This phase calls `ProcessorRuntime` and appends lifecycle events; it does
 *    not invent prose outside the event renderer.
 *
 * Both phases require an event `offset` when the model needs to reason about
 * the stream event. Events without offsets are treated as not-yet-log-backed
 * inputs and are ignored by side effects rather than producing untraceable
 * model context.
 */

/**
 * `TriggerLlm` after `auto` has been resolved against the message role.
 * `handleUserInput` works with this narrower type so the dispatch is
 * exhaustive without a defensive `auto` branch.
 */
type ConcreteTriggerLlm = Exclude<TriggerLlm, { behaviour: "auto" }>;

function resolveTrigger(payload: AgentInputAddedPayload): ConcreteTriggerLlm {
  if (payload.triggerLlmRequest.behaviour !== "auto") return payload.triggerLlmRequest;
  return payload.role === "assistant"
    ? { behaviour: "dont-trigger-request" }
    : { behaviour: "interrupt-current-request" };
}

/**
 * Build the Workers AI chat body from curated model context.
 *
 * The input is the reduced processor state at request start. Its `history`
 * contains only `agent-input-added` rows: direct assistant turns, rendered
 * webchat ingress, rendered lifecycle events, codemode explainers, etc. Do not
 * read raw stream events here; if an event should influence the model, render
 * it into `agent-input-added` in `agentLoopAfterAppend` first so the stream
 * shows both the original event and the exact model-visible text.
 */
export function buildLlmChatRequest(state: IterateAgentProcessorState): AiChatRequest {
  return AiChatRequest.parse({
    messages: [
      { role: "system", content: state.systemPrompt },
      ...state.history.map((m) => ({ role: m.role, content: m.content })),
    ],
  });
}

const OpenAiChatCompletionResponse = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1),
});

const AnthropicAssistantMessage = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })).min(1),
});

const WorkersAiChatResponse = z.object({
  response: z.string(),
});

export function extractLlmAssistantText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  return match(raw)
    .case(OpenAiChatCompletionResponse, (r) => r.choices[0].message.content)
    .case(AnthropicAssistantMessage, (r) =>
      r.content
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join(""),
    )
    .case(WorkersAiChatResponse, (r) => r.response)
    .default(match.throw);
}

async function emitScheduledAndKickoff(args: {
  runtime: ProcessorRuntime;
  append: Append;
  state: IterateAgentProcessorState;
}): Promise<void> {
  const debounceMs = args.state.llmConfig.debounceMs;
  const { requestId } = args.runtime.scheduleLlmRequest({ debounceMs });
  await args.append({
    event: LlmRequestScheduledEventInput.parse({
      type: "llm-request-scheduled",
      payload: { requestId, debounceMs, model: args.state.llmConfig.model },
    }),
  });
}

async function emitCancelled(args: {
  runtime: ProcessorRuntime;
  append: Append;
  requestId: string;
  reason: LlmCancellationReason;
}): Promise<void> {
  args.runtime.cancelLlmRequest({ requestId: args.requestId });
  await args.append({
    event: LlmRequestCancelledEventInput.parse({
      type: "llm-request-cancelled",
      payload: { requestId: args.requestId, reason: args.reason },
    }),
  });
}

async function appendRewrite(args: { append: Append; content: string }): Promise<void> {
  await args.append({
    event: AgentInputAddedEventInput.parse({
      type: "agent-input-added",
      payload: {
        role: "user",
        content: args.content,
        triggerLlmRequest: { behaviour: "dont-trigger-request" },
      },
    }),
  });
}

async function appendEventTypeExplanation(args: {
  append: Append;
  eventType: string;
}): Promise<void> {
  const explanation = eventTypeExplanation(args.eventType);
  if (explanation == null) return;
  await args.append({
    event: AgentInputAddedEventInput.parse({
      type: "agent-input-added",
      idempotencyKey: `iterate-agent:event-type-explainer:${args.eventType}`,
      payload: {
        role: "user",
        content: explanation,
        triggerLlmRequest: { behaviour: "dont-trigger-request" },
      },
    }),
  });
}

function eventTypeExplanation(eventType: string): string | null {
  if (eventType === "webchat-message-received") {
    return eventTypeExplanationBlock({
      type: eventType,
      meaning: "This represents a message received from the webchat user.",
    });
  }
  if (eventType === "webchat-response-added") {
    return eventTypeExplanationBlock({
      type: eventType,
      meaning:
        "This represents a message you sent by writing a codemode block that calls `webchat.sendMessage({ message })`.",
    });
  }
  if (eventType === "llm-request-started") {
    return eventTypeExplanationBlock({
      type: eventType,
      meaning:
        "An LLM request began. The requestId links later completion, cancellation, or failure events.",
    });
  }
  if (eventType === "llm-request-queued") {
    return eventTypeExplanationBlock({
      type: eventType,
      meaning:
        "A trigger arrived while an LLM request was running. It should be handled after the current request ends.",
    });
  }
  if (eventType === "llm-request-cancelled") {
    return eventTypeExplanationBlock({
      type: eventType,
      meaning: "The current LLM request was interrupted or timed out before it completed.",
    });
  }
  if (eventType === "llm-request-failed") {
    return eventTypeExplanationBlock({
      type: eventType,
      meaning: "The current LLM request failed before producing a usable codemode response.",
    });
  }
  if (eventType === "llm-request-completed") {
    return eventTypeExplanationBlock({
      type: eventType,
      meaning: "The current LLM request produced a usable codemode response.",
    });
  }
  return null;
}

function eventTypeExplanationBlock(args: { type: string; meaning: string }): string {
  return `First \`${args.type}\` event. ${args.meaning}`;
}

function eventBlock(args: {
  offset: number;
  type: string;
  fields?: Record<string, string | number>;
  bodyTag?: string;
  body?: string;
}): string {
  const yamlLines = [
    "event:",
    `  offset: ${args.offset}`,
    `  type: ${yamlScalar(args.type)}`,
    ...Object.entries(args.fields ?? {}).map(([key, value]) => `  ${key}: ${yamlScalar(value)}`),
    ...(args.body == null ? [] : yamlBlockScalar(args.bodyTag ?? "body", args.body)),
  ];
  return ["```yaml", ...yamlLines, "```"].join("\n");
}

function yamlScalar(value: string | number): string {
  if (typeof value === "number") return String(value);
  if (/^[a-zA-Z0-9._/@:-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function yamlBlockScalar(key: string, value: string): string[] {
  return [`  ${key}: |-`, ...value.split("\n").map((line) => `    ${line}`)];
}

async function emitQueued(args: { append: Append }): Promise<void> {
  await args.append({
    event: LlmRequestQueuedEventInput.parse({
      type: "llm-request-queued",
      payload: {},
    }),
  });
}

async function emitAgentStatus(args: {
  append: Append;
  status: "working" | "idle";
  reason: string;
  requestId?: string;
}): Promise<void> {
  await args.append({
    event: AgentStatusUpdatedEventInput.parse({
      type: "agent-status-updated",
      payload: {
        status: args.status,
        reason: args.reason,
        ...(args.requestId == null ? {} : { requestId: args.requestId }),
      },
    }),
  });
}

async function handleUserInput(args: {
  runtime: ProcessorRuntime;
  append: Append;
  state: IterateAgentProcessorState;
  trigger: ConcreteTriggerLlm;
}): Promise<void> {
  const { runtime, append, state, trigger } = args;
  if (trigger.behaviour === "dont-trigger-request") return;
  const inflight = runtime.inflight();

  if (inflight === null) {
    await emitScheduledAndKickoff({ runtime, append, state });
    return;
  }

  if (inflight.status === "scheduled") {
    runtime.extendDebounce({
      requestId: inflight.requestId,
      debounceMs: state.llmConfig.debounceMs,
    });
    return;
  }

  if (trigger.behaviour === "after-current-request") {
    await emitQueued({ append });
    return;
  }

  if (trigger.behaviour === "trigger-request-within-time-period") {
    await emitQueued({ append });
    runtime.armCancelDeadline({
      requestId: inflight.requestId,
      withinMs: trigger.withinMs,
    });
    return;
  }

  await emitCancelled({
    runtime,
    append,
    requestId: inflight.requestId,
    reason: "interrupted-by-user-input",
  });
  await emitScheduledAndKickoff({ runtime, append, state });
}

export function reduceAgentLoop(
  event: GenericEventInput,
  state: IterateAgentProcessorState,
): IterateAgentProcessorState | undefined {
  return match(event)
    .case(SystemPromptUpdatedEvent, (e) => ({
      ...state,
      systemPrompt: e.payload.systemPrompt,
    }))
    .case(AgentInputAddedEvent, (e) => ({
      ...state,
      history: [...state.history, { role: e.payload.role, content: e.payload.content }],
    }))
    .case(LlmConfigUpdatedEvent, (e) => ({
      ...state,
      llmConfig: e.payload,
    }))
    .case(LlmRequestScheduledEvent, (e) => ({
      ...state,
      currentRequest: { requestId: e.payload.requestId },
      pendingTriggerCount: 0,
    }))
    .case(LlmRequestStartedEvent, (e) => ({
      ...state,
      // Mostly redundant with `llm-request-scheduled`, but useful if a
      // started event is replayed without its scheduled predecessor.
      currentRequest: { requestId: e.payload.requestId },
    }))
    .case(LlmRequestCompletedEvent, (e) =>
      state.currentRequest?.requestId === e.payload.requestId
        ? { ...state, currentRequest: null }
        : state,
    )
    .case(LlmRequestFailedEvent, (e) =>
      state.currentRequest?.requestId === e.payload.requestId
        ? { ...state, currentRequest: null }
        : state,
    )
    .case(LlmRequestCancelledEvent, (e) =>
      state.currentRequest?.requestId === e.payload.requestId
        ? { ...state, currentRequest: null }
        : state,
    )
    .case(LlmRequestQueuedEvent, () => ({
      ...state,
      pendingTriggerCount: state.pendingTriggerCount + 1,
    }))
    .default(() => undefined);
}

export async function agentLoopAfterAppend(
  args: AfterAppendArgs<IterateAgentProcessorState>,
): Promise<void> {
  const { append, state, runtime, event } = args;

  await match(event)
    .case(WebchatMessageReceivedEvent, async (e) => {
      if (e.offset == null) return;
      await appendEventTypeExplanation({ append, eventType: e.type });
      await args.append({
        event: AgentInputAddedEventInput.parse({
          type: "agent-input-added",
          payload: {
            role: "user",
            content: eventBlock({
              offset: e.offset,
              type: e.type,
              bodyTag: "content",
              body: e.payload.content,
            }),
          },
        }),
      });
    })
    .case(WebchatResponseAddedEvent, async (e) => {
      if (e.offset == null) return;
      await appendEventTypeExplanation({ append, eventType: e.type });
      await appendRewrite({
        append,
        content: eventBlock({
          offset: e.offset,
          type: e.type,
          bodyTag: "message",
          body: e.payload.message,
        }),
      });
    })
    .case(LlmRequestStartedEvent, async (e) => {
      if (e.offset == null) return;
      await appendEventTypeExplanation({ append, eventType: e.type });
      await appendRewrite({
        append,
        content: eventBlock({
          offset: e.offset,
          type: e.type,
          fields: {
            requestId: e.payload.requestId,
            model: e.payload.model,
            messageCount: e.payload.body.messages.length,
          },
        }),
      });
      await emitAgentStatus({
        append,
        status: "working",
        reason: "llm-request-started",
        requestId: e.payload.requestId,
      });
    })
    .case(LlmRequestQueuedEvent, async (e) => {
      if (e.offset == null) return;
      await appendEventTypeExplanation({ append, eventType: e.type });
      await appendRewrite({
        append,
        content: eventBlock({ offset: e.offset, type: e.type }),
      });
    })
    .case(LlmRequestCancelledEvent, async (e) => {
      if (e.offset == null) return;
      await appendEventTypeExplanation({ append, eventType: e.type });
      await appendRewrite({
        append,
        content: eventBlock({
          offset: e.offset,
          type: e.type,
          fields: { requestId: e.payload.requestId, reason: e.payload.reason },
        }),
      });
    })
    .case(LlmRequestFailedEvent, async (e) => {
      if (e.offset == null) return;
      await appendEventTypeExplanation({ append, eventType: e.type });
      await appendRewrite({
        append,
        content: eventBlock({
          offset: e.offset,
          type: e.type,
          fields: {
            requestId: e.payload.requestId,
            durationMs: e.payload.durationMs,
            error: e.payload.error.message,
          },
        }),
      });
    })
    .case(LlmRequestCompletedEvent, async (e) => {
      if (e.offset == null) return;
      await appendEventTypeExplanation({ append, eventType: e.type });
      await appendRewrite({
        append,
        content: eventBlock({
          offset: e.offset,
          type: e.type,
          fields: { requestId: e.payload.requestId, durationMs: e.payload.durationMs },
        }),
      });
    })
    .defaultAsync(() => undefined);

  await match(event)
    .case(AgentInputAddedEvent, async (e) => {
      if (e.offset == null) return;
      const trigger = resolveTrigger(e.payload);
      await handleUserInput({ runtime, append, state, trigger });
    })
    .case(LlmRequestCompletedEvent, async () => {
      if (state.pendingTriggerCount > 0 && runtime.inflight() === null) {
        await emitScheduledAndKickoff({ runtime, append, state });
      }
    })
    .case(LlmRequestCancelledEvent, async (e) => {
      if (state.pendingTriggerCount > 0 && runtime.inflight() === null) {
        await emitScheduledAndKickoff({ runtime, append, state });
        return;
      }
      if (state.pendingTriggerCount === 0 && runtime.inflight() === null) {
        await emitAgentStatus({
          append,
          status: "idle",
          reason: "llm-request-cancelled",
          requestId: e.payload.requestId,
        });
      }
    })
    .case(LlmRequestFailedEvent, async (e) => {
      if (state.pendingTriggerCount > 0 && runtime.inflight() === null) {
        await emitScheduledAndKickoff({ runtime, append, state });
        return;
      }
      if (state.pendingTriggerCount === 0 && runtime.inflight() === null) {
        await emitAgentStatus({
          append,
          status: "idle",
          reason: "llm-request-failed",
          requestId: e.payload.requestId,
        });
      }
    })
    .defaultAsync(() => undefined);
}
