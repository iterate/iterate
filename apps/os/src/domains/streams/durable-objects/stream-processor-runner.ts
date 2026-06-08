import { newWorkersRpcResponse, type RpcStub } from "capnweb";
import { DurableObject } from "cloudflare:workers";
import OpenAI from "openai";
import { z } from "zod";
import {
  createProcessorRunner,
  type ProcessorRunner,
  type Snapshot,
} from "@iterate-com/streams/processor-runner";
import type { Processor } from "@iterate-com/streams/processor";
import { implementProcessor } from "@iterate-com/streams/processor";
import type { StreamEvent, StreamEventInput } from "@iterate-com/streams/shared/event";
import { makeRpcTargetClass } from "@iterate-com/streams/shared/rpc-target";
import { createStreamSubscription } from "@iterate-com/streams/subscription";
import type {
  ProcessEventBatch,
  StreamCoreProcessorState,
  StreamProcessorRunnerRpc,
  StreamRpc,
  StreamSubscriptionHandle,
} from "@iterate-com/streams/types";
import type { Callable } from "@iterate-com/shared/callable/types.ts";
import { StreamPath, type StreamCursor } from "@iterate-com/shared/streams/types";
import type {
  Processor as SharedProcessor,
  ProcessorStreamApi as SharedProcessorStreamApi,
} from "@iterate-com/shared/stream-processors";
import { createSlackProcessor } from "@iterate-com/shared/stream-processors/slack/implementation";
import { SlackProcessorContract } from "@iterate-com/shared/stream-processors/slack/contract";
import { createSlackAgentProcessor } from "@iterate-com/shared/stream-processors/slack-agent/implementation";
import { SlackAgentProcessorContract } from "@iterate-com/shared/stream-processors/slack-agent/contract";
import { createAgentChatProcessor } from "@iterate-com/shared/stream-processors/agent-chat/implementation";
import { AgentChatProcessorContract } from "@iterate-com/shared/stream-processors/agent-chat/contract";
import { createAgentProcessor } from "@iterate-com/shared/stream-processors/agent/implementation";
import { AgentProcessorContract } from "@iterate-com/shared/stream-processors/agent/contract";
import { createCloudflareAiProcessor } from "@iterate-com/shared/stream-processors/cloudflare-ai/implementation";
import { CloudflareAiProcessorContract } from "@iterate-com/shared/stream-processors/cloudflare-ai/contract";
import { createOpenAiWsProcessor } from "@iterate-com/shared/stream-processors/openai-ws/implementation";
import { OpenAiWsProcessorContract } from "@iterate-com/shared/stream-processors/openai-ws/contract";
import { createJsonataReactorProcessor } from "@iterate-com/shared/stream-processors/jsonata-reactor/implementation";
import { JsonataReactorProcessorContract } from "@iterate-com/shared/stream-processors/jsonata-reactor/contract";
import { CodemodeProcessorContract } from "@iterate-com/shared/stream-processors/codemode/contract";
import { createCodemodeProcessor } from "@iterate-com/shared/stream-processors/codemode/implementation";
import type { CodemodeProcessorSession } from "@iterate-com/shared/stream-processors/codemode/code-executor";
import {
  createRepoStreamProcessor,
  RepoStreamProcessorContract,
} from "~/domains/repos/stream-processors/repo-stream-processor.ts";
import type { CodemodeSession } from "~/domains/codemode/durable-objects/codemode-session.ts";
import {
  createCloudflareCodemodeScriptExecutor,
  getCodemodeSessionName,
} from "~/domains/codemode/durable-objects/codemode-session.ts";
import {
  AGENT_HOST_PROCESSOR_SLUG,
  createOpenAiResponsesWebSocketClient,
  ensureAgentRunnerForOwnStream,
  ensureChildAgentRunner,
  handleAgentOutputAddedForCodemode,
  handleCodemodeScriptExecutionCompletedForAgent,
  readOpenAiApiKey,
  type AgentDurableObject,
} from "~/domains/agents/durable-objects/agent-durable-object.ts";
import type { ProjectDurableObject } from "~/domains/projects/durable-objects/project-durable-object.ts";
import { ProjectLifecycleProcessorContract } from "~/domains/projects/stream-processors/project-lifecycle.ts";
import {
  type SlackAgentDurableObject,
  readSlackToken,
} from "~/domains/slack/durable-objects/slack-agent-durable-object.ts";
import { callSlackWebApi } from "~/domains/slack/entrypoints/slack-capability.ts";
import {
  type SlackIntegrationDurableObject,
  routedStreamBootstrapEvents,
} from "~/domains/slack/durable-objects/slack-integration-durable-object.ts";
import {
  getStreamDurableObjectName,
  toLegacyEvent,
  toNewAfterOffset,
  toNewEventInput,
  type StreamDurableObject,
} from "~/domains/streams/new-stream-runtime.ts";

