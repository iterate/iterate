import { DurableObject, env } from "cloudflare:workers";

import { getSlackIntegrationDurableObjectName } from "../slack-naming.ts";
import { parseDurableObjectName } from "~/domains/durable-object-names.ts";
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

const STREAM_SUBSCRIPTION_CONFIGURED_TYPE = "events.iterate.com/stream/subscription-configured";

export class SlackIntegrationDurableObject extends DurableObject<SlackIntegrationEnv> {
  readonly name = parseDurableObjectName(this.ctx.id.name!);

  host = createStreamProcessorHost(this.ctx);
  slack = this.host.add(SlackProcessorContract.slug, (deps) => {
    return new SlackProcessor({
      ...deps,
      acknowledgeRoutedWebhook: async ({ payload }) => {
        const ack = eyesReactionTargetFromWebhookPayload(payload);
        if (ack == null) return;
        const projectId = this.projectId();
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

  /** The stream subscription callable dials this (see `durableObjectProcessorSubscriber`). */
  async requestStreamSubscription(args: RequestStreamSubscriptionArgs): Promise<void> {
    await this.ensureIntegrationSetup();
    return await this.host.requestStreamSubscription(args);
  }

  async ensureReady() {
    const projectId = this.projectId();
    await this.ensureIntegrationSetup();
    await this.waitForSlackIntegrationProcessorCatchUp(projectId);
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
      projectId,
      path: SLACK_INTEGRATION_STREAM_PATH,
    });
    const consumedTypes = new Set<string>(this.slack.contract.consumes);
    const events = await stream.history({ before: "end" });
    return events.filter((event) => consumedTypes.has(event.type)).at(-1)?.offset ?? 0;
  }

  private async ensureIntegrationSetup() {
    await this.ensureIntegrationSubscription(this.projectId());
  }

  private projectId(): string {
    if (this.name.projectId === null) {
      throw new Error("Slack integration Durable Object must be project-scoped.");
    }
    if (this.name.path !== SLACK_INTEGRATION_STREAM_PATH) {
      throw new Error(
        `Slack integration Durable Object path must be ${SLACK_INTEGRATION_STREAM_PATH}.`,
      );
    }
    return this.name.projectId;
  }

  private async ensureIntegrationSubscription(projectId: string) {
    const stream = await getInitializedStreamStub({
      durableObjectNamespace: this.env.STREAM as unknown as StreamDurableObjectNamespace,
      projectId,
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
