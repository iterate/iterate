import { z } from "zod";
import { createIterateDurableObjectBase } from "@iterate-com/shared/durable-object-utils/iterate-durable-object";
import { NotInitializedError } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";

import { type Event } from "@iterate-com/shared/streams/types";
import { durableObjectProcessorSubscriber } from "@iterate-com/streams/shared/callable-subscriber";
import {
  createStreamProcessorHost,
  type RequestStreamSubscriptionArgs,
} from "@iterate-com/streams/workers/stream-processor-host";
import { getSlackIntegrationDurableObjectName } from "../slack-naming.ts";
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
import {
  codemodeProcessorSubscriptionKey,
  getCodemodeSessionName,
} from "~/domains/codemode/durable-objects/codemode-session.ts";
import { createCodemodeSessionStartupEvents } from "~/domains/codemode/codemode-session-rpc.ts";
import { SLACK_INTEGRATION_STREAM_PATH } from "~/domains/secrets/integration-streams.ts";
import {
  getSlackAgentDurableObjectName,
  type SlackAgentDurableObject,
} from "~/domains/slack/durable-objects/slack-agent-durable-object.ts";
import {
  SlackProcessor,
  SlackProcessorContract,
} from "~/domains/slack/stream-processors/slack/implementation.ts";
import { SlackAgentProcessorContract } from "~/domains/slack/stream-processors/slack-agent/contract.ts";
import { resolveStreamPath } from "~/domains/streams/entrypoints/streams-capability.ts";

export { getSlackIntegrationDurableObjectName } from "../slack-naming.ts";

export type SlackIntegrationDurableObjectStructuredName = {
  projectId: string;
};

const SlackIntegrationDurableObjectStructuredName = z.object({
  projectId: z.string().trim().min(1),
});

type SlackIntegrationEnv = {
  AGENT: DurableObjectNamespace<AgentDurableObject>;
  DO_CATALOG: D1Database;
  SLACK_AGENT: DurableObjectNamespace<SlackAgentDurableObject>;
  STREAM: DurableObjectNamespace<StreamDurableObject>;
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
  host = createStreamProcessorHost(this.ctx);
  slack = this.host.add(SlackProcessorContract.slug, (deps) => {
    return new SlackProcessor({
      ...deps,
      createRoutedStreamBootstrapEvents: async ({ streamPath }) => {
        const { projectId } = await this.ensureStartedOrInitializeFromRuntimeName();
        return routedStreamBootstrapEvents({
          agentDurableObjectName: "",
          projectId,
          slackAgentDurableObjectName: "",
          streamPath,
        });
      },
    });
  });

  constructor(ctx: DurableObjectState, env: SlackIntegrationEnv) {
    super(ctx, env);

    this.registerOnFirstInitialize(async (params) => {
      await this.ensureIntegrationSubscription(params.projectId);
    });
  }

  /** The stream subscription callable dials this (see `durableObjectProcessorSubscriber`). */
  async requestStreamSubscription(args: RequestStreamSubscriptionArgs): Promise<void> {
    await this.ensureStartedOrInitializeFromRuntimeName();
    return await this.host.requestStreamSubscription(args);
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
    const snapshot = await this.slack.snapshot();
    return {
      processorSlug: this.slack.contract.slug,
      snapshot,
      state: snapshot.state,
      reducedThroughOffset: snapshot.offset,
      afterAppendCompletedThroughOffset: snapshot.offset,
    };
  }

  private async waitForSlackIntegrationProcessorCatchUp(projectId: string) {
    // The checkpoint only advances on delivered (consumed-type) events, so the
    // catch-up target is the newest consumed event, not the stream head.
    const maxConsumedOffset = await this.currentStreamMaxConsumedOffset(projectId);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if ((await this.slack.snapshot()).offset >= maxConsumedOffset) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  private async currentStreamMaxConsumedOffset(projectId: string) {
    const stream = await getInitializedStreamStub({
      durableObjectNamespace: this.env.STREAM as unknown as StreamDurableObjectNamespace,
      namespace: projectId,
      path: SLACK_INTEGRATION_STREAM_PATH,
    });
    const consumedTypes = new Set<string>(this.slack.contract.consumes);
    const events = await stream.history({ before: "end" });
    return events.filter((event) => consumedTypes.has(event.type)).at(-1)?.offset ?? 0;
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
      // ":callable" suffix so the callable subscription lands as a NEW event on
      // streams that already carry the legacy built-in subscription.
      idempotencyKey: `slack-subscription:${projectId}:workers-rpc:callable`,
      payload: {
        subscriptionKey: slackIntegrationProcessorSubscriptionKey(projectId),
        subscriber: durableObjectProcessorSubscriber({
          bindingName: "SLACK_INTEGRATION",
          durableObjectName: getSlackIntegrationDurableObjectName(projectId),
          processorName: SlackProcessorContract.slug,
        }),
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
      // ":callable" suffix so the callable subscription lands as a NEW event on
      // streams that already carry the legacy built-in subscription.
      idempotencyKey: `slack-agent-subscription:${input.projectId}:${input.streamPath}:workers-rpc:callable`,
      payload: {
        subscriptionKey: slackAgentProcessorSubscriptionKey({
          projectId: input.projectId,
          streamPath,
        }),
        // The SLACK_AGENT host DO name is derived here rather than taken from
        // the input so legacy callers passing "" still produce a dialable
        // subscriber.
        subscriber: durableObjectProcessorSubscriber({
          bindingName: "SLACK_AGENT",
          durableObjectName: getSlackAgentDurableObjectName({
            projectId: input.projectId,
            streamPath,
          }),
          processorName: SlackAgentProcessorContract.slug,
        }),
      },
    },
    {
      type: STREAM_SUBSCRIPTION_CONFIGURED_TYPE,
      // ":callable" suffix: see the slack-agent subscription above.
      idempotencyKey: `codemode-session-processor-subscription:${input.projectId}:${streamPath}:workers-rpc:callable`,
      payload: {
        subscriptionKey: codemodeProcessorSubscriptionKey({
          projectId: input.projectId,
          streamPath,
        }),
        subscriber: durableObjectProcessorSubscriber({
          bindingName: "CODEMODE_SESSION",
          durableObjectName: getCodemodeSessionName({
            projectId: input.projectId,
            streamPath,
          }),
          processorName: "codemode",
        }),
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

function slackAgentProcessorSubscriptionKey(input: { projectId: string; streamPath: string }) {
  return `slack-agent:${input.projectId}:${input.streamPath}`;
}