type RunnerSnapshot = Snapshot<any>;

type StreamProcessorRunnerEnv = {
  AGENT?: DurableObjectNamespace<AgentDurableObject>;
  AI?: {
    run(model: string, body: unknown, runOpts?: unknown): Promise<unknown>;
    aiGatewayLogId?: string;
  };
  APP_CONFIG?: string;
  APP_CONFIG_OPEN_AI_API_KEY?: string;
  CODEMODE_SESSION?: DurableObjectNamespace<CodemodeSession>;
  DO_CATALOG?: D1Database;
  LOADER?: WorkerLoader;
  PROJECT?: DurableObjectNamespace<ProjectDurableObject>;
  SLACK_AGENT?: DurableObjectNamespace<SlackAgentDurableObject>;
  SLACK_BOT_TOKEN?: string;
  SLACK_INTEGRATION?: DurableObjectNamespace<SlackIntegrationDurableObject>;
  STREAM?: DurableObjectNamespace<StreamDurableObject>;
  APP_CONFIG_SLACK_BOT_TOKEN?: string;
} & Record<string, unknown>;

type OsProcessorBinding = {
  processor: Processor<any, any>;
  deps: unknown;
};

export class StreamProcessorRunner extends DurableObject {
  #stream: RpcStub<StreamRpc> | undefined;
  #runner: ProcessorRunner | undefined;
  #subscriptionHandle: StreamSubscriptionHandle | undefined;
  #processing: Promise<void> = Promise.resolve();

  async fetch(request: Request) {
    return newWorkersRpcResponse(request, new StreamProcessorRunnerRpcTarget(this));
  }

  async requestSubscription(args: {
    stream: StreamRpc;
    subscriptionKey: string;
    streamMaxOffset: number;
    subscriptionConfiguredEvent: {
      offset: number;
      createdAt: string;
      payload: {
        subscriber: {
          type: string;
          transport: string;
          processorSlug?: string;
        };
      };
    };
    streamRuntimeState: { coreProcessorState: StreamCoreProcessorState };
  }): Promise<void> {
    const subscriber = args.subscriptionConfiguredEvent.payload.subscriber;
    if (subscriber.type !== "built-in") {
      throw new Error("OS StreamProcessorRunner only supports built-in subscribers.");
    }
    if (subscriber.transport !== "workers-rpc") {
      throw new Error("OS StreamProcessorRunner only supports workers-rpc subscribers.");
    }
    if (!subscriber.processorSlug) {
      throw new Error("Built-in subscriber is missing processorSlug.");
    }

    this.#subscriptionHandle?.unsubscribe();
    await this.#processing.catch(() => {});
    this.#stream?.[Symbol.dispose]();

    this.#stream = retainStreamRpc(args.stream);
    const processor = getOsProcessor({
      ctx: this.ctx,
      env: this.env as StreamProcessorRunnerEnv,
      slug: subscriber.processorSlug,
      stream: this.#stream,
      streamRuntimeState: args.streamRuntimeState,
    });
    if (processor === undefined) {
      throw new Error(`Unknown OS stream processor slug: ${subscriber.processorSlug}`);
    }
    this.ctx.storage.kv.put("processorSlug", subscriber.processorSlug);

    this.#runner = createProcessorRunner({
      processor: processor.processor,
      deps: processor.deps,
      storage: {
        load: () => this.ctx.storage.kv.get<RunnerSnapshot>("snapshot"),
        save: (snapshot) => void this.ctx.storage.kv.put("snapshot", snapshot),
      },
      stream: this.#stream,
      sideEffectAnchor: {
        offset: args.subscriptionConfiguredEvent.offset,
        createdAt: args.subscriptionConfiguredEvent.createdAt,
      },
    });

    const snapshot = await this.#runner.snapshot();
    const processEventBatch: ProcessEventBatch = (batch) => {
      const currentRunner = this.#runner;
      if (currentRunner === undefined) return;
      const next = this.#processing.then(
        () => currentRunner.processEventBatch(batch),
        () => currentRunner.processEventBatch(batch),
      );
      this.#processing = next.catch(() => {});
      this.ctx.waitUntil(next);
    };

    this.#subscriptionHandle = await this.#stream.subscribe({
      subscriptionKey: args.subscriptionKey,
      processEventBatch,
      replayAfterOffset: snapshot?.offset ?? args.subscriptionConfiguredEvent.offset,
    });
  }

  runtimeState() {
    const processorSlug = this.ctx.storage.kv.get<string>("processorSlug");
    const snapshot = this.ctx.storage.kv.get<RunnerSnapshot>("snapshot");
    return {
      processorSlug,
      snapshot,
      state: snapshot?.state ?? null,
      reducedThroughOffset: snapshot?.offset ?? 0,
      afterAppendCompletedThroughOffset: snapshot?.offset ?? 0,
    };
  }
}

