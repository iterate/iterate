import { DurableObject, env } from "cloudflare:workers";

import { getSlackIntegrationDurableObjectName } from "../slack-naming.ts";
import { parseDurableObjectName } from "~/domains/durable-object-names.ts";
import {
  createStreamProcessorHost,
  type RequestStreamSubscriptionArgs,
} from "~/domains/streams/engine/workers/stream-processor-host.ts";
import {
  getStreamRpcStub,
  type StreamDurableObject,
  type StreamDurableObjectNamespace,
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
  DB: D1Database;
  SLACK_BOT_TOKEN?: string;
  STREAM: DurableObjectNamespace<StreamDurableObject>;
};

export class SlackIntegrationDurableObject extends DurableObject<SlackIntegrationEnv> {
  readonly name = parseDurableObjectName(this.ctx.id.name!);

  host = createStreamProcessorHost(this.ctx);
  slack = this.host.add(SlackProcessorContract.slug, (deps) => {
    return new SlackProcessor({
      ...deps,
      stream: getStreamRpcStub({
        durableObjectNamespace: this.env.STREAM as unknown as StreamDurableObjectNamespace,
        projectId: this.projectId(),
        path: SLACK_INTEGRATION_STREAM_PATH,
      }),
      acknowledgeRoutedWebhook: async ({ payload }) => {
        const ack = eyesReactionTargetFromWebhookPayload(payload);
        if (ack == null) return;
        const projectId = this.projectId();
        const token = await readSlackToken({ db: this.env.DB, env: this.env, projectId });
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
    return await this.host.requestStreamSubscription(args);
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
}
