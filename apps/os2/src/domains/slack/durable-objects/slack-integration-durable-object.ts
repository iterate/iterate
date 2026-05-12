import { z } from "zod";
import { createIterateDurableObjectBase } from "@iterate-com/shared/durable-object-utils/iterate-durable-object";
import {
  deriveDurableObjectNameFromStructuredName,
  NotInitializedError,
} from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import { withStreamProcessorRunner } from "@iterate-com/shared/durable-object-utils/mixins/with-stream-processor-runner";
import { createSlackProcessor } from "@iterate-com/shared/stream-processors/slack/implementation";
import { SlackProcessorContract } from "@iterate-com/shared/stream-processors/slack/contract";
import type {
  EmittedInput,
  ProcessorStreamApi,
  StreamEvent,
} from "@iterate-com/shared/stream-processors";
import {
  getInitializedStreamStub,
  type StreamDurableObjectNamespace,
} from "@iterate-com/shared/streams/helpers";
import type { StreamDurableObject } from "@iterate-com/shared/streams/stream-durable-object";
import {
  type Event,
  type EventInput,
  STREAM_SUBSCRIPTION_CONFIGURED_TYPE,
  type StreamCursor,
  type StreamPath,
} from "@iterate-com/shared/streams/types";
import {
  type AgentDurableObject,
  getAgentDurableObjectName,
} from "~/domains/agents/durable-objects/agent-durable-object.ts";
import { SLACK_INTEGRATION_STREAM_PATH } from "~/domains/secrets/integration-streams.ts";
import {
  type SlackAgentDurableObject,
  getSlackAgentDurableObjectName,
} from "~/domains/slack/durable-objects/slack-agent-durable-object.ts";
import { resolveStreamPath } from "~/domains/streams/entrypoints/streams-capability.ts";

export type SlackIntegrationDurableObjectStructuredName = {
  projectId: string;
};

const SlackIntegrationDurableObjectStructuredName = z.object({
  projectId: z.string().trim().min(1),
});

export function getSlackIntegrationDurableObjectName(projectId: string) {
  return deriveDurableObjectNameFromStructuredName({
    structuredName: { projectId },
  });
}

type SlackIntegrationEnv = {
  AGENT: DurableObjectNamespace<AgentDurableObject>;
  DO_CATALOG: D1Database;
  SLACK_AGENT: DurableObjectNamespace<SlackAgentDurableObject>;
  STREAM: DurableObjectNamespace<StreamDurableObject>;
};

type SlackIntegrationStreamApi = ProcessorStreamApi<typeof SlackProcessorContract> & {
  append(args: { event: EventInput; streamPath?: string }): Promise<Event>;
  appendBatch(args: { events: EventInput[]; streamPath?: string }): Promise<Event[]>;
  read(args?: {
    streamPath?: string;
    afterOffset?: StreamCursor;
    beforeOffset?: StreamCursor;
  }): Promise<Event[]>;
};

const SlackIntegrationLifecycleBase = createIterateDurableObjectBase<
  typeof SlackIntegrationDurableObjectStructuredName,
  Pick<SlackIntegrationEnv, "DO_CATALOG">
>({
  className: "SlackIntegrationDurableObject",
  getDatabase: (env) => env.DO_CATALOG,
  indexes: {
    projectId: (params) => params.projectId,
  },
  nameSchema: SlackIntegrationDurableObjectStructuredName,
});

const SlackIntegrationBase = withStreamProcessorRunner<
  SlackIntegrationDurableObjectStructuredName,
  SlackIntegrationEnv,
  typeof SlackProcessorContract
>({
  processor(args) {
    return createSlackProcessor({
      createRoutedStreamBootstrapEvents: ({ streamPath }) =>
        routedStreamBootstrapEvents({
          agentDurableObjectName: getAgentDurableObjectName({
            agentPath: resolveStreamPath(streamPath),
            projectId: args.structuredName.projectId,
          }),
          projectId: args.structuredName.projectId,
          slackAgentDurableObjectName: getSlackAgentDurableObjectName({
            projectId: args.structuredName.projectId,
            streamPath: resolveStreamPath(streamPath),
          }),
          streamPath,
        }),
    });
  },
  streamApi(args) {
    return slackIntegrationStreamApiFromNamespace({
      durableObjectNamespace: args.env.STREAM as unknown as StreamDurableObjectNamespace,
      namespace: args.structuredName.projectId,
      streamPath: SLACK_INTEGRATION_STREAM_PATH,
    });
  },
})(SlackIntegrationLifecycleBase);

export class SlackIntegrationDurableObject extends SlackIntegrationBase<SlackIntegrationEnv> {
  constructor(ctx: DurableObjectState, env: SlackIntegrationEnv) {
    super(ctx, env);

    this.registerOnFirstInitialize(async (params) => {
      await this.ensureIntegrationSubscription(params.projectId);
    });
  }