export const StreamProcessorRunnerRpcTarget = makeRpcTargetClass<
  StreamProcessorRunnerRpc,
  StreamProcessorRunner
>(StreamProcessorRunner);

type RetainedStreamRpc = RpcStub<StreamRpc> & Disposable;

type RetainableStreamRpc = StreamRpc &
  Partial<Disposable> & {
    dup?(): RetainedStreamRpc;
  };

function retainStreamRpc(stream: StreamRpc): RetainedStreamRpc {
  const retainable = stream as RetainableStreamRpc;
  const retained = retainable.dup?.() ?? retainable;
  const dispose = retained[Symbol.dispose]?.bind(retained);
  return Object.assign(retained, {
    [Symbol.dispose]() {
      dispose?.();
    },
  }) as RetainedStreamRpc;
}

function getOsProcessor(args: {
  ctx: DurableObjectState;
  env: StreamProcessorRunnerEnv;
  slug: string;
  stream: RpcStub<StreamRpc>;
  streamRuntimeState: { coreProcessorState: StreamCoreProcessorState };
}): OsProcessorBinding | undefined {
  if (args.slug === ProjectLifecycleProcessorContract.slug) {
    return {
      processor: {
        contract: ProjectLifecycleProcessorContract,
        build: () => ({}),
      } as unknown as Processor<any, undefined>,
      deps: undefined,
    };
  }

  if (args.slug === CodemodeProcessorContract.slug) {
    const projectId = args.streamRuntimeState.coreProcessorState.namespace;
    const streamPath = StreamPath.parse(args.streamRuntimeState.coreProcessorState.path);
    return {
      processor: adaptSharedProcessor(
        createCodemodeProcessor(codemodeProcessorDeps({ ...args, projectId, streamPath })),
      ),
      deps: {
        env: args.env,
        namespace: projectId,
        stream: args.stream,
        streamPath,
      } satisfies SharedProcessorAdapterDeps,
    };
  }

  if (args.slug === RepoStreamProcessorContract.slug) {
    return {
      processor: adaptSharedProcessor(createRepoStreamProcessor()),
      deps: sharedProcessorAdapterDeps(args),
    };
  }

  if (args.slug === SlackProcessorContract.slug) {
    const projectId = args.streamRuntimeState.coreProcessorState.namespace;
    return {
      processor: adaptSharedProcessor(
        createSlackProcessor({
          createRoutedStreamBootstrapEvents: ({ streamPath }) =>
            routedStreamBootstrapEvents({
              agentDurableObjectName: "",
              projectId,
              slackAgentDurableObjectName: "",
              streamPath,
            }) as never,
        }),
      ),
      deps: sharedProcessorAdapterDeps(args),
    };
  }

  if (args.slug === SlackAgentProcessorContract.slug) {
    const projectId = args.streamRuntimeState.coreProcessorState.namespace;
    const streamPath = StreamPath.parse(args.streamRuntimeState.coreProcessorState.path);
    return {
      processor: adaptSharedProcessor(
        createSlackAgentProcessor({
          callSlackApi: async (method, body) => {
            const db = args.env.DO_CATALOG;
            if (db === undefined) return;
            const token = await readSlackToken({
              db,
              env: args.env,
              projectId,
            });
            if (!token) return;
            try {
              await callSlackWebApi({ body, method, token });
            } catch (error) {
              console.error("[os-slack-agent] Slack side effect failed", {
                error,
                method,
                streamPath,
              });
            }
          },
        }),
      ),
      deps: sharedProcessorAdapterDeps(args),
    };
  }

  if (args.slug === JsonataReactorProcessorContract.slug) {
    return {
      processor: adaptSharedProcessor(createJsonataReactorProcessor()),
      deps: sharedProcessorAdapterDeps(args),
    };
  }

  if (args.slug === AgentChatProcessorContract.slug) {
    return {
      processor: adaptSharedProcessor(createAgentChatProcessor()),
      deps: sharedProcessorAdapterDeps(args),
    };
  }

  if (args.slug === AgentProcessorContract.slug) {
    return {
      processor: adaptSharedProcessor(
        createAgentProcessor({
          waitUntil: (promise) => args.ctx.waitUntil(promise),
        }),
      ),
      deps: sharedProcessorAdapterDeps(args),
    };
  }

  if (args.slug === CloudflareAiProcessorContract.slug) {
    const ai = args.env.AI;
    if (ai === undefined) {
      throw new Error("AI binding is required for the Cloudflare AI agent processor.");
    }
    return {
      processor: adaptSharedProcessor(createCloudflareAiProcessor({ ai })),
      deps: sharedProcessorAdapterDeps(args),
    };
  }

  if (args.slug === OpenAiWsProcessorContract.slug) {
    const apiKey = readOpenAiApiKey(args.env);
    if (apiKey.trim() === "") {
      return {
        processor: adaptSharedProcessor(createCloudflareAiProcessor({ ai: requireAi(args.env) })),
        deps: sharedProcessorAdapterDeps(args),
      };
    }
    return {
      processor: adaptSharedProcessor(
        createOpenAiWsProcessor({
          openResponsesWebSocket: async () =>
            createOpenAiResponsesWebSocketClient(new OpenAI({ apiKey })),
        }),
      ),
      deps: sharedProcessorAdapterDeps(args),
    };
  }

  if (args.slug === AGENT_HOST_PROCESSOR_SLUG) {
    const projectId = args.streamRuntimeState.coreProcessorState.namespace;
    const streamPath = StreamPath.parse(args.streamRuntimeState.coreProcessorState.path);
    return {
      processor: createAgentHostProcessor(),
      deps: {
        env: args.env,
        projectId,
        streamPath,
      } satisfies AgentHostProcessorDeps,
    };
  }

  return undefined;
}

