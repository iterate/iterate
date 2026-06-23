import { createD1Client } from "sqlfu";
import { DurableObject } from "cloudflare:workers";
import { StreamPath, type StreamPath as StreamPathType } from "@iterate-com/shared/streams/types";
import {
  createStreamProcessorHost,
  type RequestStreamSubscriptionArgs,
} from "~/domains/streams/engine/workers/stream-processor-host.ts";
import {
  getStreamRpcStub,
  type StreamDurableObject,
  type StreamDurableObjectNamespace,
} from "~/domains/streams/stream-runtime.ts";
import { formatDurableObjectName, parseDurableObjectName } from "~/domains/durable-object-names.ts";
import { getProjectSecret } from "~/domains/secrets/secrets-store.ts";
import { callSlackWebApi } from "~/domains/slack/entrypoints/slack-capability.ts";
import {
  SlackAgentProcessor,
  SlackAgentProcessorContract,
} from "~/domains/slack/stream-processors/slack-agent/implementation.ts";

export type SlackAgentDurableObjectName = {
  path: StreamPathType | string;
  projectId: string;
};

export function getSlackAgentDurableObjectName(input: SlackAgentDurableObjectName) {
  return formatDurableObjectName({ path: input.path, projectId: input.projectId });
}

type SlackAgentEnv = {
  APP_CONFIG_SLACK_BOT_TOKEN?: string;
  DB: D1Database;
  SLACK_BOT_TOKEN?: string;
  STREAM: DurableObjectNamespace<StreamDurableObject>;
};

export class SlackAgentDurableObject extends DurableObject<SlackAgentEnv> {
  readonly name = parseDurableObjectName(this.ctx.id.name!);

  host = createStreamProcessorHost(this.ctx);
  slackAgent = this.host.add(SlackAgentProcessorContract.slug, (deps) => {
    return new SlackAgentProcessor({
      ...deps,
      stream: getStreamRpcStub({
        durableObjectNamespace: this.env.STREAM as unknown as StreamDurableObjectNamespace,
        projectId: this.slackAgentName().projectId,
        path: StreamPath.parse(this.slackAgentName().path),
      }),
      callSlackApi: async (method, body) => {
        const { projectId, path } = this.slackAgentName();
        const token = await readSlackToken({
          db: this.env.DB,
          env: this.env,
          projectId,
        });
        if (!token) return;
        try {
          await callSlackWebApi({ body, method, token });
        } catch (error) {
          // Slack-facing side effects are best effort: a failed status update
          // or reaction must not wedge the processor checkpoint.
          console.error("[os-slack-agent] Slack side effect failed", {
            error,
            method,
            path,
          });
        }
      },
    });
  });

  /** The stream subscription callable dials this (see `durableObjectProcessorSubscriber`). */
  async requestStreamSubscription(args: RequestStreamSubscriptionArgs): Promise<void> {
    this.slackAgentName();
    return await this.host.requestStreamSubscription(args);
  }

  private slackAgentName(): { path: StreamPathType; projectId: string } {
    if (this.name.projectId === null) {
      throw new Error("Slack agent Durable Object must be project-scoped.");
    }
    return { path: this.name.path, projectId: this.name.projectId };
  }
}

export async function readSlackToken(input: {
  db: D1Database;
  env: Pick<SlackAgentEnv, "APP_CONFIG_SLACK_BOT_TOKEN" | "SLACK_BOT_TOKEN">;
  projectId: string;
}) {
  const secret = await getProjectSecret(createD1Client(input.db), {
    key: "slack.access_token",
    projectId: input.projectId,
  });
  if (secret) return secret.material;

  return input.env.SLACK_BOT_TOKEN ?? input.env.APP_CONFIG_SLACK_BOT_TOKEN ?? "";
}

export function slackAgentProcessorSubscriptionKey(input: {
  projectId: string;
  streamPath: StreamPathType | string;
}) {
  return `slack-agent:${input.projectId}:${StreamPath.parse(input.streamPath)}`;
}
