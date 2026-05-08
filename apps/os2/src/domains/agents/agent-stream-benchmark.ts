import { STREAM_SUBSCRIPTION_CONFIGURED_TYPE } from "@iterate-com/shared/streams/core-event-types";
import type { Event, EventInput } from "@iterate-com/shared/streams/types";

export type AgentStreamBenchmarkTraffic =
  | "raw-openai-ws"
  | "mixed-control"
  | "agent-chat-responses";

export type AgentStreamBenchmarkOptions = {
  benchmarkId: string;
  concurrency: number;
  count: number;
  payloadBytes: number;
  ratePerSecond: number;
  traffic: AgentStreamBenchmarkTraffic;
};

export type AgentStreamBenchmarkAppendResult = {
  appendLatencyMs: number;
  event: Event;
};

export type AgentStreamBenchmarkSummary = {
  count: number;
  max: number;
  mean: number;
  min: number;
  p50: number;
  p90: number;
  p99: number;
} | null;

export async function appendAgentStreamBenchmarkTraffic(input: {
  append(event: EventInput): Promise<Event>;
  options: AgentStreamBenchmarkOptions;
}) {
  const intervalMs = 1000 / input.options.ratePerSecond;
  const startedAt = performance.now();
  const inFlight = new Set<Promise<AgentStreamBenchmarkAppendResult>>();
  const appended: AgentStreamBenchmarkAppendResult[] = [];

  for (let index = 0; index < input.options.count; index += 1) {
    const dueAt = startedAt + index * intervalMs;
    await delay(Math.max(0, dueAt - performance.now()));

    const promise = appendOne({
      append: input.append,
      event: agentStreamBenchmarkEvent({
        index,
        options: input.options,
      }),
    }).finally(() => {
      inFlight.delete(promise);
    });
    inFlight.add(promise);
    promise.then((event) => appended.push(event)).catch(() => undefined);

    if (inFlight.size >= input.options.concurrency) {
      await Promise.race(inFlight);
    }
  }

  while (inFlight.size > 0) {
    await Promise.race(inFlight);
  }

  return appended.toSorted((left, right) => left.event.offset - right.event.offset);
}

export async function appendAgentStreamBenchmarkTerminalEvents(input: {
  append(event: EventInput): Promise<Event>;
  benchmarkId: string;
}) {
  const terminalEvents: EventInput[] = [
    {
      type: "events.iterate.com/agent-chat/assistant-response-added",
      payload: {
        channel: "web",
        message: `benchmark terminal agent-chat ${input.benchmarkId}`,
      },
      metadata: agentStreamBenchmarkMetadata(input.benchmarkId, "terminal-agent-chat"),
    },
    {
      type: "events.iterate.com/agent/system-prompt-updated",
      payload: {
        systemPrompt: `Benchmark terminal agent prompt ${input.benchmarkId}`,
      },
      metadata: agentStreamBenchmarkMetadata(input.benchmarkId, "terminal-agent"),
    },
    {
      type: "events.iterate.com/openai-ws/config-updated",
      payload: {
        model: "gpt-5.5",
      },
      metadata: agentStreamBenchmarkMetadata(input.benchmarkId, "terminal-openai-ws"),
    },
  ];

  const appended: AgentStreamBenchmarkAppendResult[] = [];
  for (const event of terminalEvents) {
    appended.push(await appendOne({ append: input.append, event }));
  }
  return appended;
}

export function agentStreamBenchmarkWebSocketSubscriptionEvent(input: {
  agentDurableObjectName: string;
  agentPath: string;
  projectId: string;
}) {
  return {
    type: STREAM_SUBSCRIPTION_CONFIGURED_TYPE,
    idempotencyKey: `stream-processor-websocket-subscription:AGENT:${input.agentDurableObjectName}:${input.agentPath}:agent:${input.projectId}:${input.agentPath}`,
    payload: {
      slug: agentStreamBenchmarkSubscriptionSlug(input),
      type: "websocket",
      callable: {
        type: "fetch",
        via: {
          type: "env-binding",
          bindingType: "durable-object-namespace",
          bindingName: "AGENT",
          durableObject: {
            name: input.agentDurableObjectName,
          },
        },
        fetchRequest: {
          path: {
            base: "/stream-subscription",
            mode: "replace",
          },
        },
      },
    },
  } satisfies EventInput;
}

