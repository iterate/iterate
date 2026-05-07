import { z } from "zod";
import {
  assertNever,
  buildProcessorIdempotencyKey,
  implementProcessor,
  type ProcessorStreamApi,
} from "../stream-processor.ts";
import { CoreProcessorRegisteredEventType } from "../core/contract.ts";
import { standardProcessorBehavior } from "../core/standard-processor-behavior.ts";
import { AgentProcessorContract, reduceAgentEvents, type AgentState } from "./contract.ts";

/**
 * Backend-only dependencies for the Agent processor implementation.
 *
 * The Agent processor owns scheduling and model-visible history. It does not
 * call an LLM provider directly; it appends `agent/llm-request-requested` and a
 * subscribed LLM request processor owes the stream `agent/output-added` plus a
 * terminal `agent/llm-request-completed`.
 */
export type AgentProcessorDeps = {
  /**
   * Lets timer-fired request handoff remain associated with the surrounding
   * runner. Durable Object runners usually pass `ctx.waitUntil`.
   */
  waitUntil(promise: Promise<unknown>): void;
};

type AgentStreamApi = ProcessorStreamApi<typeof AgentProcessorContract>;
type AgentInputPayload = z.infer<
  (typeof AgentProcessorContract.events)["events.iterate.com/agent/input-added"]["payloadSchema"]
>;
type ConcreteTriggerLlm = Exclude<AgentInputPayload["triggerLlmRequest"], { behaviour: "auto" }>;

type ScheduledLlmRequest = {
  requestId: string;
  timer: ReturnType<typeof setTimeout>;
  scheduledEvent: { streamPath: string; offset: number };
};

