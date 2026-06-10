import { env } from "cloudflare:workers";
import { z } from "zod";
import { createIterateDurableObjectBase } from "@iterate-com/shared/durable-object-utils/iterate-durable-object";
import {
  deriveDurableObjectNameFromStructuredName,
  NotInitializedError,
} from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import { CodemodeProcessorContract } from "@iterate-com/shared/stream-processors/codemode/contract";
import { SlackProcessorContract } from "@iterate-com/shared/stream-processors/slack/contract";
import { type Event } from "@iterate-com/shared/streams/types";
import {
  getInitializedStreamStub,
  type StreamDurableObjectNamespace,
  type StreamDurableObject,
} from "~/domains/streams/new-stream-runtime.ts";
import { type AgentDurableObject } from "~/domains/agents/durable-objects/agent-durable-object.ts";
import {
  AGENT_HOST_PROCESSOR_SLUG,
  agentProcessorSubscriptionConfiguredEvent,
} from "~/domains/agents/agent-stream-subscriptions.ts";
import { codemodeProcessorSubscriptionKey } from "~/domains/codemode/durable-objects/codemode-session.ts";
import { createCodemodeSessionStartupEvents } from "~/domains/codemode/codemode-session-rpc.ts";
import { SLACK_INTEGRATION_STREAM_PATH } from "~/domains/secrets/integration-streams.ts";
import { type SlackAgentDurableObject } from "~/domains/slack/durable-objects/slack-agent-durable-object.ts";
import { resolveStreamPath } from "~/domains/streams/entrypoints/streams-capability.ts";
import type { StreamProcessorRunner } from "~/domains/streams/durable-objects/stream-processor-runner.ts";

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

/** Mint a Slack-integration DO stub from a trusted domain file (see lint rule). */
export function getSlackIntegrationStub(projectId: string) {
  return env.SLACK_INTEGRATION.getByName(getSlackIntegrationDurableObjectName(projectId));
}

type SlackIntegrationEnv = {
  AGENT: DurableObjectNamespace<AgentDurableObject>;
  DO_CATALOG: D1Database;
  SLACK_AGENT: DurableObjectNamespace<SlackAgentDurableObject>;
  STREAM: DurableObjectNamespace<StreamDurableObject>;
  STREAM_PROCESSOR_RUNNER: DurableObjectNamespace<StreamProcessorRunner>;
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

const STREAM_SUBSCRIPTION_CONFIGURED_TYPE = "events.iterate.com/stream/subscription-configured";

export class SlackIntegrationDurableObject extends SlackIntegrationLifecycleBase<SlackIntegrationEnv> {
  constructor(ctx: DurableObjectState, env: SlackIntegrationEnv) {
    super(ctx, env);

    this.registerOnFirstInitialize(async (params) => {
      await this.ensureIntegrationSubscription(params.projectId);
    });
  }

  async afterAppend(input: { event: Event }) {
    void input;
    const params = await this.ensureStartedOrInitializeFromRuntimeName();
    await this.ensureIntegrationSubscription(params.projectId);
    await this.waitForSlackIntegrationProcessorCatchUp(params.projectId);
    return await this.getRunnerState();
  }

  async ensureReady() {
    const params = await this.ensureStartedOrInitializeFromRuntimeName();
    await this.ensureIntegrationSubscription(params.projectId);
    await this.waitForSlackIntegrationProcessorCatchUp(params.projectId);
    return await this.getRunnerState();
  }

  async getRunnerState() {
    const params = await this.ensureStartedOrInitializeFromRuntimeName();
    return await this.env.STREAM_PROCESSOR_RUNNER.getByName(
      slackIntegrationProcessorRunnerName(params.projectId),
    ).runtimeState();
  }

  private async waitForSlackIntegrationProcessorCatchUp(projectId: string) {
    const maxOffset = await this.currentStreamMaxOffset(projectId);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const state = (await this.getRunnerState()) as { reducedThroughOffset: number };
      if (state.reducedThroughOffset >= maxOffset) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  private async currentStreamMaxOffset(projectId: string) {
    const stream = await getInitializedStreamStub({
      durableObjectNamespace: this.env.STREAM as unknown as StreamDurableObjectNamespace,
      namespace: projectId,
      path: SLACK_INTEGRATION_STREAM_PATH,
    });
    return (await stream.history({ before: "end" })).at(-1)?.offset ?? 0;
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
      idempotencyKey: `slack-subscription:${projectId}:workers-rpc`,
      payload: {
        subscriptionKey: slackIntegrationProcessorSubscriptionKey(projectId),
        subscriber: {
          type: "built-in",
          transport: "workers-rpc",
          processorSlug: SlackProcessorContract.slug,
        },
      },
    });
  }
}

export function routedStreamBootstrapEvents(input: {
  agentDurableObjectName: string;
  projectId: string;
  slackAgentDurableObjectName: string;
  streamPath: string;
}) {
  const streamPath = resolveStreamPath(input.streamPath);
  return [
    {
      type: STREAM_SUBSCRIPTION_CONFIGURED_TYPE,
      idempotencyKey: `slack-agent-subscription:${input.projectId}:${input.streamPath}:workers-rpc`,
      payload: {
        subscriptionKey: slackAgentProcessorSubscriptionKey({
          projectId: input.projectId,
          streamPath,
        }),
        subscriber: {
          type: "built-in",
          transport: "workers-rpc",
          processorSlug: "slack-agent",
        },
      },
    },
    {
      type: STREAM_SUBSCRIPTION_CONFIGURED_TYPE,
      idempotencyKey: `codemode-session-processor-subscription:${input.projectId}:${streamPath}:workers-rpc`,
      payload: {
        subscriptionKey: codemodeProcessorSubscriptionKey({
          projectId: input.projectId,
          streamPath,
        }),
        subscriber: {
          type: "built-in",
          transport: "workers-rpc",
          processorSlug: CodemodeProcessorContract.slug,
        },
      },
    },
    // The forwarded Slack webhook can immediately become a bang-command
    // codemode script. Keep codemode subscribed, with its default providers
    // registered, before that webhook enters the routed stream.
    ...createCodemodeSessionStartupEvents({
      events: [],
      projectId: input.projectId,
      providers: [],
      streamPath,
    }),
    // Subscribe the agent host using the same subscription key the AgentDurableObject uses, so the
    // host this bootstrap starts and the one AgentDurableObject.onInstanceWake re-declares dedupe to
    // a single runner. The host wakes the AgentDurableObject for this stream (see
    // `ensureAgentRunnerForOwnStream`), which registers the LLM processors and agent setup events.
    agentProcessorSubscriptionConfiguredEvent({
      agentPath: streamPath,
      processorSlug: AGENT_HOST_PROCESSOR_SLUG,
      projectId: input.projectId,
    }),
  ];
}

function slackIntegrationProcessorSubscriptionKey(projectId: string) {
  return `slack:${projectId}`;
}

function slackIntegrationProcessorRunnerName(projectId: string) {
  return `${projectId}:${SLACK_INTEGRATION_STREAM_PATH}:${slackIntegrationProcessorSubscriptionKey(
    projectId,
  )}`;
}

function slackAgentProcessorSubscriptionKey(input: { projectId: string; streamPath: string }) {
  return `slack-agent:${input.projectId}:${input.streamPath}`;
}
