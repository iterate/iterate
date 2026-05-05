import { z } from "zod";
import {
  assertNever,
  buildDerivedIdempotencyKey,
  implementProcessor,
  type ProcessorStreamApi,
} from "../stream-processor.ts";
import { CoreProcessorRegisteredEventType } from "../core/contract.ts";
import { standardProcessorBehavior } from "../core/standard-processor-behavior.ts";
import { AgentProcessorContract, type AgentState } from "./contract.ts";

/**
 * Backend-only dependencies for the Agent processor implementation.
 *
 * Keep this narrow. The processor owns scheduling, cancellation, request IDs,
 * and timers; callers only provide external capabilities that the processor
 * cannot create itself.
 */
export type AgentProcessorDeps = {
  ai: {
    run(model: string, body: unknown, runOpts?: unknown): Promise<unknown>;
  };
  /**
   * Lets timer-fired LLM work remain associated with the surrounding runner.
   * Durable Object runners usually pass `ctx.waitUntil`.
   */
  waitUntil(promise: Promise<unknown>): void;
};

type AgentStreamApi = ProcessorStreamApi<typeof AgentProcessorContract>;
type AgentInputPayload = z.infer<
  (typeof AgentProcessorContract.events)["events.iterate.com/agent/input-added"]["payloadSchema"]
>;
type ConcreteTriggerLlm = Exclude<AgentInputPayload["triggerLlmRequest"], { behaviour: "auto" }>;
type JsonValue = z.infer<ReturnType<typeof z.json>>;

