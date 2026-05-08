import { ORPCError } from "@orpc/server";
import { listD1ObjectCatalogRecordsByIndex } from "@iterate-com/shared/durable-object-utils/mixins/with-d1-object-catalog";
import { deriveDurableObjectNameFromStructuredName } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import { getOrInitializeDoStub } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import { STREAM_SUBSCRIPTION_CONFIGURED_TYPE } from "@iterate-com/shared/streams/core-event-types";
import {
  getInitializedStreamStub,
  type StreamDurableObjectNamespace,
} from "@iterate-com/shared/streams/helpers";
import type { Event, EventInput, StreamPath } from "@iterate-com/shared/streams/types";
import type { StreamDurableObject } from "@iterate-com/shared/streams/stream-durable-object";
import {
  agentStreamBenchmarkCreatedAtGaps,
  agentStreamBenchmarkTargetOffsetByProcessor,
  agentStreamBenchmarkWebSocketSubscriptionEvent,
  appendAgentStreamBenchmarkTerminalEvents,
  appendAgentStreamBenchmarkTraffic,
  isAgentStreamBenchmarkEvent,
  summarizeAgentStreamBenchmark,
  type AgentStreamBenchmarkAppendResult,
  type AgentStreamBenchmarkOptions,
  type AgentStreamBenchmarkAppendFailure,
} from "~/domains/agents/agent-stream-benchmark.ts";
import {
  defaultAgentSetupEvents,
  normalizeAgentPresetBasePath,
  presetConfiguredEvent,
  readAgentPathPrefixPresets,
  type AgentLlmProvider,
} from "~/domains/agents/agent-presets.ts";
import {
  type AgentDurableObject,
  type AgentDurableObjectStructuredName,
  AGENTS_STREAM_PATH,
  getAgentDurableObjectName,
} from "~/domains/agents/durable-objects/agent-durable-object.ts";
import { os, projectScopeMiddleware } from "~/orpc/orpc.ts";
import { requireProjectScope } from "~/orpc/project-access.ts";

