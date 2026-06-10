import { createD1Client } from "sqlfu";
import { z } from "zod";
import { createIterateDurableObjectBase } from "@iterate-com/shared/durable-object-utils/iterate-durable-object";
import {
  deriveDurableObjectNameFromStructuredName,
  NotInitializedError,
} from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import {
  type Event,
  StreamPath,
  type StreamPath as StreamPathType,
} from "@iterate-com/shared/streams/types";
import {
  createStreamProcessorHost,
  type RequestStreamSubscriptionArgs,
} from "@iterate-com/streams/workers/stream-processor-host";
import {
  getInitializedStreamStub,
  type StreamDurableObjectNamespace,
  type StreamDurableObject,
} from "~/domains/streams/stream-runtime.ts";
import { getProjectSecret } from "~/domains/secrets/secrets-store.ts";
import { callSlackWebApi } from "~/domains/slack/entrypoints/slack-capability.ts";
import {
  SlackAgentProcessor,
  SlackAgentProcessorContract,
} from "~/domains/slack/stream-processors/slack-agent/implementation.ts";

export type SlackAgentDurableObjectStructuredName = {
  projectId: string;
  streamPath: StreamPathType;
};

const SlackAgentDurableObjectStructuredName = z.object({
  projectId: z.string().trim().min(1),
  streamPath: StreamPath,
});

export function getSlackAgentDurableObjectName(input: SlackAgentDurableObjectStructuredName) {
  return deriveDurableObjectNameFromStructuredName({
    structuredName: input,
  });
}

type SlackAgentEnv = {
  APP_CONFIG_SLACK_BOT_TOKEN?: string;
  DO_CATALOG: D1Database;
  SLACK_BOT_TOKEN?: string;
  STREAM: DurableObjectNamespace<StreamDurableObject>;
};

const SlackAgentLifecycleBase = createIterateDurableObjectBase<
  typeof SlackAgentDurableObjectStructuredName,
  Pick<SlackAgentEnv, "DO_CATALOG">
>({
  className: "SlackAgentDurableObject",
  getDatabase: (env) => env.DO_CATALOG,
  indexes: {
    projectId: (params) => params.projectId,
    streamPath: (params) => params.streamPath,
  },
  nameSchema: SlackAgentDurableObjectStructuredName,
});

export class SlackAgentDurableObject extends SlackAgentLifecycleBase<SlackAgentEnv> {
  host = createStreamProcessorHost(this.ctx);
  slackAgent = this.host.add(SlackAgentProcessorContract.slug, (deps) => {
    return new SlackAgentProcessor({
      ...deps,
      callSlackApi: async (method, body) => {
        const { projectId, streamPath } = await this.ensureStartedOrInitializeFromRuntimeName();
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
            streamPath,
          });
        }
      },
    });
  });

  /** The stream subscription callable dials this (see `durableObjectProcessorSubscriber`). */
  async requestStreamSubscription(args: RequestStreamSubscriptionArgs): Promise<void> {
    await this.ensureStartedOrInitializeFromRuntimeName();
    return await this.host.requestStreamSubscription(args);
  }

  async afterAppend(input: { event: Event }) {
    void input;
    await this.ensureStartedOrInitializeFromRuntimeName();
    await this.waitForSlackAgentProcessorCatchUp();
    return await this.getRunnerState();
  }

  async ensureReady() {
    await this.ensureStartedOrInitializeFromRuntimeName();
    await this.waitForSlackAgentProcessorCatchUp();
    return await this.getRunnerState();
  }

  async getRunnerState() {
    const snapshot = await this.slackAgent.snapshot();
    return {
      processorSlug: this.slackAgent.contract.slug,
      snapshot,
      state: snapshot.state,
      reducedThroughOffset: snapshot.offset,
      afterAppendCompletedThroughOffset: snapshot.offset,
    };
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
      namespace: this.structuredName.projectId,
      path: this.structuredName.streamPath,
    });
    const consumedTypes = new Set<string>(this.slackAgent.contract.consumes);
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