function requireAi(env: StreamProcessorRunnerEnv) {
  if (env.AI === undefined) {
    throw new Error("AI binding is required for the fallback Cloudflare AI agent processor.");
  }
  return env.AI;
}

type AgentHostProcessorDeps = {
  env: StreamProcessorRunnerEnv;
  projectId: string;
  streamPath: StreamPath;
};

const AgentHostProcessorContract = {
  slug: AGENT_HOST_PROCESSOR_SLUG,
  version: "0.1.0",
  description: "Runs OS-owned host side effects for agent streams.",
  stateSchema: z.object({}),
  initialState: {},
  events: {},
  consumes: ["*"],
  consumesAllEvents: true,
  emits: [],
};

function createAgentHostProcessor(): Processor<any, AgentHostProcessorDeps> {
  return implementProcessor(AgentHostProcessorContract as any, (deps: AgentHostProcessorDeps) => ({
    afterAppend(args) {
      const event = toLegacyEvent(args.event as StreamEvent, deps.streamPath);
      // Wake this stream's agent WITHOUT blocking the host's checkpoint. The agent's
      // onInstanceWake waits for every processor on the stream (including this agent-host) to
      // catch up; awaiting it inside blockProcessorUntil would deadlock the host against itself.
      // keepAlive runs it in the background so the host advances and the catch-up can complete.
      args.keepAlive(
        ensureAgentRunnerForOwnStream({
          agentNamespace: deps.env.AGENT,
          event,
          projectId: deps.projectId,
          streamPath: deps.streamPath,
        }),
      );
      args.blockProcessorUntil(async () => {
        await ensureChildAgentRunner({
          agentNamespace: deps.env.AGENT,
          event,
          projectId: deps.projectId,
        });
        await handleAgentOutputAddedForCodemode({
          codemodeSessionNamespace: deps.env.CODEMODE_SESSION,
          event,
          projectId: deps.projectId,
          streamPath: deps.streamPath,
        });
        await handleCodemodeScriptExecutionCompletedForAgent({
          appendInput: async (input) => {
            await args.stream.append({
              event: toNewEventInput(input.event) as StreamEventInput,
            });
          },
          event,
          streamPath: deps.streamPath,
        });
      });
    },
  })) as Processor<any, AgentHostProcessorDeps>;
}