/**
 * Build the provider-agnostic chat request from reduced state only.
 *
 * Frontend code can compute this same state by importing the contract reducer;
 * LLM request processors receive this rendered body through
 * `agent/llm-request-requested`.
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

export function createAgentProcessor(deps: AgentProcessorDeps) {
  /**
   * Warm-instance scheduling state. The durable request facts still live in the
   * stream, but timers cannot be serialized into reduced state.
   */
  let scheduledLlmRequest: ScheduledLlmRequest | null = null;
  let llmRequestSeq = 0;

  return implementProcessor(AgentProcessorContract, {
    firstAttachAfterAppend: { mode: "lookback", milliseconds: 60_000 },

    async afterAppend({ event, state, streamApi }) {
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
        case "events.iterate.com/codemode/tool-provider-registered":
          await appendLlmEventContext({
            streamApi,
            event,
            key: "render-codemode-tool-provider-registered",
            content: toolProviderRegisteredEventBlock({
              instructions: event.payload.instructions,
              offset: event.offset,
              path: event.payload.path,
              type: event.type,
            }),
          });
          return;
        case "events.iterate.com/agent/input-added":
          await handleAgentInputAddedForLlmRequest({
            event,
            streamApi,
            state,
            trigger: resolveTrigger(event.payload),
          });
          return;
        case "events.iterate.com/agent/llm-request-requested":
          await emitAgentStatus({
            sourceEvent: event,
            streamApi,
            status: "working",
            reason: "llm-request-requested",
            llmRequestId: event.offset,
          });
          return;
        case "events.iterate.com/agent/llm-request-queued":
          await appendLlmEventContext({
            streamApi,
            event,
            key: "render-llm-request-queued",
            content: eventBlock({ offset: event.offset, type: event.type }),
          });
          return;
        case "events.iterate.com/agent/llm-request-completed":
          await appendLlmEventContext({
            streamApi,
            event,
            key: "render-llm-request-completed",
            content: eventBlock({
              offset: event.offset,
              type: event.type,
              fields: {
                llmRequestId: event.payload.llmRequestId,
                provider: event.payload.provider,
                status: event.payload.result.status,
                durationMs: event.payload.durationMs,
              },
            }),
          });
          await handleTerminalLlmRequestEvent({
            sourceEvent: event,
            streamApi,
            state,
            reason: "llm-request-completed",
            llmRequestId: event.payload.llmRequestId,
          });
          return;
        case "events.iterate.com/agent/llm-request-cancelled":
          cancelScheduledLlmRequest({ requestId: event.payload.requestId });
          await appendLlmEventContext({
            streamApi,
            event,
            key: "render-llm-request-cancelled",
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
            sourceEvent: event,
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
   * input row. The durable handoff is `llm-request-requested`; provider
   * processors own the actual LLM side effect.
   */
  async function handleAgentInputAddedForLlmRequest(args: {
    streamApi: AgentStreamApi;
    event: { streamPath: string; offset: number };
    state: AgentState;
    trigger: ConcreteTriggerLlm;
  }) {
    const { event, streamApi, state, trigger } = args;
    if (trigger.behaviour === "dont-trigger-request") return;

    if (state.currentRequest == null) {
      await appendLlmRequestScheduled({ sourceEvent: event, streamApi, state });
      return;
    }

    if (state.currentRequest.phase === "scheduled") {
      if (trigger.behaviour === "interrupt-current-request") {
        resetScheduledLlmRequestTimer({
          requestId: state.currentRequest.requestId,
          debounceMs: state.llmConfig.debounceMs,
          streamApi,
        });
        return;
      }

      await emitQueued({ sourceEvent: event, streamApi });
      if (trigger.behaviour === "trigger-request-within-time-period") {
        armScheduledLlmRequestCancelDeadline({
          requestId: state.currentRequest.requestId,
          withinMs: trigger.withinMs,
          streamApi,
        });
      }
      return;
    }

    await emitQueued({ sourceEvent: event, streamApi });
  }

  /**
   * Reacts to completed/cancelled request events after the reducer has already
   * cleared or retained `currentRequest`. Queued triggers become a new
   * scheduled request; otherwise the processor publishes an idle status.
   */
  async function handleTerminalLlmRequestEvent(args: {
    sourceEvent: { streamPath: string; offset: number };
    streamApi: AgentStreamApi;
    state: AgentState;
    reason: "llm-request-completed" | "llm-request-cancelled";
    requestId?: string;
    llmRequestId?: number;
  }) {
    if (args.state.pendingTriggerCount > 0 && scheduledLlmRequest === null) {
      await appendLlmRequestScheduled({
        sourceEvent: args.sourceEvent,
        streamApi: args.streamApi,
        state: args.state,
      });
      return;
    }

    if (args.state.pendingTriggerCount === 0 && scheduledLlmRequest === null) {
      await emitAgentStatus({
        sourceEvent: args.sourceEvent,
        streamApi: args.streamApi,
        status: "idle",
        reason: args.reason,
        requestId: args.requestId,
        llmRequestId: args.llmRequestId,
      });
    }
  }

  async function appendLlmRequestScheduled(args: {
    sourceEvent: { streamPath: string; offset: number };
    streamApi: AgentStreamApi;
    state: AgentState;
  }) {
    const debounceMs = args.state.llmConfig.debounceMs;
    llmRequestSeq += 1;
    const requestId = `req_${Date.now()}_${llmRequestSeq}`;
    const scheduledEvent = await args.streamApi.append({
      event: {
        type: "events.iterate.com/agent/llm-request-scheduled",
        idempotencyKey: buildProcessorIdempotencyKey({
          processor: AgentProcessorContract,
          key: "llm-request-scheduled",
          sourceEvent: args.sourceEvent,
        }),
        payload: {
          requestId,
          debounceMs,
          model: args.state.llmConfig.model,
        },
      },
    });
    armLlmRequestDebounceTimer({
      requestId,
      debounceMs,
      scheduledEvent,
      streamApi: args.streamApi,
    });
  }

  function cancelScheduledLlmRequest(args: { requestId: string }) {
    if (scheduledLlmRequest?.requestId !== args.requestId) return;
    clearTimeout(scheduledLlmRequest.timer);
    scheduledLlmRequest = null;
  }

  function resetScheduledLlmRequestTimer(args: {
    requestId: string;
    debounceMs: number;
    streamApi: AgentStreamApi;
  }) {
    const scheduledEvent = scheduledLlmRequest?.scheduledEvent;
    cancelScheduledLlmRequest({ requestId: args.requestId });
    if (scheduledEvent == null) return;
    armLlmRequestDebounceTimer({ ...args, scheduledEvent });
  }

  /**
   * Arms a best-effort deadline for "finish within N ms" triggers while a
   * request is still only scheduled. Once handed to a provider, cancellation is
   * a provider concern for a later slice.
   */
  function armScheduledLlmRequestCancelDeadline(args: {
    requestId: string;
    withinMs: number;
    streamApi: AgentStreamApi;
  }) {
    setTimeout(() => {
      if (scheduledLlmRequest?.requestId !== args.requestId) return;

      const scheduledEvent = scheduledLlmRequest.scheduledEvent;
      cancelScheduledLlmRequest({ requestId: args.requestId });
      deps.waitUntil(
        args.streamApi.append({
          event: {
            type: "events.iterate.com/agent/llm-request-cancelled",
            idempotencyKey: buildProcessorIdempotencyKey({
              processor: AgentProcessorContract,
              key: "llm-request-cancelled/deadline-exceeded",
              sourceEvent: scheduledEvent,
            }),
            payload: { requestId: args.requestId, reason: "deadline-exceeded" },
          },
        }),
      );
    }, args.withinMs);
  }

  function armLlmRequestDebounceTimer(args: {
    requestId: string;
    debounceMs: number;
    scheduledEvent: { streamPath: string; offset: number };
    streamApi: AgentStreamApi;
  }) {
    const timer = setTimeout(() => {
      deps.waitUntil(
        requestScheduledLlmWork({
          requestId: args.requestId,
          streamApi: args.streamApi,
        }),
      );
    }, args.debounceMs);
    scheduledLlmRequest = {
      requestId: args.requestId,
      timer,
      scheduledEvent: args.scheduledEvent,
    };
  }

  async function requestScheduledLlmWork(args: { requestId: string; streamApi: AgentStreamApi }) {
    if (scheduledLlmRequest?.requestId !== args.requestId) return;

    /**
     * Rebuild the LLM handoff from durable stream history at the last possible
     * moment.
     *
     * The obvious implementation is to use `latestAgentState`, which the runner
     * updates as it consumes live events. That was too optimistic. The request
     * debounce timer is independent from WebSocket event delivery, so it can fire
     * after the user-triggering input has been reduced but before related
     * non-triggering context rows have reached this runner. The concrete failure
     * was:
     *
     * 1. Webchat appended the user event and its Agent input rewrite.
     * 2. Codemode appended its one-time "respond with a fenced JS block" primer.
     * 3. The Agent timer fired from the user input before the primer was present
     *    in this runner's warm in-memory `latestAgentState`.
     * 4. `agent/llm-request-requested` was appended without the primer, so
     *    OpenAI quite reasonably returned plain assistant prose instead of a
     *    codemode block. Codemode then had nothing to execute.
     *
     * Reading and reducing the stream here makes the provider request reflect
     * the committed stream, not a potentially stale warm object. This is an
     * intentionally small correctness guardrail for the current proof. It is
     * also not where we want to end up: the better design is probably an
     * explicit ordered processor runner, a first-class "request builder"
     * phase, or a clearer event-level barrier that says "all context for this
     * request has landed" before the LLM handoff can happen.
     */
    const events = await args.streamApi.read({
      afterOffset: "start",
      beforeOffset: "end",
    });
    const stateAtRequest = reduceAgentEvents({ events });

    const scheduledEvent = scheduledLlmRequest.scheduledEvent;
    scheduledLlmRequest = null;
    await args.streamApi.append({
      event: {
        type: "events.iterate.com/agent/llm-request-requested",
        idempotencyKey: buildProcessorIdempotencyKey({
          processor: AgentProcessorContract,
          key: "llm-request-requested",
          sourceEvent: scheduledEvent,
        }),
        payload: {
          model: stateAtRequest.llmConfig.model,
          body: buildLlmChatRequest(stateAtRequest),
          runOpts: stateAtRequest.llmConfig.runOpts,
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

async function emitQueued(args: {
  sourceEvent: { streamPath: string; offset: number };
  streamApi: AgentStreamApi;
}) {
  await args.streamApi.append({
    event: {
      type: "events.iterate.com/agent/llm-request-queued",
      idempotencyKey: buildProcessorIdempotencyKey({
        processor: AgentProcessorContract,
        key: "llm-request-queued",
        sourceEvent: args.sourceEvent,
      }),
      payload: {},
    },
  });
}

async function emitAgentStatus(args: {
  sourceEvent: { streamPath: string; offset: number };
  streamApi: AgentStreamApi;
  status: "working" | "idle";
  reason: string;
  requestId?: string;
  llmRequestId?: number;
}) {
  await args.streamApi.append({
    event: {
      type: "events.iterate.com/agent/status-updated",
      idempotencyKey: buildProcessorIdempotencyKey({
        processor: AgentProcessorContract,
        key: `status-updated/${args.status}/${args.reason}`,
        sourceEvent: args.sourceEvent,
      }),
      payload: {
        status: args.status,
        reason: args.reason,
        ...(args.requestId == null ? {} : { requestId: args.requestId }),
        ...(args.llmRequestId == null ? {} : { llmRequestId: args.llmRequestId }),
      },
    },
  });
}

async function appendLlmEventContext(args: {
  streamApi: AgentStreamApi;
  event: { streamPath: string; offset: number; type: string };
  key: string;
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
  key: string;
  content: string;
}) {
  await args.streamApi.append({
    event: {
      type: "events.iterate.com/agent/input-added",
      idempotencyKey: buildProcessorIdempotencyKey({
        processor: AgentProcessorContract,
        key: args.key,
        sourceEvent: args.event,
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
      idempotencyKey: buildProcessorIdempotencyKey({
        processor: AgentProcessorContract,
        key: `event-type-explainer/${args.eventType}`,
      }),
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
      meaning: "The current scheduled LLM request was interrupted or timed out before handoff.",
    });
  }
  if (eventType === "events.iterate.com/agent/llm-request-completed") {
    return eventTypeExplanationBlock({
      type: eventType,
      meaning: "The current LLM request reached a terminal success or failure result.",
    });
  }
  if (eventType === "events.iterate.com/codemode/tool-provider-registered") {
    return eventTypeExplanationBlock({
      type: eventType,
      meaning:
        "A codemode tool provider became available. Its path and instructions should be used when writing codemode scripts.",
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

function toolProviderRegisteredEventBlock(args: {
  instructions: string;
  offset: number;
  path: readonly string[];
  type: string;
}): string {
  const yamlLines = [
    "event:",
    `  offset: ${args.offset}`,
    `  type: ${yamlScalar(args.type)}`,
    "  payload:",
    "    path:",
    ...args.path.map((segment) => `      - ${yamlScalar(segment)}`),
    ...yamlBlockScalar("instructions", args.instructions).map((line) => `  ${line}`),
  ];
  return ["```yaml", ...yamlLines, "```"].join("\n");
}
