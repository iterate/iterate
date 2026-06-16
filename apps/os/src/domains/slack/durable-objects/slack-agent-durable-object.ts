import { createD1Client } from "sqlfu";
import { DurableObject } from "cloudflare:workers";
import { StreamPath, type StreamPath as StreamPathType } from "@iterate-com/shared/streams/types";
import {
  createStreamProcessorHost,
  type RequestStreamSubscriptionArgs,
} from "~/domains/streams/engine/workers/stream-processor-host.ts";
import {
  getInitializedStreamStub,
  type StreamDurableObjectNamespace,
  type StreamDurableObject,
} from "~/domains/streams/stream-runtime.ts";
import {
  getAgentDurableObjectName,
  type AgentDurableObject,
} from "~/domains/agents/durable-objects/agent-durable-object.ts";
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
  AGENT: DurableObjectNamespace<AgentDurableObject>;
  APP_CONFIG_SLACK_BOT_TOKEN?: string;
  DO_CATALOG: D1Database;
  SLACK_BOT_TOKEN?: string;
  STREAM: DurableObjectNamespace<StreamDurableObject>;
};

export class SlackAgentDurableObject extends DurableObject<SlackAgentEnv> {
  readonly name = parseDurableObjectName(this.ctx.id.name!);

  host = createStreamProcessorHost(this.ctx);
  slackAgent = this.host.add(SlackAgentProcessorContract.slug, (deps) => {
    return new SlackAgentProcessor({
      ...deps,
      callSlackApi: async (method, body) => {
        const { projectId, path } = this.slackAgentName();
        const token = await readSlackToken({
          db: this.env.DO_CATALOG,
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
      ensureItxContext: async () => {
        const params = this.slackAgentName();
        const agentName = getAgentDurableObjectName({
          path: params.path,
          projectId: params.projectId,
        });
        await this.env.AGENT.getByName(agentName).ensureItxContext({
          path: params.path,
          projectId: params.projectId,
        });
      },
    });
  });

  /** The stream subscription callable dials this (see `durableObjectProcessorSubscriber`). */
  async requestStreamSubscription(args: RequestStreamSubscriptionArgs): Promise<void> {
    this.slackAgentName();
    return await this.host.requestStreamSubscription(args);
  }

  async ensureReady() {
    this.slackAgentName();
    await this.waitForSlackAgentProcessorCatchUp();
    return await this.slackAgent.snapshot();
  }

  private async waitForSlackAgentProcessorCatchUp() {
    // The checkpoint only advances on delivered (consumed-type) events, so the
    // catch-up target is the newest consumed event, not the stream head.
    const maxConsumedOffset = await this.currentStreamMaxConsumedOffset();
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if ((await this.slackAgent.snapshot()).offset >= maxConsumedOffset) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  private async currentStreamMaxConsumedOffset() {
    const stream = await getInitializedStreamStub({
      durableObjectNamespace: this.env.STREAM as unknown as StreamDurableObjectNamespace,
      projectId: this.slackAgentName().projectId,
      path: this.slackAgentName().path,
    });
    const consumedTypes = new Set<string>(this.slackAgent.contract.consumes);
    const events = await stream.history({ before: "end" });
    return events.filter((event) => consumedTypes.has(event.type)).at(-1)?.offset ?? 0;
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