export const projectAgentsRouter = {
  list: os.project.agents.list.use(projectScopeMiddleware).handler(async ({ context }) => {
    const project = requireProjectScope(context);
    if (!context.doCatalog) {
      throw new ORPCError("INTERNAL_SERVER_ERROR", {
        message: "DO catalog binding not available.",
      });
    }

    const records = await listD1ObjectCatalogRecordsByIndex<AgentDurableObjectStructuredName>(
      context.doCatalog,
      {
        className: "AgentDurableObject",
        indexName: "projectId",
        indexValue: project.id,
      },
    );

    return {
      agents: records
        .filter((record) => record.structuredName.agentPath.startsWith("/agents/"))
        .map((record) => ({
          agentPath: record.structuredName.agentPath,
          createdAt: record.createdAt,
          lastWokenAt: record.lastWokenAt,
          name: record.name,
          projectId: record.structuredName.projectId,
        })),
    };
  }),

  listPresets: os.project.agents.listPresets
    .use(projectScopeMiddleware)
    .handler(async ({ context }) => {
      const project = requireProjectScope(context);
      const events = await readAgentsRootEvents({ context, projectId: project.id });
      return {
        presets: readAgentPathPrefixPresets(events),
      };
    }),

  configurePreset: os.project.agents.configurePreset
    .use(projectScopeMiddleware)
    .handler(async ({ context, input }) => {
      const project = requireProjectScope(context);
      const basePath = normalizeAgentPresetBasePath(input.basePath);
      const events = [
        ...defaultAgentSetupEvents(input.provider as AgentLlmProvider).map((event) =>
          input.provider === "openai-ws" &&
          event.type === "events.iterate.com/openai-ws/config-updated"
            ? { ...event, payload: { model: input.model } }
            : input.provider === "cloudflare-ai" &&
                event.type === "events.iterate.com/agent/llm-config-updated"
              ? {
                  ...event,
                  payload: {
                    debounceMs: 1000,
                    model: input.model,
                    runOpts: input.runOpts,
                  },
                }
              : event.type === "events.iterate.com/agent/system-prompt-updated"
                ? { ...event, payload: { systemPrompt: input.systemPrompt } }
                : event,
        ),
        ...input.events,
      ];
      await appendAgentsRootEvent({
        context,
        event: presetConfiguredEvent({ basePath, events }),
        projectId: project.id,
      });
      return { basePath, eventCount: events.length };
    }),

  sendMessage: os.project.agents.sendMessage
    .use(projectScopeMiddleware)
    .handler(async ({ context, input }) => {
      const project = requireProjectScope(context);
      const agent = await getAgentStub({
        context,
        agentPath: input.agentPath,
        projectId: project.id,
      });
      return await agent.sendMessage({
        channel: input.channel,
        message: input.message,
      });
    }),

  runtimeState: os.project.agents.runtimeState
    .use(projectScopeMiddleware)
    .handler(async ({ context, input }) => {
      const project = requireProjectScope(context);
      const agent = await getAgentStub({
        context,
        agentPath: input.agentPath,
        projectId: project.id,
      });
      return await agent.getRuntimeState();
    }),

  benchmarkStream: os.project.agents.benchmarkStream
    .use(projectScopeMiddleware)
    .handler(async ({ context, input }) => {
      const project = requireProjectScope(context);
      const benchmarkId = `agent-server-bench-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
      const agent = await getAgentStub({
        context,
        agentPath: input.agentPath,
        projectId: project.id,
      });
      const agentWarmupStartedAt = performance.now();
      const initialRuntimeState = await agent.getRuntimeState();
      const agentWarmupDurationMs = performance.now() - agentWarmupStartedAt;

      const stream = await getInitializedStreamStub({
        durableObjectNamespace: requireStreamNamespace(context),
        namespace: project.id,
        path: input.agentPath,
      });
      const benchmarkStream = stream as unknown as BenchmarkStreamStub;
      const agentDurableObjectName = getAgentDurableObjectName({
        agentPath: input.agentPath,
        projectId: project.id,
      });

      if (input.subscriptionTransport === "websocket") {
        await stream.append(
          agentStreamBenchmarkWebSocketSubscriptionEvent({
            agentDurableObjectName,
            agentPath: input.agentPath,
            projectId: project.id,
          }),
        );
      }
      await configureBenchmarkSubscriberMode({
        agentDurableObjectName,
        agentPath: input.agentPath,
        codemodeSessionName: deriveDurableObjectNameFromStructuredName({
          structuredName: { projectId: project.id, streamPath: input.agentPath },
        }),
        mode: input.subscriberMode,
        projectId: project.id,
        stream: benchmarkStream,
      });

      const options: AgentStreamBenchmarkOptions = {
        benchmarkId,
        concurrency: input.concurrency,
        count: input.count,
        payloadBytes: input.payloadBytes,
        ratePerSecond: input.ratePerSecond,
        traffic: input.traffic,
      };

      const startedAt = performance.now();
      const published =
        input.publisher === "agent-durable-object"
          ? await agent.runStreamBenchmark({
              options,
              terminalEvents: input.terminalEvents,
            })
          : await runAppWorkerBenchmarkPublisher({
              options,
              stream: benchmarkStream,
              terminalEvents: input.terminalEvents,
            });
      const publishDurationMs = performance.now() - startedAt;
      const sourceSubscriberWait = await waitForCallableSubscriberCursors({
        stream: benchmarkStream,
        targetOffset: agentStreamBenchmarkTargetOffset(published),
      });

      const processorWait =
        input.subscriberMode === "codemode-only" || input.subscriberMode === "agent-noop-only"
          ? {
              completed: false,
              reason: `skipped because Agent processors are disabled for ${input.subscriberMode} benchmark`,
            }
          : await waitForProcessorCursors({
              agent,
              agentPath: input.agentPath,
              targetOffsetByProcessor: agentStreamBenchmarkTargetOffsetByProcessor(
                published.terminal,
              ),
            });
      const history = await stream.history({ after: "start" });
      const benchmarkEvents = history.filter((event) =>
        isAgentStreamBenchmarkEvent({ benchmarkId, event }),
      );
      let runtimeState = await agent.getRuntimeState();
      let streamState = await stream.getState();
      const finalSubscriberWait = await waitForCallableSubscriberCursors({
        stream: benchmarkStream,
        targetOffset: streamState.eventCount,
      });
      runtimeState = await agent.getRuntimeState();
      streamState = await stream.getState();
      const streamDiagnostics = await benchmarkStream.getDiagnostics();

      return {
        benchmarkId,
        agentWarmupDurationMs: round(agentWarmupDurationMs),
        initialRuntimeState,
        publisher: input.publisher,
        subscriberMode: input.subscriberMode,
        subscriptionTransport: input.subscriptionTransport,
        publishDurationMs: round(publishDurationMs),
        traffic: {
          appendedCount: published.appended.length,
          appendFailureCount: published.failures.length,
          benchmarkEventCount: benchmarkEvents.length,
          idempotencyCommittedEventCount: streamDiagnostics.idempotencyCommittedEventCount,
          idempotencyDuplicateAttemptCount: streamDiagnostics.idempotencyDuplicateAttemptCount,
          idempotencyDuplicateKeyCount: streamDiagnostics.idempotencyDuplicateKeyCount,
          idempotencyLogicalAppendAttemptCount:
            streamDiagnostics.idempotencyLogicalAppendAttemptCount,
          terminalEventCount: published.terminal.length,
          traffic: input.traffic,
        },
        appendFailures: published.failures.slice(0, 25),
        appendLatencyMs: summarizeAgentStreamBenchmark(
          published.appended.map((event) => event.appendLatencyMs),
        ),
        terminalAppendLatencyMs: summarizeAgentStreamBenchmark(
          published.terminal.map((event) => event.appendLatencyMs),
        ),
        committedCreatedAtGapMs: summarizeAgentStreamBenchmark(
          agentStreamBenchmarkCreatedAtGaps(benchmarkEvents),
        ),
        sourceSubscriberWait,
        finalSubscriberWait,
        processorWait,
        runtimeState,
        streamDiagnostics,
        streamSubscribers: streamState.processors["external-subscriber"].subscribersBySlug,
      };
    }),
};

type AgentRpcStub = {
  getRuntimeState(): Promise<unknown>;
  runStreamBenchmark(input: {
    options: AgentStreamBenchmarkOptions;
    terminalEvents: boolean;
  }): Promise<{
    appended: AgentStreamBenchmarkAppendResult[];
    failures: AgentStreamBenchmarkAppendFailure[];
    terminal: AgentStreamBenchmarkAppendResult[];
  }>;
  sendMessage(input: { channel?: string; message: string }): Promise<{
    event: Event;
  }>;
};

type RuntimeState = {
  entries?: Array<{
    afterAppendCompletedThroughOffset: number;
    processorSlug: string;
    streamPath: string;
  }>;
};

async function readAgentsRootEvents(input: {
  context: { stream?: DurableObjectNamespace<StreamDurableObject> };
  projectId: string;
}) {
  const stream = await getAgentsRootStream(input);
  return await stream.history({ before: "end" });
}

async function appendAgentsRootEvent(input: {
  context: { stream?: DurableObjectNamespace<StreamDurableObject> };
  event: EventInput;
  projectId: string;
}) {
  const stream = await getAgentsRootStream(input);
  return await stream.append(input.event);
}

async function getAgentsRootStream(input: {
  context: { stream?: DurableObjectNamespace<StreamDurableObject> };
  projectId: string;
}) {
  if (!input.context.stream) {
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: "STREAM Durable Object namespace is not configured.",
    });
  }

  return await getInitializedStreamStub({
    durableObjectNamespace: input.context.stream as unknown as StreamDurableObjectNamespace,
    namespace: input.projectId,
    path: AGENTS_STREAM_PATH,
  });
}

function requireStreamNamespace(context: { stream?: DurableObjectNamespace<StreamDurableObject> }) {
  if (!context.stream) {
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: "STREAM Durable Object namespace is not configured.",
    });
  }
  return context.stream as unknown as StreamDurableObjectNamespace;
}

type BenchmarkStreamStub = {
  append(event: EventInput): Promise<Event>;
  getDiagnostics(): Promise<{
    callableSubscriberCursors: Array<{
      cursor: number;
      subscriberSlug: string;
    }>;
    appendBatchDiagnostics: Array<{
      afterAppendDurationMs: number;
      buildReduceDurationMs: number;
      commitDurationMs: number;
      committedEventCount: number;
      completedAtMs: number;
      duplicateEventCount: number;
      error?: string;
      firstCommittedOffset: number | null;
      inputEventCount: number;
      lastCommittedOffset: number | null;
      parseDurationMs: number;
      totalDurationMs: number;
    }>;
    callableSubscriberAlarmDiagnostic: {
      coalescedWhileActiveCount: number;
      coalescedWhileScheduledCount: number;
      scheduleRequestCount: number;
      setAlarmCount: number;
      setAlarmErrorCount: number;
    };
    callableSubscriberDeliveries: Array<{
      batchIterations: number;
      completedAtMs: number;
      cursorReadCount: number;
      cursorWriteCount: number;
      deliveredEventCount: number;
      durationMs: number;
      emptyWindowCount: number;
      error?: string;
      failedEventCount: number;
      historyReadCount: number;
      rescheduled: boolean;
      startedAtMs: number;
      subscriberCheckCount: number;
      subscriberDeliveries: Array<{
        beforeOffset: number;
        completedAtMs: number;
        cursor: number;
        deliveredEventCount: number;
        dispatchDurationMs: number;
        durationMs: number;
        failedEventCount: number;
        filterDurationMs: number;
        historyEventCount: number;
        subscriberSlug: string;
      }>;
      targetEventCount: number;
      uniqueHistoryWindowCount: number;
      yielded: boolean;
    }>;
    idempotencyCommittedEventCount: number;
    idempotencyDuplicateAttemptCount: number;
    idempotencyDuplicateKeyCount: number;
    idempotencyLogicalAppendAttemptCount: number;
    idempotencyDuplicateTopKeys: Array<{
      duplicateAttempts: number;
      eventType: string;
      firstDuplicateAtMs: number;
      idempotencyKey: string;
      lastDuplicateAtMs: number;
      streamPath: string;
      targetOffset: number;
    }>;
    idempotencyDuplicates: Array<{
      duplicateAttempts: number;
      eventType: string;
      firstDuplicateAtMs: number;
      idempotencyKey: string;
      lastDuplicateAtMs: number;
      streamPath: string;
      targetOffset: number;
    }>;
  }>;
};

async function runAppWorkerBenchmarkPublisher(input: {
  options: AgentStreamBenchmarkOptions;
  stream: BenchmarkStreamStub;
  terminalEvents: boolean;
}) {
  const traffic = await appendAgentStreamBenchmarkTraffic({
    append: async (event) => await input.stream.append(event),
    options: input.options,
  });
  const terminal = input.terminalEvents
    ? await appendAgentStreamBenchmarkTerminalEvents({
        append: async (event) => await input.stream.append(event),
        benchmarkId: input.options.benchmarkId,
      })
    : { appended: [], failures: [] };
  return {
    appended: traffic.appended,
    failures: [...traffic.failures, ...terminal.failures],
    terminal: terminal.appended,
  };
}

async function configureBenchmarkSubscriberMode(input: {
  agentDurableObjectName: string;
  agentPath: StreamPath;
  codemodeSessionName: string;
  mode: "both" | "agent-only" | "agent-noop-only" | "codemode-only";
  projectId: string;
  stream: BenchmarkStreamStub;
}) {
  if (input.mode === "both") return;

  if (input.mode === "codemode-only" || input.mode === "agent-noop-only") {
    await input.stream.append(disabledAgentSubscriberEvent(input));
  }

  if (input.mode === "agent-only" || input.mode === "agent-noop-only") {
    await input.stream.append(disabledCodemodeSubscriberEvent(input));
  }

  if (input.mode === "agent-noop-only") {
    await input.stream.append(noopAgentSubscriberEvent(input));
  }
}

function disabledAgentSubscriberEvent(input: {
  agentDurableObjectName: string;
  agentPath: StreamPath;
  projectId: string;
}): EventInput {
  return {
    payload: {
      slug: `agent:${input.projectId}:${input.agentPath}`,
      type: "callable",
      jsonataFilter: "false",
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
        rpcMethod: "afterAppendBatch",
        argsMode: "object",
      },
    },
    type: STREAM_SUBSCRIPTION_CONFIGURED_TYPE,
  };
}

function disabledCodemodeSubscriberEvent(input: { codemodeSessionName: string }): EventInput {
  return {
    payload: {
      slug: `codemode-session:${input.codemodeSessionName}`,
      type: "callable",
      jsonataFilter: "false",
      callable: {
        type: "workers-rpc",
        via: {
          type: "env-binding",
          bindingType: "durable-object-namespace",
          bindingName: "CODEMODE_SESSION",
          durableObject: {
            name: input.codemodeSessionName,
          },
        },
        rpcMethod: "afterAppendBatch",
        argsMode: "object",
      },
    },
    type: STREAM_SUBSCRIPTION_CONFIGURED_TYPE,
  };
}

function noopAgentSubscriberEvent(input: {
  agentDurableObjectName: string;
  agentPath: StreamPath;
  projectId: string;
}): EventInput {
  return {
    payload: {
      slug: `agent-noop:${input.projectId}:${input.agentPath}`,
      type: "callable",
      jsonataFilter: "true",
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
        rpcMethod: "afterAppendBatch",
        argsMode: "object",
      },
    },
    type: STREAM_SUBSCRIPTION_CONFIGURED_TYPE,
  };
}

function agentStreamBenchmarkTargetOffset(input: {
  appended: AgentStreamBenchmarkAppendResult[];
  terminal: AgentStreamBenchmarkAppendResult[];
}) {
  return Math.max(
    0,
    ...input.appended.map((item) => item.event.offset),
    ...input.terminal.map((item) => item.event.offset),
  );
}

async function waitForCallableSubscriberCursors(input: {
  stream: BenchmarkStreamStub;
  targetOffset: number;
}) {
  if (input.targetOffset === 0) {
    return { completed: false, reason: "no appended events" };
  }

  const startedAt = performance.now();
  let lastDiagnostics: Awaited<ReturnType<BenchmarkStreamStub["getDiagnostics"]>> | undefined;
  while (performance.now() - startedAt < 30_000) {
    lastDiagnostics = await input.stream.getDiagnostics();
    const cursors = lastDiagnostics.callableSubscriberCursors;
    if (cursors.length > 0 && cursors.every((cursor) => cursor.cursor >= input.targetOffset)) {
      return {
        completed: true,
        waitMs: round(performance.now() - startedAt),
      };
    }
    await delay(25);
  }

  return {
    completed: false,
    reason: "timed out waiting for callable subscriber cursor targets",
    targetOffset: input.targetOffset,
    waitMs: round(performance.now() - startedAt),
    lastCursors: lastDiagnostics?.callableSubscriberCursors ?? [],
  };
}

async function waitForProcessorCursors(input: {
  agent: AgentRpcStub;
  agentPath: StreamPath;
  targetOffsetByProcessor: Map<string, number>;
}) {
  if (input.targetOffsetByProcessor.size === 0) {
    return { completed: false, reason: "no terminal events requested" };
  }

  const startedAt = performance.now();
  let lastState: unknown;
  while (performance.now() - startedAt < 30_000) {
    lastState = await input.agent.getRuntimeState();
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
        waitMs: round(performance.now() - startedAt),
      };
    }
    await delay(100);
  }

  return {
    completed: false,
    reason: "timed out waiting for processor cursor targets",
    waitMs: round(performance.now() - startedAt),
    lastState,
  };
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}

async function delay(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function getAgentStub(input: {
  agentPath: StreamPath;
  context: { agent?: DurableObjectNamespace<AgentDurableObject> };
  projectId: string;
}): Promise<AgentRpcStub> {
  if (!input.context.agent) {
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: "AGENT Durable Object namespace is not configured.",
    });
  }

  const name = {
    agentPath: input.agentPath,
    projectId: input.projectId,
  };
  return (await getOrInitializeDoStub({
    namespace: input.context.agent,
    name: getAgentDurableObjectName(name),
  })) as unknown as AgentRpcStub;
}
