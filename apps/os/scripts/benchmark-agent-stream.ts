import { createORPCClient } from "@orpc/client";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import type { RouterClient } from "@orpc/server";
import { osContract } from "@iterate-com/os-contract";
import type { Event, EventInput } from "@iterate-com/shared/streams/types";
import type { appRouter } from "~/orpc/root.ts";

type OrpcClient = RouterClient<typeof appRouter>;

type TrafficKind = "raw-openai-ws" | "mixed-control" | "agent-chat-responses";

type Options = {
  agentPath: string;
  baseUrl: string;
  concurrency: number;
  count: number;
  createProject: boolean;
  payloadBytes: number;
  projectSlugOrId: string | null;
  ratePerSecond: number;
  terminalEvents: boolean;
  traffic: TrafficKind;
};

type RuntimeState = {
  entries?: Array<{
    afterAppendCompletedThroughOffset: number;
    processorSlug: string;
    reducedThroughOffset: number;
    streamPath: string;
  }>;
};

const BENCHMARK_EVENT_TYPES = new Set([
  "events.iterate.com/openai-ws/websocket-message-received",
  "events.iterate.com/openai-ws/config-updated",
  "events.iterate.com/agent/system-prompt-updated",
  "events.iterate.com/agent-chat/assistant-response-added",
]);

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const client = createClient(options.baseUrl);
  const benchmarkId = `agent-stream-bench-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const projectSlugOrId = options.createProject
    ? (await createBenchmarkProject(client, benchmarkId)).id
    : requireProjectSlugOrId(options.projectSlugOrId);

  console.log(JSON.stringify({ benchmarkId, options: { ...options, projectSlugOrId } }, null, 2));

  await client.project.agents.runtimeState({
    agentPath: options.agentPath,
    projectSlugOrId,
  });

  const appended = await appendTrafficAtRate({
    benchmarkId,
    client,
    options,
    projectSlugOrId,
  });
  const terminal = options.terminalEvents
    ? await appendTerminalEvents({ benchmarkId, client, options, projectSlugOrId })
    : [];

  const allAppended = [...appended, ...terminal];
  const lastOffset = Math.max(...allAppended.map((item) => item.event.offset));
  const processorWait = await waitForProcessorCursors({
    agentPath: options.agentPath,
    client,
    projectSlugOrId,
    targetOffsetByProcessor: targetOffsetByProcessor(terminal),
  });
  const committed = await readBenchmarkEvents({
    agentPath: options.agentPath,
    benchmarkId,
    client,
    projectSlugOrId,
  });

  const report = {
    benchmarkId,
    stream: {
      agentPath: options.agentPath,
      projectSlugOrId,
    },
    traffic: {
      appendedCount: appended.length,
      committedBenchmarkEventCount: committed.length,
      lastOffset,
      terminalEventCount: terminal.length,
      traffic: options.traffic,
    },
    appendLatencyMs: summarize(appended.map((item) => item.appendLatencyMs)),
    terminalAppendLatencyMs: summarize(terminal.map((item) => item.appendLatencyMs)),
    committedCreatedAtGapMs: summarize(createdAtGaps(committed)),
    processorWait,
    finalRuntimeState: await client.project.agents.runtimeState({
      agentPath: options.agentPath,
      projectSlugOrId,
    }),
  };

  console.log(JSON.stringify(report, null, 2));
}

async function appendTrafficAtRate(input: {
  benchmarkId: string;
  client: OrpcClient;
  options: Options;
  projectSlugOrId: string;
}) {
  const intervalMs = 1000 / input.options.ratePerSecond;
  const startedAt = performance.now();
  const inFlight = new Set<Promise<AppendedEvent>>();
  const appended: AppendedEvent[] = [];

  for (let index = 0; index < input.options.count; index += 1) {
    const dueAt = startedAt + index * intervalMs;
    await delay(Math.max(0, dueAt - performance.now()));

    const promise = appendBenchmarkEvent({
      benchmarkId: input.benchmarkId,
      client: input.client,
      event: benchmarkEvent({
        benchmarkId: input.benchmarkId,
        index,
        options: input.options,
      }),
      projectSlugOrId: input.projectSlugOrId,
      streamPath: input.options.agentPath,
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

async function appendTerminalEvents(input: {
  benchmarkId: string;
  client: OrpcClient;
  options: Options;
  projectSlugOrId: string;
}) {
  const terminalEvents: EventInput[] = [
    {
      type: "events.iterate.com/agent-chat/assistant-response-added",
      payload: {
        channel: "web",
        message: `benchmark terminal agent-chat ${input.benchmarkId}`,
      },
      metadata: benchmarkMetadata(input.benchmarkId, "terminal-agent-chat"),
    },
    {
      type: "events.iterate.com/agent/system-prompt-updated",
      payload: {
        systemPrompt: `Benchmark terminal agent prompt ${input.benchmarkId}`,
      },
      metadata: benchmarkMetadata(input.benchmarkId, "terminal-agent"),
    },
    {
      type: "events.iterate.com/openai-ws/config-updated",
      payload: {
        model: "gpt-5.5",
      },
      metadata: benchmarkMetadata(input.benchmarkId, "terminal-openai-ws"),
    },
  ];

  const appended: AppendedEvent[] = [];
  for (const event of terminalEvents) {
    appended.push(
      await appendBenchmarkEvent({
        benchmarkId: input.benchmarkId,
        client: input.client,
        event,
        projectSlugOrId: input.projectSlugOrId,
        streamPath: input.options.agentPath,
      }),
    );
  }
  return appended;
}

function benchmarkEvent(input: {
  benchmarkId: string;
  index: number;
  options: Options;
}): EventInput {
  const padding = "x".repeat(input.options.payloadBytes);
  if (input.options.traffic === "agent-chat-responses") {
    return {
      type: "events.iterate.com/agent-chat/assistant-response-added",
      payload: {
        channel: "web",
        message: `benchmark response ${input.index} ${padding}`,
      },
      metadata: benchmarkMetadata(input.benchmarkId, input.index),
    };
  }

  if (input.options.traffic === "mixed-control") {
    if (input.index % 20 === 0) {
      return {
        type: "events.iterate.com/agent/system-prompt-updated",
        payload: {
          systemPrompt: `Benchmark prompt ${input.index} ${padding}`,
        },
        metadata: benchmarkMetadata(input.benchmarkId, input.index),
      };
    }
    if (input.index % 20 === 10) {
      return {
        type: "events.iterate.com/openai-ws/config-updated",
        payload: {
          model: "gpt-5.5",
        },
        metadata: benchmarkMetadata(input.benchmarkId, input.index),
      };
    }
  }

  return {
    type: "events.iterate.com/openai-ws/websocket-message-received",
    payload: {
      connectionId: input.benchmarkId,
      sequence: input.index,
      message: {
        type: "response.output_text.delta",
        delta: padding || String(input.index),
      },
    },
    metadata: benchmarkMetadata(input.benchmarkId, input.index),
  };
}

async function appendBenchmarkEvent(input: {
  benchmarkId: string;
  client: OrpcClient;
  event: EventInput;
  projectSlugOrId: string;
  streamPath: string;
}): Promise<AppendedEvent> {
  const startedAt = performance.now();
  const result = await input.client.project.streams.append({
    event: input.event,
    projectSlugOrId: input.projectSlugOrId,
    streamPath: input.streamPath,
  });
  return {
    appendLatencyMs: performance.now() - startedAt,
    event: result.event,
  };
}

async function waitForProcessorCursors(input: {
  agentPath: string;
  client: OrpcClient;
  projectSlugOrId: string;
  targetOffsetByProcessor: Map<string, number>;
}) {
  if (input.targetOffsetByProcessor.size === 0) {
    return { completed: false, reason: "no terminal events requested" };
  }

  const startedAt = performance.now();
  let lastState: unknown;
  while (performance.now() - startedAt < 30_000) {
    lastState = await input.client.project.agents.runtimeState({
      agentPath: input.agentPath,
      projectSlugOrId: input.projectSlugOrId,
    });
    const state = lastState as RuntimeState;
    const entries = state.entries ?? [];
    const completed = [...input.targetOffsetByProcessor].every(([processorSlug, targetOffset]) =>
      entries.some(
        (entry) =>
          entry.processorSlug === processorSlug &&
          entry.streamPath === input.agentPath &&
          entry.afterAppendCompletedThroughOffset >= targetOffset,
      ),
    );
    if (completed) {
      return {
        completed: true,
        waitMs: performance.now() - startedAt,
      };
    }
    await delay(100);
  }

  return {
    completed: false,
    reason: "timed out waiting for processor cursor targets",
    waitMs: performance.now() - startedAt,
    lastState,
  };
}

async function readBenchmarkEvents(input: {
  agentPath: string;
  benchmarkId: string;
  client: OrpcClient;
  projectSlugOrId: string;
}) {
  const result = await input.client.project.streams.read({
    afterOffset: "start",
    projectSlugOrId: input.projectSlugOrId,
    streamPath: input.agentPath,
  });
  return result.events.filter((event) => {
    if (!BENCHMARK_EVENT_TYPES.has(event.type)) return false;
    const metadata = event.metadata as { benchmark?: { id?: unknown } } | undefined;
    return metadata?.benchmark?.id === input.benchmarkId;
  });
}

function targetOffsetByProcessor(events: readonly AppendedEvent[]) {
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

function summarize(values: readonly number[]) {
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

function createdAtGaps(events: readonly Event[]) {
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

function percentile(sorted: readonly number[], point: number) {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * point) - 1));
  return sorted[index] ?? 0;
}

function benchmarkMetadata(benchmarkId: string, index: number | string) {
  return {
    benchmark: {
      id: benchmarkId,
      index,
      sentAtMs: Date.now(),
    },
  };
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}

function createClient(baseUrl: string) {
  const authHeaders = requireAuthHeaders();
  return createORPCClient(
    new OpenAPILink(osContract, {
      url: `${baseUrl}/api`,
      fetch: (input, init) => {
        const requestInit: RequestInit = init ?? {};
        const headers = new Headers(input instanceof Request ? input.headers : undefined);
        for (const [key, value] of new Headers(requestInit.headers)) headers.set(key, value);
        for (const [key, value] of Object.entries(authHeaders)) headers.set(key, value);
        if (input instanceof Request) return fetch(new Request(input, { ...requestInit, headers }));
        return fetch(input, { ...requestInit, headers });
      },
    }),
  ) as OrpcClient;
}

async function createBenchmarkProject(client: OrpcClient, benchmarkId: string) {
  return await client.projects.create({
    slug: benchmarkId,
  });
}

function requireAuthHeaders() {
  const bearerToken =
    process.env.OS_E2E_ADMIN_API_SECRET?.trim() ||
    process.env.OS_ADMIN_API_SECRET?.trim() ||
    process.env.APP_CONFIG_ADMIN_API_SECRET?.trim() ||
    process.env.OS_E2E_BEARER_TOKEN?.trim();
  const cookie = process.env.OS_E2E_COOKIE?.trim();
  if (!bearerToken && !cookie) {
    throw new Error(
      "OS_E2E_ADMIN_API_SECRET, OS_ADMIN_API_SECRET, APP_CONFIG_ADMIN_API_SECRET, OS_E2E_BEARER_TOKEN, or OS_E2E_COOKIE is required.",
    );
  }

  return {
    ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
    ...(cookie ? { Cookie: cookie } : {}),
  };
}

function parseOptions(args: readonly string[]): Options {
  const values = parseArgs(args);
  return {
    agentPath: stringOption(values, "agent-path", `/agents/bench-${Date.now()}`),
    baseUrl: stringOption(values, "base-url", process.env.APP_CONFIG_BASE_URL ?? ""),
    concurrency: numberOption(values, "concurrency", 10),
    count: numberOption(values, "count", 200),
    createProject: booleanOption(values, "create-project", true),
    payloadBytes: numberOption(values, "payload-bytes", 64),
    projectSlugOrId: optionalStringOption(values, "project"),
    ratePerSecond: numberOption(values, "rate", 50),
    terminalEvents: booleanOption(values, "terminal-events", true),
    traffic: trafficOption(values, "traffic", "raw-openai-ws"),
  };
}

function parseArgs(args: readonly string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (!arg?.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const key = rawKey ?? "";
    if (!key) throw new Error(`Invalid option: ${arg}`);
    if (inlineValue != null) {
      values.set(key, inlineValue);
      continue;
    }
    const next = args[index + 1];
    if (next == null || next.startsWith("--")) {
      values.set(key, "true");
      continue;
    }
    values.set(key, next);
    index += 1;
  }
  return values;
}

function stringOption(values: Map<string, string>, key: string, fallback: string) {
  const value = values.get(key) ?? fallback;
  if (!value.trim()) throw new Error(`--${key} is required.`);
  return value.trim();
}

function optionalStringOption(values: Map<string, string>, key: string) {
  const value = values.get(key)?.trim();
  return value ? value : null;
}

function numberOption(values: Map<string, string>, key: string, fallback: number) {
  const raw = values.get(key) ?? String(fallback);
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`--${key} must be a positive number.`);
  }
  return value;
}

function booleanOption(values: Map<string, string>, key: string, fallback: boolean) {
  const raw = values.get(key);
  if (raw == null) return fallback;
  if (["1", "true", "yes"].includes(raw)) return true;
  if (["0", "false", "no"].includes(raw)) return false;
  throw new Error(`--${key} must be true or false.`);
}

function trafficOption(values: Map<string, string>, key: string, fallback: TrafficKind) {
  const value = values.get(key) ?? fallback;
  if (value === "raw-openai-ws" || value === "mixed-control" || value === "agent-chat-responses") {
    return value;
  }
  throw new Error(`--${key} must be raw-openai-ws, mixed-control, or agent-chat-responses.`);
}

function requireProjectSlugOrId(value: string | null) {
  if (!value) throw new Error("--project is required when --create-project=false.");
  return value;
}

async function delay(ms: number) {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

type AppendedEvent = {
  appendLatencyMs: number;
  event: Event;
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
