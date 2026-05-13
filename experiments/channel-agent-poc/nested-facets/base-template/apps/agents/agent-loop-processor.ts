import type {
  AgentEvent,
  AfterAppendArgs,
  Append,
  ProcessorRuntime,
} from "./agent-processor-shared.ts";
import type {
  HistoryItem,
  IterateAgentProcessorState,
  LlmRequestPolicy,
} from "./agent-processor-types.ts";

const CODEMODE_REPAIR_MARKER = "[codemode-repair-request]";

function resolveTrigger(payload: Record<string, any>): LlmRequestPolicy {
  return (payload.llmRequestPolicy ?? { behaviour: "after-current-request" }) as LlmRequestPolicy;
}

export function buildLlmChatRequest(state: IterateAgentProcessorState) {
  return {
    messages: [
      { role: "system", content: state.systemPrompt },
      ...state.history.map((m) => ({ role: m.role, content: m.content })),
    ],
  };
}

export function extractLlmAssistantText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  const data = raw as any;
  if (typeof data?.text === "string") return data.text;
  if (typeof data?.content === "string") return data.content;
  if (typeof data?.output_text === "string") return data.output_text;
  if (typeof data?.response === "string") return data.response;
  if (typeof data?.result === "string") return data.result;
  if (typeof data?.message?.content === "string") return data.message.content;
  if (typeof data?.choices?.[0]?.message?.content === "string") {
    return data.choices[0].message.content;
  }
  if (typeof data?.choices?.[0]?.text === "string") return data.choices[0].text;
  if (data?.result && typeof data.result === "object") {
    return extractLlmAssistantText(data.result);
  }
  if (data?.data && typeof data.data === "object") {
    return extractLlmAssistantText(data.data);
  }
  if (Array.isArray(data?.content)) {
    return data.content
      .filter((b: any) => b?.type === "text")
      .map((b: any) => b.text ?? "")
      .join("");
  }
  if (Array.isArray(data?.output)) {
    const text = data.output
      .flatMap((item: any) => (Array.isArray(item?.content) ? item.content : [item]))
      .map((item: any) => item?.text ?? item?.content ?? "")
      .filter((part: unknown) => typeof part === "string")
      .join("");
    if (text) return text;
  }
  throw new Error("Could not extract assistant text from LLM response");
}

async function emitScheduledAndKickoff(args: {
  runtime: ProcessorRuntime;
  append: Append;
  state: IterateAgentProcessorState;
}): Promise<void> {
  const debounceMs = args.state.llmConfig.debounceMs;
  const { requestId } = args.runtime.scheduleLlmRequest({ debounceMs });
  await args.append({
    event: {
      type: "events.iterate.com/agent/request-scheduled",
      payload: { requestId, debounceMs, model: args.state.llmConfig.model },
    },
  });
}

async function emitCancelled(args: {
  runtime: ProcessorRuntime;
  append: Append;
  requestId: string;
  reason: "interrupted-by-user-input" | "deadline-exceeded";
}): Promise<void> {
  args.runtime.cancelLlmRequest({ requestId: args.requestId });
  await args.append({
    event: {
      type: "events.iterate.com/agent/request-cancelled",
      payload: { requestId: args.requestId, reason: args.reason },
    },
  });
}

async function appendRewrite(args: { append: Append; content: string }): Promise<void> {
  await args.append({
    event: {
      type: "events.iterate.com/agent/input-added",
      payload: {
        role: "user",
        content: args.content,
        llmRequestPolicy: { behaviour: "dont-trigger-request" },
      },
    },
  });
}

async function appendEventTypeExplanation(args: {
  append: Append;
  eventType: string;
}): Promise<void> {
  const explanation = eventTypeExplanation(args.eventType);
  if (explanation == null) return;
  await args.append({
    event: {
      type: "events.iterate.com/agent/input-added",
      idempotencyKey: `iterate-agent:event-type-explainer:${args.eventType}`,
      payload: {
        role: "user",
        content: explanation,
        llmRequestPolicy: { behaviour: "dont-trigger-request" },
      },
    },
  });
}

