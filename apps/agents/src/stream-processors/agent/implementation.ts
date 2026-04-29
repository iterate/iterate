import { z } from "zod";
import {
  assertNever,
  buildDerivedIdempotencyKey,
  implementProcessor,
  type ProcessorStreamApi,
} from "@iterate-com/shared/stream-processors";
import { AgentProcessorContract, type AgentState } from "./contract.ts";
import { CoreProcessorRegisteredEventType } from "../core/contract.ts";
import { wellBehavedProcessorDefaults } from "../core/well-behaved-processor-defaults.ts";

type AgentProcessorRuntime = {
  inflight(): { requestId: string; status: "scheduled" | "running" } | null;
  scheduleLlmRequest(args: { debounceMs: number }): { requestId: string };
  extendDebounce(args: { requestId: string; debounceMs: number }): void;
  cancelLlmRequest(args: { requestId: string }): void;
  armCancelDeadline(args: { requestId: string; withinMs: number }): void;
};

export type AgentProcessorDeps = {
  runtime: AgentProcessorRuntime;
};

type AgentStreamApi = ProcessorStreamApi<typeof AgentProcessorContract>;
type AgentInputPayload = z.infer<
  (typeof AgentProcessorContract.events)["events.iterate.com/agent/input-added"]["payloadSchema"]
>;
type ConcreteTriggerLlm = Exclude<AgentInputPayload["triggerLlmRequest"], { behaviour: "auto" }>;

const OpenAiChatCompletionResponse = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1),
});

const AnthropicAssistantMessage = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })).min(1),
});

const WorkersAiChatResponse = z.object({
  response: z.string(),
});

/**
 * Build the model request from reduced state only.
 *
 * Frontend code can compute this same state by importing the contract reducer;
 * backend hosts can call this helper when their runtime fires a scheduled LLM
 * request.
 */
export function buildLlmChatRequest(state: AgentState) {
  return {
    messages: [
      { role: "system" as const, content: state.systemPrompt },
      ...state.history.map((message) => ({
        role: message.role,
        content: message.content,
      })),
    ],
  };
}

export function extractLlmAssistantText(raw: unknown): string {
  if (typeof raw === "string") return raw;

  const openAI = OpenAiChatCompletionResponse.safeParse(raw);
  if (openAI.success) return openAI.data.choices[0].message.content;

  const anthropic = AnthropicAssistantMessage.safeParse(raw);
  if (anthropic.success) {
    return anthropic.data.content
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("");
  }

  const workersAI = WorkersAiChatResponse.safeParse(raw);
  if (workersAI.success) return workersAI.data.response;

  throw new Error("LLM response did not contain assistant text.");
}

