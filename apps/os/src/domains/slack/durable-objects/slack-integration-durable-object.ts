import { env } from "cloudflare:workers";
import { z } from "zod";
import { createIterateDurableObjectBase } from "@iterate-com/shared/durable-object-utils/iterate-durable-object";
import { NotInitializedError } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";

import { getSlackIntegrationDurableObjectName } from "../slack-naming.ts";
import { durableObjectProcessorSubscriber } from "~/domains/streams/engine/shared/callable-subscriber.ts";
import {
  createStreamProcessorHost,
  type RequestStreamSubscriptionArgs,
} from "~/domains/streams/engine/workers/stream-processor-host.ts";
import {
  getInitializedStreamStub,
  type StreamDurableObjectNamespace,
  type StreamDurableObject,
} from "~/domains/streams/stream-runtime.ts";
import { SLACK_INTEGRATION_STREAM_PATH } from "~/domains/secrets/integration-streams.ts";
import { readSlackToken } from "~/domains/slack/durable-objects/slack-agent-durable-object.ts";
import {
  SlackProcessor,
  SlackProcessorContract,
} from "~/domains/slack/stream-processors/slack/implementation.ts";
import { eyesReactionTargetFromWebhookPayload } from "~/domains/slack/stream-processors/slack-agent/implementation.ts";
import { callSlackWebApi } from "~/domains/slack/entrypoints/slack-capability.ts";

export { getSlackIntegrationDurableObjectName };

export type SlackIntegrationDurableObjectStructuredName = {
  projectId: string;
};

const SlackIntegrationDurableObjectStructuredName = z.object({
  projectId: z.string().trim().min(1),
});

/** Mint a Slack-integration DO stub from a trusted domain file (see lint rule). */
export function getSlackIntegrationStub(projectId: string) {
  return env.SLACK_INTEGRATION.getByName(getSlackIntegrationDurableObjectName(projectId));
}

type SlackIntegrationEnv = {
  APP_CONFIG_SLACK_BOT_TOKEN?: string;
  DO_CATALOG: D1Database;
  SLACK_BOT_TOKEN?: string;
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
      acknowledgeRoutedWebhook: async ({ payload }) => {
        const ack = eyesReactionTargetFromWebhookPayload(payload);
        if (ack == null) return;
        const { projectId } = await this.ensureStartedOrInitializeFromRuntimeName();
        const token = await readSlackToken({ db: this.env.DO_CATALOG, env: this.env, projectId });
        if (!token) return;
        try {
          await callSlackWebApi({
            body: { channel: ack.channel, name: "eyes", timestamp: ack.timestamp },
            method: "reactions.add",
            token,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // The slack-agent processor adds the same reaction once the routed
          // stream catches up; whichever lands second dedups here.
          if (message.includes("already_reacted") || message.includes("not_reactable")) return;
          console.error("[slack-integration] routed-webhook acknowledgement failed", {
            error,
            projectId,
          });
        }
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

  async ensureReady() {
    const params = await this.ensureStartedOrInitializeFromRuntimeName();
    await this.ensureIntegrationSubscription(params.projectId);
    await this.waitForSlackIntegrationProcessorCatchUp(params.projectId);
    return await this.slack.snapshot();
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

/** Subscription coordinate for the Slack processor owned by this project's integration DO. */
function slackIntegrationProcessorSubscriptionKey(projectId: string) {
  return `slack:${projectId}`;
}