function eventTypeExplanation(eventType: string): string | null {
  if (eventType === "events.iterate.com/agent-webchat/message-received") {
    return eventTypeExplanationBlock({
      type: eventType,
      meaning: "This represents a message received from the webchat user.",
    });
  }
  if (eventType === "events.iterate.com/agent-webchat/response-added") {
    return eventTypeExplanationBlock({
      type: eventType,
      meaning:
        "This represents a message you sent by writing a codemode block that calls `webchat.sendMessage({ message })`.",
    });
  }
  if (eventType === "events.iterate.com/agent/request-started") {
    return eventTypeExplanationBlock({
      type: eventType,
      meaning:
        "An agent response request began. The requestId links later completion, cancellation, or failure events.",
    });
  }
  if (eventType === "events.iterate.com/agent/request-queued") {
    return eventTypeExplanationBlock({
      type: eventType,
      meaning:
        "A trigger arrived while an agent response request was running. It should be handled after the current request ends.",
    });
  }
  if (eventType === "events.iterate.com/agent/request-cancelled") {
    return eventTypeExplanationBlock({
      type: eventType,
      meaning:
        "The current agent response request was interrupted or timed out before it completed.",
    });
  }
  if (eventType === "events.iterate.com/agent/request-failed") {
    return eventTypeExplanationBlock({
      type: eventType,
      meaning:
        "The current agent response request failed before producing a usable codemode response.",
    });
  }
  if (eventType === "events.iterate.com/agent/request-completed") {
    return eventTypeExplanationBlock({
      type: eventType,
      meaning: "The current agent response request produced a usable codemode response.",
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
  await args.append({ event: { type: "events.iterate.com/agent/request-queued", payload: {} } });
}

async function emitAgentStatus(args: {
  append: Append;
  status: "working" | "idle";
  reason: string;
  requestId?: string;
}): Promise<void> {
  await args.append({
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

async function handleUserInput(args: {
  runtime: ProcessorRuntime;
  append: Append;
  state: IterateAgentProcessorState;
  trigger: LlmRequestPolicy;
}): Promise<void> {
  const { runtime, append, state, trigger } = args;
  if (trigger.behaviour === "dont-trigger-request") return;
  const inflight = runtime.inflight();

  if (inflight === null) {
    await emitScheduledAndKickoff({ runtime, append, state });
    return;
  }

  if (inflight.status === "scheduled") {
    if (trigger.behaviour === "interrupt-current-request") {
      await emitCancelled({
        runtime,
        append,
        requestId: inflight.requestId,
        reason: "interrupted-by-user-input",
      });
      await emitScheduledAndKickoff({ runtime, append, state });
      return;
    }
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

  await emitCancelled({
    runtime,
    append,
    requestId: inflight.requestId,
    reason: "interrupted-by-user-input",
  });
  await emitScheduledAndKickoff({ runtime, append, state });
}

export function reduceAgentLoop(
  event: AgentEvent,
  state: IterateAgentProcessorState,
): IterateAgentProcessorState | undefined {
  if (event.type === "events.iterate.com/agent/system-prompt-updated") {
    return { ...state, systemPrompt: String(event.payload?.systemPrompt ?? "") };
  }
  if (event.type === "events.iterate.com/agent/input-added") {
    const role = event.payload?.role;
    const content = event.payload?.content;
    if ((role !== "user" && role !== "assistant") || typeof content !== "string") return state;
    const item: HistoryItem = { role, content };
    return { ...state, history: [...state.history, item] };
  }
  if (event.type === "events.iterate.com/agent/config-updated") {
    return { ...state, llmConfig: event.payload as any };
  }
  if (event.type === "events.iterate.com/agent/request-scheduled") {
    return {
      ...state,
      currentRequest: { requestId: String(event.payload?.requestId) },
      pendingTriggerCount: 0,
    };
  }
  if (event.type === "events.iterate.com/agent/request-started") {
    return { ...state, currentRequest: { requestId: String(event.payload?.requestId) } };
  }
  if (
    event.type === "events.iterate.com/agent/request-completed" ||
    event.type === "events.iterate.com/agent/request-cancelled" ||
    event.type === "events.iterate.com/agent/request-failed"
  ) {
    return state.currentRequest?.requestId === event.payload?.requestId
      ? { ...state, currentRequest: null }
      : state;
  }
  if (event.type === "events.iterate.com/agent/request-queued") {
    return { ...state, pendingTriggerCount: state.pendingTriggerCount + 1 };
  }
  return undefined;
}

export async function agentLoopAfterAppend(
  args: AfterAppendArgs<IterateAgentProcessorState>,
): Promise<void> {
  const { append, state, runtime, event } = args;

  if (event.type === "events.iterate.com/agent-webchat/message-received") {
    if (event.offset == null) return;
    await appendEventTypeExplanation({ append, eventType: event.type });
    await append({
      event: {
        type: "events.iterate.com/agent/input-added",
        payload: {
          role: "user",
          content: eventBlock({
            offset: event.offset,
            type: event.type,
            bodyTag: "content",
            body: String(event.payload?.content ?? ""),
          }),
        },
      },
    });
    return;
  }

  if (event.type === "events.iterate.com/agent-webchat/response-added") {
    if (event.offset == null) return;
    await appendEventTypeExplanation({ append, eventType: event.type });
    await appendRewrite({
      append,
      content: eventBlock({
        offset: event.offset,
        type: event.type,
        bodyTag: "message",
        body: String(event.payload?.message ?? ""),
      }),
    });
    return;
  }

  if (event.type === "events.iterate.com/agent/request-started") {
    if (event.offset == null) return;
    await appendEventTypeExplanation({ append, eventType: event.type });
    await appendRewrite({
      append,
      content: eventBlock({
        offset: event.offset,
        type: event.type,
        fields: {
          requestId: String(event.payload?.requestId ?? ""),
          model: String(event.payload?.model ?? ""),
          messageCount: Array.isArray(event.payload?.body?.messages)
            ? event.payload.body.messages.length
            : 0,
        },
      }),
    });
    await emitAgentStatus({
      append,
      status: "working",
      reason: "events.iterate.com/agent/request-started",
      requestId: String(event.payload?.requestId ?? ""),
    });
    return;
  }

  if (event.type === "events.iterate.com/agent/request-queued") {
    if (event.offset == null) return;
    await appendEventTypeExplanation({ append, eventType: event.type });
    await appendRewrite({
      append,
      content: eventBlock({ offset: event.offset, type: event.type }),
    });
    return;
  }

  if (event.type === "events.iterate.com/agent/request-failed") {
    if (event.offset == null) return;
    await appendEventTypeExplanation({ append, eventType: event.type });
    await appendRewrite({
      append,
      content: eventBlock({
        offset: event.offset,
        type: event.type,
        fields: {
          requestId: String(event.payload?.requestId ?? ""),
          durationMs: Number(event.payload?.durationMs ?? 0),
          error: String(event.payload?.error?.message ?? event.payload?.error ?? ""),
        },
      }),
    });
    if (event.payload?.recoverable === true) {
      await append({
        event: {
          type: "events.iterate.com/agent/input-added",
          idempotencyKey: `codemode-repair:${String(event.payload?.requestId ?? event.offset)}`,
          payload: {
            role: "user",
            content: `${CODEMODE_REPAIR_MARKER}
Your previous assistant response was not a complete executable codemode block. Reply again now with exactly one complete fenced \`js\` block, under 25 lines. Do not explain. Close every bracket and the code fence.`,
          },
        },
      });
      return;
    }
    if (state.pendingTriggerCount > 0 && runtime.inflight() === null) {
      await emitScheduledAndKickoff({ runtime, append, state });
      return;
    }
    if (state.pendingTriggerCount === 0 && runtime.inflight() === null) {
      await emitAgentStatus({
        append,
        status: "idle",
        reason: "events.iterate.com/agent/request-failed",
        requestId: String(event.payload?.requestId ?? ""),
      });
    }
    return;
  }

  if (event.type === "events.iterate.com/agent/input-added") {
    if (event.offset == null) return;
    const trigger = resolveTrigger(event.payload ?? {});
    await handleUserInput({ runtime, append, state, trigger });
    return;
  }

  if (event.type === "events.iterate.com/agent/request-completed") {
    if (event.offset != null) {
      await appendEventTypeExplanation({ append, eventType: event.type });
      await appendRewrite({
        append,
        content: eventBlock({
          offset: event.offset,
          type: event.type,
          fields: {
            requestId: String(event.payload?.requestId ?? ""),
            durationMs: Number(event.payload?.durationMs ?? 0),
          },
        }),
      });
    }
    if (state.pendingTriggerCount > 0 && runtime.inflight() === null) {
      await emitScheduledAndKickoff({ runtime, append, state });
      return;
    }
    if (state.pendingTriggerCount === 0 && runtime.inflight() === null) {
      await emitAgentStatus({
        append,
        status: "idle",
        reason: "events.iterate.com/agent/request-completed",
        requestId: String(event.payload?.requestId ?? ""),
      });
    }
    return;
  }

  if (event.type === "events.iterate.com/agent/request-cancelled") {
    if (event.offset != null) {
      await appendEventTypeExplanation({ append, eventType: event.type });
      await appendRewrite({
        append,
        content: eventBlock({
          offset: event.offset,
          type: event.type,
          fields: {
            requestId: String(event.payload?.requestId ?? ""),
            reason: String(event.payload?.reason ?? ""),
          },
        }),
      });
    }
    if (state.pendingTriggerCount > 0 && runtime.inflight() === null) {
      await emitScheduledAndKickoff({ runtime, append, state });
      return;
    }
    if (state.pendingTriggerCount === 0 && runtime.inflight() === null) {
      await emitAgentStatus({
        append,
        status: "idle",
        reason: "events.iterate.com/agent/request-cancelled",
        requestId: String(event.payload?.requestId ?? ""),
      });
    }
  }
}