export function createAgentProcessor(deps: AgentProcessorDeps) {
  return implementProcessor(AgentProcessorContract, {
    firstAttachAfterAppend: { mode: "lookback", milliseconds: 250 },

    async afterAppend({ event, state, streamApi }) {
      await wellBehavedProcessorDefaults.afterAppend({
        contract: AgentProcessorContract,
        state,
        streamApi,
      });

      switch (event.type) {
        case CoreProcessorRegisteredEventType:
        case "events.iterate.com/agent/system-prompt-updated":
        case "events.iterate.com/agent/llm-config-updated":
        case "events.iterate.com/agent/llm-request-scheduled":
        case "events.iterate.com/agent/status-updated":
          return;
        case "events.iterate.com/agent/webchat-message-received": {
          await appendEventTypeExplanation({
            eventType: event.type,
            streamApi,
          });
          await streamApi.append({
            event: {
              type: "events.iterate.com/agent/input-added",
              idempotencyKey: buildDerivedIdempotencyKey({
                slug: AgentProcessorContract.slug,
                purpose: "render-webchat-message",
                event,
              }),
              payload: {
                role: "user",
                content: eventBlock({
                  offset: event.offset,
                  type: event.type,
                  bodyTag: "content",
                  body: event.payload.content,
                }),
              },
            },
          });
          return;
        }
        case "events.iterate.com/agent/webchat-response-added": {
          await appendEventTypeExplanation({
            eventType: event.type,
            streamApi,
          });
          await appendRewrite({
            streamApi,
            event,
            purpose: "render-webchat-response",
            content: eventBlock({
              offset: event.offset,
              type: event.type,
              bodyTag: "message",
              body: event.payload.message,
            }),
          });
          return;
        }
        case "events.iterate.com/agent/input-added":
          await handleAgentInput({
            runtime: deps.runtime,
            streamApi,
            state,
            trigger: resolveTrigger(event.payload),
          });
          return;
        case "events.iterate.com/agent/llm-request-started":
          await appendEventTypeExplanation({
            eventType: event.type,
            streamApi,
          });
          await appendRewrite({
            streamApi,
            event,
            purpose: "render-llm-request-started",
            content: eventBlock({
              offset: event.offset,
              type: event.type,
              fields: {
                requestId: event.payload.requestId,
                model: event.payload.model,
                messageCount: event.payload.body.messages.length,
              },
            }),
          });
          await emitAgentStatus({
            streamApi,
            status: "working",
            reason: "llm-request-started",
            requestId: event.payload.requestId,
          });
          return;
        case "events.iterate.com/agent/llm-request-queued":
          await appendEventTypeExplanation({
            eventType: event.type,
            streamApi,
          });
          await appendRewrite({
            streamApi,
            event,
            purpose: "render-llm-request-queued",
            content: eventBlock({ offset: event.offset, type: event.type }),
          });
          return;
        case "events.iterate.com/agent/llm-request-completed":
          await appendEventTypeExplanation({
            eventType: event.type,
            streamApi,
          });
          await appendRewrite({
            streamApi,
            event,
            purpose: "render-llm-request-completed",
            content: eventBlock({
              offset: event.offset,
              type: event.type,
              fields: {
                requestId: event.payload.requestId,
                durationMs: event.payload.durationMs,
              },
            }),
          });
          await maybeContinueAfterTerminalEvent({
            runtime: deps.runtime,
            streamApi,
            state,
            reason: "llm-request-completed",
            requestId: event.payload.requestId,
          });
          return;
        case "events.iterate.com/agent/llm-request-failed":
          await appendEventTypeExplanation({
            eventType: event.type,
            streamApi,
          });
          await appendRewrite({
            streamApi,
            event,
            purpose: "render-llm-request-failed",
            content: eventBlock({
              offset: event.offset,
              type: event.type,
              fields: {
                requestId: event.payload.requestId,
                durationMs: event.payload.durationMs,
                error: event.payload.error.message,
              },
            }),
          });
          await maybeContinueAfterTerminalEvent({
            runtime: deps.runtime,
            streamApi,
            state,
            reason: "llm-request-failed",
            requestId: event.payload.requestId,
          });
          return;
        case "events.iterate.com/agent/llm-request-cancelled":
          await appendEventTypeExplanation({
            eventType: event.type,
            streamApi,
          });
          await appendRewrite({
            streamApi,
            event,
            purpose: "render-llm-request-cancelled",
            content: eventBlock({
              offset: event.offset,
              type: event.type,
              fields: {
                requestId: event.payload.requestId,
                reason: event.payload.reason,
              },
            }),
          });
          await maybeContinueAfterTerminalEvent({
            runtime: deps.runtime,
            streamApi,
            state,
            reason: "llm-request-cancelled",
            requestId: event.payload.requestId,
          });
          return;
        default:
          return assertNever(event);
      }
    },
  });
}

function resolveTrigger(payload: AgentInputPayload): ConcreteTriggerLlm {
  if (payload.triggerLlmRequest.behaviour !== "auto") {
    return payload.triggerLlmRequest;
  }
  return payload.role === "assistant"
    ? { behaviour: "dont-trigger-request" }
    : { behaviour: "interrupt-current-request" };
}

async function handleAgentInput(args: {
  runtime: AgentProcessorRuntime;
  streamApi: AgentStreamApi;
  state: AgentState;
  trigger: ConcreteTriggerLlm;
}) {
  const { runtime, streamApi, state, trigger } = args;
  if (trigger.behaviour === "dont-trigger-request") return;

  const inflight = runtime.inflight();
  if (inflight === null) {
    await emitScheduled({ runtime, streamApi, state });
    return;
  }

  if (inflight.status === "scheduled") {
    if (trigger.behaviour === "interrupt-current-request") {
      runtime.extendDebounce({
        requestId: inflight.requestId,
        debounceMs: state.llmConfig.debounceMs,
      });
      return;
    }
    await emitQueued({ streamApi });
    if (trigger.behaviour === "trigger-request-within-time-period") {
      runtime.armCancelDeadline({
        requestId: inflight.requestId,
        withinMs: trigger.withinMs,
      });
    }
    return;
  }

  if (trigger.behaviour === "after-current-request") {
    await emitQueued({ streamApi });
    return;
  }

  if (trigger.behaviour === "trigger-request-within-time-period") {
    await emitQueued({ streamApi });
    runtime.armCancelDeadline({
      requestId: inflight.requestId,
      withinMs: trigger.withinMs,
    });
    return;
  }

  runtime.cancelLlmRequest({ requestId: inflight.requestId });
  await streamApi.append({
    event: {
      type: "events.iterate.com/agent/llm-request-cancelled",
      payload: {
        requestId: inflight.requestId,
        reason: "interrupted-by-user-input",
      },
    },
  });
  await emitScheduled({ runtime, streamApi, state });
}