export function agentStreamBenchmarkTargetOffsetByProcessor(
  events: readonly AgentStreamBenchmarkAppendResult[],
) {
  const targets = new Map<string, number>();
  for (const item of events) {
    if (item.event.type === "events.iterate.com/agent-chat/assistant-response-added") {
      targets.set("agent-chat", item.event.offset);
    }
    if (item.event.type === "events.iterate.com/agent/system-prompt-updated") {
      targets.set("agent", item.event.offset);
    }
    if (item.event.type === "events.iterate.com/openai-ws/config-updated") {
      targets.set("openai-ws", item.event.offset);
    }
  }
  return targets;
}

export function summarizeAgentStreamBenchmark(values: readonly number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: sorted.length,
    max: round(sorted.at(-1) ?? 0),
    mean: round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
    min: round(sorted[0] ?? 0),
    p50: round(percentile(sorted, 0.5)),
    p90: round(percentile(sorted, 0.9)),
    p99: round(percentile(sorted, 0.99)),
  };
}

export function agentStreamBenchmarkCreatedAtGaps(events: readonly Event[]) {
  const sorted = [...events].sort((left, right) => left.offset - right.offset);
  const gaps: number[] = [];
  for (let index = 1; index < sorted.length; index += 1) {
    gaps.push(
      new Date(sorted[index]?.createdAt ?? 0).getTime() -
        new Date(sorted[index - 1]?.createdAt ?? 0).getTime(),
    );
  }
  return gaps;
}

export function isAgentStreamBenchmarkEvent(input: { benchmarkId: string; event: Event }) {
  const metadata = input.event.metadata as { benchmark?: { id?: unknown } } | undefined;
  return metadata?.benchmark?.id === input.benchmarkId;
}

function agentStreamBenchmarkEvent(input: {
  index: number;
  options: AgentStreamBenchmarkOptions;
}): EventInput {
  const padding = "x".repeat(input.options.payloadBytes);
  if (input.options.traffic === "agent-chat-responses") {
    return {
      type: "events.iterate.com/agent-chat/assistant-response-added",
      payload: {
        channel: "web",
        message: `benchmark response ${input.index} ${padding}`,
      },
      metadata: agentStreamBenchmarkMetadata(input.options.benchmarkId, input.index),
    };
  }

  if (input.options.traffic === "mixed-control") {
    if (input.index % 20 === 0) {
      return {
        type: "events.iterate.com/agent/system-prompt-updated",
        payload: {
          systemPrompt: `Benchmark prompt ${input.index} ${padding}`,
        },
        metadata: agentStreamBenchmarkMetadata(input.options.benchmarkId, input.index),
      };
    }
    if (input.index % 20 === 10) {
      return {
        type: "events.iterate.com/openai-ws/config-updated",
        payload: {
          model: "gpt-5.5",
        },
        metadata: agentStreamBenchmarkMetadata(input.options.benchmarkId, input.index),
      };
    }
  }

  return {
    type: "events.iterate.com/openai-ws/websocket-message-received",
    payload: {
      connectionId: input.options.benchmarkId,
      sequence: input.index,
      message: {
        type: "response.output_text.delta",
        delta: padding || String(input.index),
      },
    },
    metadata: agentStreamBenchmarkMetadata(input.options.benchmarkId, input.index),
  };
}

function agentStreamBenchmarkSubscriptionSlug(input: { agentPath: string; projectId: string }) {
  return `agent:${input.projectId}:${input.agentPath}`;
}

function agentStreamBenchmarkMetadata(benchmarkId: string, index: number | string) {
  return {
    benchmark: {
      id: benchmarkId,
      index,
      sentAtMs: Date.now(),
    },
  };
}

async function appendOne(input: {
  append(event: EventInput): Promise<Event>;
  event: EventInput;
}): Promise<AgentStreamBenchmarkAppendResult> {
  const startedAt = performance.now();
  const event = await input.append(input.event);
  return {
    appendLatencyMs: performance.now() - startedAt,
    event,
  };
}

function percentile(sorted: readonly number[], point: number) {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * point) - 1));
  return sorted[index] ?? 0;
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}

async function delay(ms: number) {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}
