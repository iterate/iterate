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
  getInitializedStreamStub,
  type StreamDurableObjectNamespace,
  type StreamDurableObject,
} from "~/domains/streams/new-stream-runtime.ts";
import { getProjectSecret } from "~/domains/secrets/secrets-store.ts";
import type { StreamProcessorRunner } from "~/domains/streams/durable-objects/stream-processor-runner.ts";

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
  STREAM_PROCESSOR_RUNNER: DurableObjectNamespace<StreamProcessorRunner>;
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
    await this.ensureStartedOrInitializeFromRuntimeName();
    return await this.env.STREAM_PROCESSOR_RUNNER.getByName(
      slackAgentProcessorRunnerName(this.structuredName),
    ).runtimeState();
  }

  private async waitForSlackAgentProcessorCatchUp() {
    const maxOffset = await this.currentStreamMaxOffset();
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const state = (await this.getRunnerState()) as { reducedThroughOffset: number };
      if (state.reducedThroughOffset >= maxOffset) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  private async currentStreamMaxOffset() {
    const stream = await getInitializedStreamStub({
      durableObjectNamespace: this.env.STREAM as unknown as StreamDurableObjectNamespace,
      namespace: this.structuredName.projectId,
      path: this.structuredName.streamPath,
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

export function slackAgentProcessorRunnerName(input: {
  projectId: string;
  streamPath: StreamPathType | string;
}) {
  const streamPath = StreamPath.parse(input.streamPath);
  return `${input.projectId}:${streamPath}:${slackAgentProcessorSubscriptionKey({
    projectId: input.projectId,
    streamPath,
  })}`;
}