type InflightLlmRequest =
  | { kind: "scheduled"; requestId: string; timer: ReturnType<typeof setTimeout> }
  | { kind: "running"; requestId: string; controller: AbortController };

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
 * backend processor implementations call this helper when their local debounce
 * timer fires.
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
  /**
   * Warm-instance state owned by this processor instance.
   *
   * This is deliberately not reduced state: timers, abort controllers, and the
   * current in-flight request cannot be serialized or replayed. Losing this on
   * Durable Object eviction is acceptable because durable facts still live in
   * the stream as `llm-request-*` events.
   */
  let inflightLlmRequest: InflightLlmRequest | null = null;
  let llmRequestSeq = 0;
  let latestAgentState: AgentState | null = null;

  return implementProcessor(AgentProcessorContract, {
    onStart({ state }) {
      latestAgentState = state;
    },

    async afterAppend({ event, state, streamApi }) {
      latestAgentState = state;
      await standardProcessorBehavior.afterAppend({
        contract: AgentProcessorContract,
        state,
        streamApi,
      });

      switch (event.type) {
        case CoreProcessorRegisteredEventType:
        case "events.iterate.com/agent/system-prompt-updated":
        case "events.iterate.com/agent/llm-config-updated":
        case "events.iterate.com/agent/output-added":
        case "events.iterate.com/agent/llm-request-scheduled":
        case "events.iterate.com/agent/status-updated":
          return;
        case "events.iterate.com/agent/input-added":
          await handleAgentInputAddedForLlmRequest({
            streamApi,
            state,
            trigger: resolveTrigger(event.payload),
          });
          return;
        case "events.iterate.com/agent/llm-request-started":
          await emitAgentStatus({
            streamApi,
            status: "working",
            reason: "llm-request-started",
            requestId: event.payload.requestId,
          });
          return;
        case "events.iterate.com/agent/llm-request-queued":
          await appendLlmEventContext({
            streamApi,
            event,
            purpose: "render-llm-request-queued",
            content: eventBlock({ offset: event.offset, type: event.type }),
          });
          return;
        case "events.iterate.com/agent/llm-request-completed":
          await appendLlmEventContext({
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
          await handleTerminalLlmRequestEvent({
            streamApi,
            state,
            reason: "llm-request-completed",
            requestId: event.payload.requestId,
          });
          return;
        case "events.iterate.com/agent/llm-request-failed":
          await appendLlmEventContext({
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
          await handleTerminalLlmRequestEvent({
            streamApi,
            state,
            reason: "llm-request-failed",
            requestId: event.payload.requestId,
          });
          return;
        case "events.iterate.com/agent/llm-request-cancelled":
          await appendLlmEventContext({
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
          await handleTerminalLlmRequestEvent({
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

  /**
   * Applies the Agent processor's LLM scheduling policy for a model-visible
   * input row. The durable facts are appended as `llm-request-*` events; the
   * timers and abort controllers below are warm-instance state only.
   */
  async function handleAgentInputAddedForLlmRequest(args: {
    streamApi: AgentStreamApi;
    state: AgentState;
    trigger: ConcreteTriggerLlm;
  }) {
    const { streamApi, state, trigger } = args;
    if (trigger.behaviour === "dont-trigger-request") return;

    if (inflightLlmRequest === null) {
      await appendLlmRequestScheduled({ streamApi, state });
      return;
    }

    if (inflightLlmRequest.kind === "scheduled") {
      if (trigger.behaviour === "interrupt-current-request") {
        clearTimeout(inflightLlmRequest.timer);
        armLlmRequestDebounceTimer({
          requestId: inflightLlmRequest.requestId,
          debounceMs: state.llmConfig.debounceMs,
          streamApi,
        });
        return;
      }

      await emitQueued({ streamApi });
      if (trigger.behaviour === "trigger-request-within-time-period") {
        armLlmRequestCancelDeadline({
          requestId: inflightLlmRequest.requestId,
          withinMs: trigger.withinMs,
          streamApi,
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
      armLlmRequestCancelDeadline({
        requestId: inflightLlmRequest.requestId,
        withinMs: trigger.withinMs,
        streamApi,
      });
      return;
    }

    const interruptedRequestId = inflightLlmRequest.requestId;
    cancelInflightLlmRequest({ requestId: interruptedRequestId });
    await streamApi.append({
      event: {
        type: "events.iterate.com/agent/llm-request-cancelled",
        payload: {
          requestId: interruptedRequestId,
          reason: "interrupted-by-user-input",
        },
      },
    });
    await appendLlmRequestScheduled({ streamApi, state });
  }

  /**
   * Reacts to completed/failed/cancelled request events after the reducer has
   * already cleared or retained `currentRequest`. Queued triggers become a new
   * scheduled request; otherwise the processor publishes an idle status.
   */
  async function handleTerminalLlmRequestEvent(args: {
    streamApi: AgentStreamApi;
    state: AgentState;
    reason: "llm-request-completed" | "llm-request-failed" | "llm-request-cancelled";
    requestId: string;
  }) {
    if (args.state.pendingTriggerCount > 0 && inflightLlmRequest === null) {
      await appendLlmRequestScheduled({
        streamApi: args.streamApi,
        state: args.state,
      });
      return;
    }

    if (args.state.pendingTriggerCount === 0 && inflightLlmRequest === null) {
      await emitAgentStatus({
        streamApi: args.streamApi,
        status: "idle",
        reason: args.reason,
        requestId: args.requestId,
      });
    }
  }

  async function appendLlmRequestScheduled(args: { streamApi: AgentStreamApi; state: AgentState }) {
    const debounceMs = args.state.llmConfig.debounceMs;
    llmRequestSeq += 1;
    const requestId = `req_${Date.now()}_${llmRequestSeq}`;
    armLlmRequestDebounceTimer({ requestId, debounceMs, streamApi: args.streamApi });
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

  function cancelInflightLlmRequest(args: { requestId: string }) {
    if (inflightLlmRequest?.requestId !== args.requestId) {
      return;
    }

    if (inflightLlmRequest.kind === "scheduled") {
      clearTimeout(inflightLlmRequest.timer);
    } else {
      inflightLlmRequest.controller.abort();
    }
    inflightLlmRequest = null;
  }

  /**
   * Arms a best-effort deadline for "finish within N ms" triggers. The request
   * ID guard makes the timer harmless if the request finishes or is superseded
   * before the deadline fires.
   */
  function armLlmRequestCancelDeadline(args: {
    requestId: string;
    withinMs: number;
    streamApi: AgentStreamApi;
  }) {
    setTimeout(() => {
      if (
        inflightLlmRequest?.requestId !== args.requestId ||
        inflightLlmRequest.kind !== "running"
      ) {
        return;
      }

      inflightLlmRequest.controller.abort();
      inflightLlmRequest = null;
      deps.waitUntil(
        args.streamApi.append({
          event: {
            type: "events.iterate.com/agent/llm-request-cancelled",
            payload: { requestId: args.requestId, reason: "deadline-exceeded" },
          },
        }),
      );
    }, args.withinMs);
  }

  function armLlmRequestDebounceTimer(args: {
    requestId: string;
    debounceMs: number;
    streamApi: AgentStreamApi;
  }) {
    const timer = setTimeout(() => {
      deps.waitUntil(
        runScheduledLlmRequest({
          requestId: args.requestId,
          streamApi: args.streamApi,
        }),
      );
    }, args.debounceMs);
    inflightLlmRequest = { kind: "scheduled", requestId: args.requestId, timer };
  }

  async function runScheduledLlmRequest(args: { requestId: string; streamApi: AgentStreamApi }) {
    if (
      inflightLlmRequest?.requestId !== args.requestId ||
      inflightLlmRequest.kind !== "scheduled"
    ) {
      return;
    }

    const stateAtStart = latestAgentState;
    if (stateAtStart == null) {
      return;
    }

    const controller = new AbortController();
    inflightLlmRequest = { kind: "running", requestId: args.requestId, controller };
    const body = buildLlmChatRequest(stateAtStart);
    const startedAt = Date.now();

    await args.streamApi.append({
      event: {
        type: "events.iterate.com/agent/llm-request-started",
        payload: {
          requestId: args.requestId,
          model: stateAtStart.llmConfig.model,
          body,
          runOpts: stateAtStart.llmConfig.runOpts,
        },
      },
    });

    let raw: unknown;
    try {
      raw = await deps.ai.run(stateAtStart.llmConfig.model, body, stateAtStart.llmConfig.runOpts);
    } catch (error) {
      if (inflightLlmRequest?.requestId === args.requestId) {
        inflightLlmRequest = null;
      }
      await appendLlmRequestFailed({
        streamApi: args.streamApi,
        requestId: args.requestId,
        startedAt,
        error,
      });
      return;
    }

    if (controller.signal.aborted || inflightLlmRequest?.requestId !== args.requestId) {
      return;
    }

    let assistantText: string;
    try {
      assistantText = extractLlmAssistantText(raw);
    } catch (error) {
      if (inflightLlmRequest?.requestId === args.requestId) {
        inflightLlmRequest = null;
      }
      await appendLlmRequestFailed({
        streamApi: args.streamApi,
        requestId: args.requestId,
        rawResponse: toJsonValue(raw),
        startedAt,
        error,
      });
      return;
    }

    inflightLlmRequest = null;
    await args.streamApi.append({
      event: {
        type: "events.iterate.com/agent/llm-request-completed",
        payload: {
          requestId: args.requestId,
          rawResponse: toJsonValue(raw),
          durationMs: Date.now() - startedAt,
        },
      },
    });
    await args.streamApi.append({
      event: {
        type: "events.iterate.com/agent/output-added",
        payload: {
          content: assistantText,
        },
      },
    });
  }
}

function resolveTrigger(payload: AgentInputPayload): ConcreteTriggerLlm {
  if (payload.triggerLlmRequest.behaviour !== "auto") {
    return payload.triggerLlmRequest;
  }
  return { behaviour: "interrupt-current-request" };
}

async function emitQueued(args: { streamApi: AgentStreamApi }) {
  await args.streamApi.append({
    event: {
      type: "events.iterate.com/agent/llm-request-queued",
      payload: {},
    },
  });
}

async function appendLlmRequestFailed(args: {
  streamApi: AgentStreamApi;
  requestId: string;
  rawResponse?: JsonValue;
  startedAt: number;
  error: unknown;
}) {
  await args.streamApi.append({
    event: {
      type: "events.iterate.com/agent/llm-request-failed",
      payload: {
        requestId: args.requestId,
        durationMs: Date.now() - args.startedAt,
        error: { message: stringifyError(args.error) },
        ...(args.rawResponse === undefined ? {} : { rawResponse: args.rawResponse }),
      },
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

async function appendLlmEventContext(args: {
  streamApi: AgentStreamApi;
  event: { streamPath: string; offset: number; type: string };
  purpose: string;
  content: string;
}) {
  await appendEventTypeExplanation({
    streamApi: args.streamApi,
    eventType: args.event.type,
  });
  await appendRewrite(args);
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
        content: `An event has occurred: \n\n${args.content}`,
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
        content: explanation,
        triggerLlmRequest: { behaviour: "dont-trigger-request" },
      },
    },
  });
}

function eventTypeExplanation(eventType: string): string | null {
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

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function toJsonValue(value: unknown): JsonValue {
  return z.json().parse(value);
}