function sharedProcessorAdapterDeps(args: {
  env: StreamProcessorRunnerEnv;
  stream: RpcStub<StreamRpc>;
  streamRuntimeState: { coreProcessorState: StreamCoreProcessorState };
}): SharedProcessorAdapterDeps {
  return {
    env: args.env,
    namespace: args.streamRuntimeState.coreProcessorState.namespace,
    stream: args.stream,
    streamPath: StreamPath.parse(args.streamRuntimeState.coreProcessorState.path),
  };
}

type SharedProcessorAdapterDeps = {
  env: StreamProcessorRunnerEnv;
  namespace: string;
  stream: RpcStub<StreamRpc>;
  streamPath: StreamPath;
};

function adaptSharedProcessor(
  sharedProcessor: SharedProcessor<any>,
): Processor<any, SharedProcessorAdapterDeps> {
  return {
    contract: sharedProcessor.contract,
    build(deps: SharedProcessorAdapterDeps) {
      return {
        afterAppend(args: any) {
          const abortController = new AbortController();
          args.blockProcessorUntil(async () => {
            await sharedProcessor.implementation.afterAppend?.({
              event: toLegacyEvent(args.event as StreamEvent, deps.streamPath) as never,
              previousState: args.previousState,
              state: args.state,
              streamApi: sharedProcessorStreamApi({
                env: deps.env,
                namespace: deps.namespace,
                stream: deps.stream,
                streamPath: deps.streamPath,
              }) as never,
              signal: abortController.signal,
              waitUntil: (promise) => args.keepAlive(promise),
            });
          });
        },
      };
    },
  } as unknown as Processor<any, SharedProcessorAdapterDeps>;
}

function codemodeProcessorDeps(args: {
  ctx: DurableObjectState;
  env: StreamProcessorRunnerEnv;
  projectId: string;
  streamPath: StreamPath;
}) {
  const projectCapability = args.ctx.exports.ProjectCapability({
    props: { projectId: args.projectId },
  });
  const sessionName = getCodemodeSessionName({
    projectId: args.projectId,
    streamPath: args.streamPath,
  });

  return {
    buildSessionCapabilityCallable: () => codemodeSessionCapabilityCallable(sessionName),
    callableContext: {
      env: args.env as Record<string, unknown>,
      exports: args.ctx.exports,
      fetch,
    },
    newId: () => crypto.randomUUID(),
    scriptExecutor: createCloudflareCodemodeScriptExecutor({
      env: {
        PROJECT: projectCapability,
        project: projectCapability,
      },
      getSessionCapability: async () => {
        const namespace = args.env.CODEMODE_SESSION;
        if (namespace === undefined) {
          throw new Error("CODEMODE_SESSION binding is required for codemode processing.");
        }
        const session = namespace.getByName(sessionName) as unknown as {
          getCodemodeSessionCapability(): Promise<CodemodeProcessorSession>;
        };
        return await session.getCodemodeSessionCapability();
      },
      loader: args.env.LOADER,
      outboundFetch: projectCapability,
      wrapSessionCapability: false,
    }),
  };
}

function codemodeSessionCapabilityCallable(sessionName: string): Callable {
  return {
    type: "workers-rpc",
    via: {
      type: "env-binding",
      bindingType: "durable-object-namespace",
      bindingName: "CODEMODE_SESSION",
      durableObject: {
        name: sessionName,
      },
    },
    rpcMethod: "getCodemodeSessionCapability",
    argsMode: "object",
  };
}