  async afterAppend(input: { event: Event }) {
    const params = await this.ensureStartedOrInitializeFromRuntimeName();
    await this.ensureIntegrationSubscription(params.projectId);
    return await this.consumeStreamProcessorEvent({ event: input.event as StreamEvent });
  }

  async ensureReady() {
    const params = await this.ensureStartedOrInitializeFromRuntimeName();
    await this.ensureIntegrationSubscription(params.projectId);
    return await this.catchUpStreamProcessor({ signal: AbortSignal.timeout(30_000) });
  }

  async getRunnerState() {
    await this.ensureStartedOrInitializeFromRuntimeName();
    return this.getStreamProcessorRunnerState();
  }

  private async ensureStartedOrInitializeFromRuntimeName() {
    try {
      return await this.ensureStarted();
    } catch (error) {
      if (!(error instanceof NotInitializedError)) throw error;
      const runtimeName = this.getDurableObjectName();
      if (runtimeName == null) throw error;
      return await this.initialize({ name: runtimeName });
    }
  }

  private async ensureIntegrationSubscription(projectId: string) {
    const stream = await getInitializedStreamStub({
      durableObjectNamespace: this.env.STREAM as unknown as StreamDurableObjectNamespace,
      namespace: projectId,
      path: SLACK_INTEGRATION_STREAM_PATH,
    });

    await stream.append({
      type: STREAM_SUBSCRIPTION_CONFIGURED_TYPE,
      idempotencyKey: `slack-subscription:${projectId}`,
      payload: {
        slug: `slack:${projectId}`,
        type: "callable",
        callable: {
          type: "workers-rpc",
          via: {
            type: "env-binding",
            bindingType: "durable-object-namespace",
            bindingName: "SLACK_INTEGRATION",
            durableObject: {
              name: this.name,
            },
          },
          rpcMethod: "afterAppend",
          argsMode: "object",
        },
      },
    });
  }
}

function routedStreamBootstrapEvents(input: {
  agentDurableObjectName: string;
  projectId: string;
  slackAgentDurableObjectName: string;
  streamPath: string;
}): EmittedInput<typeof SlackProcessorContract>[] {
  return [
    {
      type: STREAM_SUBSCRIPTION_CONFIGURED_TYPE,
      idempotencyKey: `slack-agent-subscription:${input.projectId}:${input.streamPath}`,
      payload: {
        slug: `slack-agent:${input.projectId}:${input.streamPath}`,
        type: "callable",
        callable: {
          type: "workers-rpc",
          via: {
            type: "env-binding",
            bindingType: "durable-object-namespace",
            bindingName: "SLACK_AGENT",
            durableObject: {
              name: input.slackAgentDurableObjectName,
            },
          },
          rpcMethod: "afterAppend",
          argsMode: "object",
        },
      },
    },
    {
      type: STREAM_SUBSCRIPTION_CONFIGURED_TYPE,
      idempotencyKey: `agent-subscription:${input.projectId}:${input.streamPath}`,
      payload: {
        slug: `agent:${input.projectId}:${input.streamPath}`,
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
          rpcMethod: "afterAppend",
          argsMode: "object",
        },
      },
    },
  ];
}

function slackIntegrationStreamApiFromNamespace(args: {
  durableObjectNamespace: StreamDurableObjectNamespace;
  namespace: string;
  streamPath: StreamPath;
}): SlackIntegrationStreamApi {
  return {
    async append(input) {
      const stream = await getInitializedStreamStub({
        durableObjectNamespace: args.durableObjectNamespace,
        namespace: args.namespace,
        path: resolveProcessorStreamPath({
          basePath: args.streamPath,
          pathInput: input.streamPath,
        }),
      });
      return await stream.append(input.event as EventInput);
    },
    async appendBatch(input) {
      const stream = await getInitializedStreamStub({
        durableObjectNamespace: args.durableObjectNamespace,
        namespace: args.namespace,
        path: resolveProcessorStreamPath({
          basePath: args.streamPath,
          pathInput: input.streamPath,
        }),
      });
      return await stream.appendBatch(input.events as EventInput[]);
    },
    async read(input = {}) {
      const stream = await getInitializedStreamStub({
        durableObjectNamespace: args.durableObjectNamespace,
        namespace: args.namespace,
        path: resolveProcessorStreamPath({
          basePath: args.streamPath,
          pathInput: input.streamPath,
        }),
      });
      return await stream.history({
        after: input.afterOffset,
        before: input.beforeOffset ?? "end",
      });
    },
    async *subscribe(input = {}) {
      void input;
      yield* [];
      throw new Error("Slack integration processors receive live events through afterAppend RPC.");
    },
  };
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
    return resolveStreamPath(trimmedPath);
  }

  const relativePath = trimmedPath.replace(/^\.\//, "").replace(/^\/+/, "");
  return resolveStreamPath(
    input.basePath === "/" ? `/${relativePath}` : `${input.basePath}/${relativePath}`,
  );
}