async function maybeContinueAfterTerminalEvent(args: {
  runtime: AgentProcessorRuntime;
  streamApi: AgentStreamApi;
  state: AgentState;
  reason: "llm-request-completed" | "llm-request-failed" | "llm-request-cancelled";
  requestId: string;
}) {
  if (args.state.pendingTriggerCount > 0 && args.runtime.inflight() === null) {
    await emitScheduled({
      runtime: args.runtime,
      streamApi: args.streamApi,
      state: args.state,
    });
    return;
  }

  if (args.state.pendingTriggerCount === 0 && args.runtime.inflight() === null) {
    await emitAgentStatus({
      streamApi: args.streamApi,
      status: "idle",
      reason: args.reason,
      requestId: args.requestId,
    });
  }
}

async function emitScheduled(args: {
  runtime: AgentProcessorRuntime;
  streamApi: AgentStreamApi;
  state: AgentState;
}) {
  const debounceMs = args.state.llmConfig.debounceMs;
  const { requestId } = args.runtime.scheduleLlmRequest({ debounceMs });
  await args.streamApi.append({
    event: {
      type: "events.iterate.com/agent/llm-request-scheduled",
      payload: {
        requestId,
        debounceMs,
        model: args.state.llmConfig.model,
      },
    },
  });
}

async function emitQueued(args: { streamApi: AgentStreamApi }) {
  await args.streamApi.append({
    event: {
      type: "events.iterate.com/agent/llm-request-queued",
      payload: {},
    },
  });
}

async function emitAgentStatus(args: {
  streamApi: AgentStreamApi;
  status: "working" | "idle";
  reason: string;
  requestId?: string;
}) {
  await args.streamApi.append({
    event: {
      type: "events.iterate.com/agent/status-updated",
      payload: {
        status: args.status,
        reason: args.reason,
        ...(args.requestId == null ? {} : { requestId: args.requestId }),
      },
    },
  });
}

async function appendRewrite(args: {
  streamApi: AgentStreamApi;
  event: { streamPath: string; offset: number };
  purpose: string;
  content: string;
}) {
  await args.streamApi.append({
    event: {
      type: "events.iterate.com/agent/input-added",
      idempotencyKey: buildDerivedIdempotencyKey({
        slug: AgentProcessorContract.slug,
        purpose: args.purpose,
        event: args.event,
      }),
      payload: {
        role: "user",
        content: args.content,
        triggerLlmRequest: { behaviour: "dont-trigger-request" },
      },
    },
  });
}

async function appendEventTypeExplanation(args: { streamApi: AgentStreamApi; eventType: string }) {
  const explanation = eventTypeExplanation(args.eventType);
  if (explanation == null) return;

  await args.streamApi.append({
    event: {
      type: "events.iterate.com/agent/input-added",
      idempotencyKey: `stream-processor:${AgentProcessorContract.slug}:event-type-explainer:${args.eventType}`,
      payload: {
        role: "user",
        content: explanation,
        triggerLlmRequest: { behaviour: "dont-trigger-request" },
      },
    },
  });
}

function eventTypeExplanation(eventType: string): string | null {
  if (eventType === "events.iterate.com/agent/webchat-message-received") {
    return eventTypeExplanationBlock({
      type: eventType,
      meaning: "This represents a message received from the webchat user.",
    });
  }
  if (eventType === "events.iterate.com/agent/webchat-response-added") {
    return eventTypeExplanationBlock({
      type: eventType,
      meaning:
        "This represents a message sent by codemode through `webchat.sendMessage({ message })`.",
    });
  }
  if (eventType === "events.iterate.com/agent/llm-request-started") {
    return eventTypeExplanationBlock({
      type: eventType,
      meaning:
        "An LLM request began. The requestId links later completion, cancellation, or failure events.",
    });
  }
  if (eventType === "events.iterate.com/agent/llm-request-queued") {
    return eventTypeExplanationBlock({
      type: eventType,
      meaning:
        "A trigger arrived while an LLM request was running and should be handled after the current request ends.",
    });
  }
  if (eventType === "events.iterate.com/agent/llm-request-cancelled") {
    return eventTypeExplanationBlock({
      type: eventType,
      meaning: "The current LLM request was interrupted or timed out before completion.",
    });
  }
  if (eventType === "events.iterate.com/agent/llm-request-failed") {
    return eventTypeExplanationBlock({
      type: eventType,
      meaning: "The current LLM request failed before producing a usable assistant turn.",
    });
  }
  if (eventType === "events.iterate.com/agent/llm-request-completed") {
    return eventTypeExplanationBlock({
      type: eventType,
      meaning: "The current LLM request produced a usable assistant turn.",
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