function sharedProcessorStreamApi(args: {
  env: StreamProcessorRunnerEnv;
  namespace: string;
  stream: RpcStub<StreamRpc>;
  streamPath: StreamPath;
}): SharedProcessorStreamApi<any> {
  return {
    append: async (input) => {
      const streamPath = resolveProcessorStreamPath({
        basePath: args.streamPath,
        pathInput: input.streamPath,
      });
      const stream = streamRpcForPath({ ...args, basePath: args.streamPath, streamPath });
      return toLegacyEvent(
        (await Promise.resolve(
          stream.append({ event: toNewEventInput(input.event as never) as StreamEventInput }),
        )) as StreamEvent,
        streamPath,
      );
    },
    appendBatch: async (input) => {
      const streamPath = resolveProcessorStreamPath({
        basePath: args.streamPath,
        pathInput: input.streamPath,
      });
      const stream = streamRpcForPath({ ...args, basePath: args.streamPath, streamPath });
      return (
        (await Promise.resolve(
          stream.appendBatch({
            events: input.events.map(
              (event) => toNewEventInput(event as never) as StreamEventInput,
            ),
          }),
        )) as StreamEvent[]
      ).map((event) => toLegacyEvent(event, streamPath));
    },
    read: async (input = {}) => {
      const streamPath = resolveProcessorStreamPath({
        basePath: args.streamPath,
        pathInput: input.streamPath,
      });
      const stream = streamRpcForPath({ ...args, basePath: args.streamPath, streamPath });
      return (
        (await Promise.resolve(
          stream.getEvents({
            afterOffset: toNewAfterOffset(input.afterOffset as StreamCursor | undefined),
            beforeOffset: toNewBeforeOffset(input.beforeOffset as StreamCursor | undefined),
          }),
        )) as StreamEvent[]
      ).map((event) => toLegacyEvent(event, streamPath));
    },
    subscribe: (input = {}) =>
      subscribeSharedProcessorStreamApi({
        ...args,
        afterOffset: input.afterOffset as StreamCursor | undefined,
        signal: input.signal,
        basePath: args.streamPath,
        streamPath: resolveProcessorStreamPath({
          basePath: args.streamPath,
          pathInput: input.streamPath,
        }),
      }),
  };
}

async function* subscribeSharedProcessorStreamApi(args: {
  afterOffset?: StreamCursor;
  env: StreamProcessorRunnerEnv;
  namespace: string;
  signal?: AbortSignal;
  stream: RpcStub<StreamRpc>;
  basePath: StreamPath;
  streamPath: StreamPath;
}) {
  const stream = streamRpcForPath(args);
  let handle: StreamSubscriptionHandle | undefined;
  const subscription = createStreamSubscription({
    onDispose: () => handle?.unsubscribe(),
  });
  const abort = () => void subscription[Symbol.asyncDispose]();
  args.signal?.addEventListener("abort", abort, { once: true });
  try {
    handle = await stream.subscribe({
      processEventBatch: subscription.processEventBatch,
      replayAfterOffset: toNewAfterOffset(args.afterOffset),
    });

    for await (const batch of subscription) {
      for (const event of batch.events) {
        yield toLegacyEvent(event, args.streamPath);
      }
    }
  } finally {
    args.signal?.removeEventListener("abort", abort);
    await subscription[Symbol.asyncDispose]();
  }
}

function streamRpcForPath(args: {
  basePath: StreamPath;
  env: StreamProcessorRunnerEnv;
  namespace: string;
  stream: RpcStub<StreamRpc>;
  streamPath: StreamPath;
}) {
  if (args.streamPath === args.basePath) return args.stream;
  const namespace = args.env.STREAM;
  if (namespace === undefined) {
    throw new Error("STREAM binding is required for relative processor stream operations.");
  }
  return namespace.getByName(
    getStreamDurableObjectName({ namespace: args.namespace, path: args.streamPath }),
  ) as unknown as StreamRpc;
}

function resolveProcessorStreamPath(input: { basePath: StreamPath; pathInput?: string }) {
  if (input.pathInput == null) {
    return input.basePath;
  }

  const trimmedPath = input.pathInput.trim();
  if (!trimmedPath) {
    throw new Error("Stream path is required.");
  }

  if (trimmedPath.startsWith("/")) {
    return StreamPath.parse(trimmedPath);
  }

  const relativePath = trimmedPath.replace(/^\.\//, "").replace(/^\/+/, "");
  return StreamPath.parse(
    input.basePath === "/" ? `/${relativePath}` : `${input.basePath}/${relativePath}`,
  );
}

function toNewBeforeOffset(cursor: StreamCursor | undefined): number | null | undefined {
  if (cursor == null || cursor === "end") return null;
  if (cursor === "start") return 1;
  return cursor;
}
