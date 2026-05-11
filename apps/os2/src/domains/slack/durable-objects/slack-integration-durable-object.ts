import { z } from "zod";
import { createIterateDurableObjectBase } from "@iterate-com/shared/durable-object-utils/iterate-durable-object";
import { deriveDurableObjectNameFromStructuredName } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import { getOrInitializeDoStub } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import { withStreamProcessorRunner } from "@iterate-com/shared/durable-object-utils/mixins/with-stream-processor-runner";
import { createSlackProcessor } from "@iterate-com/shared/stream-processors/slack/implementation";
import { SlackProcessorContract } from "@iterate-com/shared/stream-processors/slack/contract";
import type { ProcessorStreamApi, StreamEvent } from "@iterate-com/shared/stream-processors";
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
  AGENTS_STREAM_PATH,
  type AgentDurableObject,
  getAgentDurableObjectName,
} from "~/domains/agents/durable-objects/agent-durable-object.ts";
import {
  defaultAgentSetupEvents,
  presetConfiguredEvent,
  type AgentLlmProvider,
} from "~/domains/agents/agent-presets.ts";
import { SLACK_WEBHOOKS_STREAM_PATH } from "~/domains/secrets/integration-streams.ts";
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
  APP_CONFIG: string;
  APP_CONFIG_OPEN_AI_API_KEY?: string;
  DO_CATALOG: D1Database;
  OPENAI_API_KEY?: string;
  STREAM: DurableObjectNamespace<StreamDurableObject>;
};

type SlackIntegrationStreamApi = ProcessorStreamApi<typeof SlackProcessorContract> & {
  append(args: { event: EventInput; streamPath?: string }): Promise<Event>;
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
  processor() {
    return createSlackProcessor();
  },
  streamApi(args) {
    return slackIntegrationStreamApiFromNamespace({
      durableObjectNamespace: args.env.STREAM as unknown as StreamDurableObjectNamespace,
      namespace: args.structuredName.projectId,
      streamPath: SLACK_WEBHOOKS_STREAM_PATH,
    });
  },
})(SlackIntegrationLifecycleBase);

export class SlackIntegrationDurableObject extends SlackIntegrationBase<SlackIntegrationEnv> {
  constructor(ctx: DurableObjectState, env: SlackIntegrationEnv) {
    super(ctx, env);

    this.registerOnFirstInitialize(async (params) => {
      await this.ensureAgentsRoot(params.projectId);
      await this.ensureSlackAgentPreset(params.projectId);
      await this.ensureWebhookSubscription(params.projectId);
      await this.catchUpStreamProcessor({ signal: AbortSignal.timeout(30_000) });
    });
  }

  async afterAppend(input: { event: Event }) {
    await this.ensureStarted();
    return await this.consumeStreamProcessorEvent({ event: input.event as StreamEvent });
  }

  async ensureReady() {
    await this.ensureStarted();
    return this.getStreamProcessorRunnerState();
  }

  async getRunnerState() {
    await this.ensureStarted();
    return this.getStreamProcessorRunnerState();
  }

  private async ensureAgentsRoot(projectId: string) {
    await getOrInitializeDoStub({
      namespace: this.env.AGENT,
      name: getAgentDurableObjectName({
        agentPath: AGENTS_STREAM_PATH,
        projectId,
      }),
    });
  }

  private async ensureSlackAgentPreset(projectId: string) {
    const stream = await getInitializedStreamStub({
      durableObjectNamespace: this.env.STREAM as unknown as StreamDurableObjectNamespace,
      namespace: projectId,
      path: AGENTS_STREAM_PATH,
    });

    await stream.append({
      ...presetConfiguredEvent({
        basePath: "/agents/slack",
        events: slackAgentSetupEvents(selectDefaultProvider(this.env)),
      }),
      idempotencyKey: `slack-agent-preset:${projectId}:v1`,
    });
  }

  private async ensureWebhookSubscription(projectId: string) {
    const stream = await getInitializedStreamStub({
      durableObjectNamespace: this.env.STREAM as unknown as StreamDurableObjectNamespace,
      namespace: projectId,
      path: SLACK_WEBHOOKS_STREAM_PATH,
    });

    await stream.append({
      type: STREAM_SUBSCRIPTION_CONFIGURED_TYPE,
      idempotencyKey: `slack-integration-subscription:${projectId}`,
      payload: {
        slug: `slack-integration:${projectId}`,
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

function slackAgentSetupEvents(provider: AgentLlmProvider) {
  return defaultAgentSetupEvents(provider).map((event) =>
    event.type === "events.iterate.com/agent/system-prompt-updated"
      ? {
          type: event.type,
          payload: {
            systemPrompt: slackAgentSystemPrompt(),
          },
        }
      : event,
  );
}

function slackAgentSystemPrompt() {
  return [
    "You are an Iterate agent responding from Slack.",
    "Codemode is available and should be used for user-visible answers.",
    "Reply with exactly one fenced JavaScript code block and no surrounding prose.",
    "The block must evaluate to an async function, usually async (ctx) => { ... }.",
    "Use the latest Slack response target from the conversation context.",
    "Send Slack replies with ctx.slack.chat.postMessage({ channel, thread_ts, text }).",
    "Do not use ctx.chat for Slack replies.",
    "You also have ctx.ai, ctx.repos, ctx.workspace, ctx.agents.create, ctx.os, and ctx.gmail.request available.",
    "Use ctx.gmail.request({ path: '/users/me/messages', query: { q: 'in:inbox' } }) for Gmail REST API calls when the project has a Google connection.",
    "Return undefined after posting to Slack unless the code result itself should be added to the agent stream.",
  ].join(" ");
}

function selectDefaultProvider(env: SlackIntegrationEnv): AgentLlmProvider {
  return readOpenAiApiKey(env).trim() ? "openai-ws" : "cloudflare-ai";
}

function readOpenAiApiKey(env: SlackIntegrationEnv) {
  if (env.APP_CONFIG_OPEN_AI_API_KEY) return env.APP_CONFIG_OPEN_AI_API_KEY;
  if (env.OPENAI_API_KEY) return env.OPENAI_API_KEY;

  try {
    const parsed = JSON.parse(env.APP_CONFIG) as { openAiApiKey?: unknown };
    return typeof parsed.openAiApiKey === "string" ? parsed.openAiApiKey : "";
  } catch {
    return "";
  }
}
