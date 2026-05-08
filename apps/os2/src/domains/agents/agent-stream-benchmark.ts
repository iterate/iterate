import { STREAM_SUBSCRIPTION_CONFIGURED_TYPE } from "@iterate-com/shared/streams/core-event-types";
import type { Event, EventInput } from "@iterate-com/shared/streams/types";

export type AgentStreamBenchmarkTraffic =
  | "raw-openai-ws"
  | "mixed-control"
  | "agent-chat-responses"
  | "agent-inputs"
  | "agent-status-updates";

export type AgentStreamBenchmarkOptions = {
  appendBatchSize: number;
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

export type AgentStreamBenchmarkAppendFailure = {
  appendLatencyMs: number;
  error: {
    message: string;
    name?: string;
    stack?: string;
  };
  event: {
    benchmarkIndex: number | string | null;
    type: string;
  };
};

export type AgentStreamBenchmarkAppendTrafficResult = {
  appended: AgentStreamBenchmarkAppendResult[];
  failures: AgentStreamBenchmarkAppendFailure[];
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

export function isAgentStreamBenchmarkPath(agentPath: string) {
  return agentPath.startsWith("/agents/server-bench-") || agentPath.startsWith("/agents/bench-");
}

export async function appendAgentStreamBenchmarkTraffic(input: {
  append(event: EventInput): Promise<Event>;
  appendBatch?(events: EventInput[]): Promise<Event[]>;
  options: AgentStreamBenchmarkOptions;
}): Promise<AgentStreamBenchmarkAppendTrafficResult> {
  if (input.options.appendBatchSize > 1 && input.appendBatch != null) {
    return await appendAgentStreamBenchmarkTrafficBatches({
      appendBatch: input.appendBatch,
      options: input.options,
    });
  }

  const intervalMs = 1000 / input.options.ratePerSecond;
  const startedAt = performance.now();
  const inFlight = new Set<Promise<AgentStreamBenchmarkAppendAttempt>>();
  const appended: AgentStreamBenchmarkAppendResult[] = [];
  const failures: AgentStreamBenchmarkAppendFailure[] = [];

  for (let index = 0; index < input.options.count; index += 1) {
    const dueAt = startedAt + index * intervalMs;
    await delay(Math.max(0, dueAt - performance.now()));

    const promise = appendOneAttempt({
      append: input.append,
      event: agentStreamBenchmarkEvent({
        index,
        options: input.options,
      }),
    }).finally(() => {
      inFlight.delete(promise);
    });
    inFlight.add(promise);
    promise.then((attempt) => {
      if (attempt.status === "fulfilled") {
        appended.push(attempt.result);
      } else {
        failures.push(attempt.failure);
      }
    });

    if (inFlight.size >= input.options.concurrency) {
      await Promise.race(inFlight);
    }
  }

  while (inFlight.size > 0) {
    await Promise.race(inFlight);
  }

  return {
    appended: appended.toSorted((left, right) => left.event.offset - right.event.offset),
    failures,
  };
}

async function appendAgentStreamBenchmarkTrafficBatches(input: {
  appendBatch(events: EventInput[]): Promise<Event[]>;
  options: AgentStreamBenchmarkOptions;
}): Promise<AgentStreamBenchmarkAppendTrafficResult> {
  const batchSize = Math.max(1, input.options.appendBatchSize);
  const batchIntervalMs = (1000 * batchSize) / input.options.ratePerSecond;
  const startedAt = performance.now();
  const inFlight = new Set<Promise<AgentStreamBenchmarkAppendBatchAttempt>>();
  const appended: AgentStreamBenchmarkAppendResult[] = [];
  const failures: AgentStreamBenchmarkAppendFailure[] = [];

  for (let index = 0; index < input.options.count; index += batchSize) {
    const batchIndex = Math.floor(index / batchSize);
    const dueAt = startedAt + batchIndex * batchIntervalMs;
    await delay(Math.max(0, dueAt - performance.now()));
    const events = Array.from(
      { length: Math.min(batchSize, input.options.count - index) },
      (_, offset) =>
        agentStreamBenchmarkEvent({
          index: index + offset,
          options: input.options,
        }),
    );

    const promise = appendBatchAttempt({
      appendBatch: input.appendBatch,
      events,
    }).finally(() => {
      inFlight.delete(promise);
    });
    inFlight.add(promise);
    promise.then((attempt) => {
      if (attempt.status === "fulfilled") {
        appended.push(...attempt.results);
      } else {
        failures.push(...attempt.failures);
      }
    });

    if (inFlight.size >= input.options.concurrency) {
      await Promise.race(inFlight);
    }
  }

  while (inFlight.size > 0) {
    await Promise.race(inFlight);
  }

  return {
    appended: appended.toSorted((left, right) => left.event.offset - right.event.offset),
    failures,
  };
}

export async function appendAgentStreamBenchmarkTerminalEvents(input: {
  append(event: EventInput): Promise<Event>;
  benchmarkId: string;
}): Promise<AgentStreamBenchmarkAppendTrafficResult> {
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
  const failures: AgentStreamBenchmarkAppendFailure[] = [];
  for (const event of terminalEvents) {
    const attempt = await appendOneAttempt({ append: input.append, event });
    if (attempt.status === "fulfilled") {
      appended.push(attempt.result);
    } else {
      failures.push(attempt.failure);
    }
  }
  return { appended, failures };
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

export function agentStreamBenchmarkCallableSubscriptionEvent(input: {
  agentDurableObjectName: string;
  agentPath: string;
  projectId: string;
}) {
  const rpcMethod = "afterAppendBatch";
  const slug = agentStreamBenchmarkSubscriptionSlug(input);
  return {
    type: STREAM_SUBSCRIPTION_CONFIGURED_TYPE,
    idempotencyKey: `stream-processor-callable-subscription:AGENT:${input.agentDurableObjectName}:${input.agentPath}:${slug}:${rpcMethod}`,
    payload: {
      slug,
      type: "callable",
      callable: {
        type: "workers-rpc",
        via: {
          type: "env-binding",
          bindingType: "durable-object-namespace",
          bindingName: "AGENT",
          durableObject: {
            name: input.agentDurableObjectName,
          },
        },
        rpcMethod,
        argsMode: "object",
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

  if (input.options.traffic === "agent-inputs") {
    return {
      type: "events.iterate.com/agent/input-added",
      payload: {
        content: `benchmark agent input ${input.index} ${padding}`,
        triggerLlmRequest: { behaviour: "dont-trigger-request" },
      },
      metadata: agentStreamBenchmarkMetadata(input.options.benchmarkId, input.index),
    };
  }

  if (input.options.traffic === "agent-status-updates") {
    return {
      type: "events.iterate.com/agent/status-updated",
      payload: {
        reason: `benchmark status ${input.index} ${padding}`,
        status: input.index % 2 === 0 ? "working" : "idle",
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

type AgentStreamBenchmarkAppendAttempt =
  | {
      result: AgentStreamBenchmarkAppendResult;
      status: "fulfilled";
    }
  | {
      failure: AgentStreamBenchmarkAppendFailure;
      status: "rejected";
    };

type AgentStreamBenchmarkAppendBatchAttempt =
  | {
      results: AgentStreamBenchmarkAppendResult[];
      status: "fulfilled";
    }
  | {
      failures: AgentStreamBenchmarkAppendFailure[];
      status: "rejected";
    };

async function appendOneAttempt(input: {
  append(event: EventInput): Promise<Event>;
  event: EventInput;
}): Promise<AgentStreamBenchmarkAppendAttempt> {
  const startedAt = performance.now();
  try {
    return {
      result: await appendOne(input),
      status: "fulfilled",
    };
  } catch (error) {
    return {
      failure: {
        appendLatencyMs: performance.now() - startedAt,
        error: serializeError(error),
        event: {
          benchmarkIndex: readBenchmarkIndex(input.event),
          type: input.event.type,
        },
      },
      status: "rejected",
    };
  }
}

async function appendBatchAttempt(input: {
  appendBatch(events: EventInput[]): Promise<Event[]>;
  events: EventInput[];
}): Promise<AgentStreamBenchmarkAppendBatchAttempt> {
  const startedAt = performance.now();
  try {
    const events = await input.appendBatch(input.events);
    const appendLatencyMs = performance.now() - startedAt;
    return {
      results: events.map((event) => ({
        appendLatencyMs,
        event,
      })),
      status: "fulfilled",
    };
  } catch (error) {
    const appendLatencyMs = performance.now() - startedAt;
    return {
      failures: input.events.map((event) => ({
        appendLatencyMs,
        error: serializeError(error),
        event: {
          benchmarkIndex: readBenchmarkIndex(event),
          type: event.type,
        },
      })),
      status: "rejected",
    };
  }
}

function readBenchmarkIndex(event: EventInput) {
  const metadata = event.metadata as { benchmark?: { index?: unknown } } | undefined;
  const index = metadata?.benchmark?.index;
  if (typeof index === "string" || typeof index === "number") return index;
  return null;
}

function serializeError(error: unknown): AgentStreamBenchmarkAppendFailure["error"] {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack,
    };
  }

  return {
    message: String(error),
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
