import { createD1Client } from "sqlfu";
import { z } from "zod";
import { createIterateDurableObjectBase } from "@iterate-com/shared/durable-object-utils/iterate-durable-object";
import {
  deriveDurableObjectNameFromStructuredName,
  NotInitializedError,
} from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import { withStreamProcessorRunner } from "@iterate-com/shared/durable-object-utils/mixins/with-stream-processor-runner";
import { createSlackAgentProcessor } from "@iterate-com/shared/stream-processors/slack-agent/implementation";
import { SlackAgentProcessorContract } from "@iterate-com/shared/stream-processors/slack-agent/contract";
import type { ProcessorStreamApi, StreamEvent } from "@iterate-com/shared/stream-processors";
import {
  getInitializedStreamStub,
  type StreamDurableObjectNamespace,
} from "@iterate-com/shared/streams/helpers";
import type { StreamDurableObject } from "@iterate-com/shared/streams/stream-durable-object";
import {
  type Event,
  type EventInput,
  type StreamCursor,
  StreamPath,
  type StreamPath as StreamPathType,
} from "@iterate-com/shared/streams/types";
import { getProjectSecret } from "~/domains/secrets/secrets-store.ts";
import { callSlackWebApi } from "~/domains/slack/entrypoints/slack-capability.ts";
import { resolveStreamPath } from "~/domains/streams/entrypoints/streams-capability.ts";

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

type SlackAgentStreamApi = ProcessorStreamApi<typeof SlackAgentProcessorContract> & {
  append(args: { event: EventInput; streamPath?: string }): Promise<Event>;
  appendBatch(args: { events: EventInput[]; streamPath?: string }): Promise<Event[]>;
  read(args?: {
    streamPath?: string;
    afterOffset?: StreamCursor;
    beforeOffset?: StreamCursor;
  }): Promise<Event[]>;
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

const SlackAgentBase = withStreamProcessorRunner<
  SlackAgentDurableObjectStructuredName,
  SlackAgentEnv,
  typeof SlackAgentProcessorContract
>({
  processor(args) {
    return createSlackAgentProcessor({
      callSlackApi: async (method, body) => {
        const token = await readSlackToken({
          db: args.env.DO_CATALOG,
          env: args.env,
          projectId: args.structuredName.projectId,
        });
        if (!token) return;
        try {
          await callSlackWebApi({ body, method, token });
        } catch (error) {
          console.error("[os-slack-agent] Slack side effect failed", {
            error,
            method,
            streamPath: args.structuredName.streamPath,
          });
        }
      },
    });
  },
  streamApi(args) {
    return slackAgentStreamApiFromNamespace({
      durableObjectNamespace: args.env.STREAM as unknown as StreamDurableObjectNamespace,
      namespace: args.structuredName.projectId,
      streamPath: args.structuredName.streamPath,
    });
  },
})(SlackAgentLifecycleBase);

export class SlackAgentDurableObject extends SlackAgentBase<SlackAgentEnv> {
  async afterAppend(input: { event: Event }) {
    await this.ensureStartedOrInitializeFromRuntimeName();
    return await this.consumeStreamProcessorEvent({ event: input.event as StreamEvent });
  }

  async ensureReady() {
    await this.ensureStartedOrInitializeFromRuntimeName();
    return this.getStreamProcessorRunnerState();
  }

  async getRunnerState() {
    await this.ensureStartedOrInitializeFromRuntimeName();
    return this.getStreamProcessorRunnerState();
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

function slackAgentStreamApiFromNamespace(args: {
  durableObjectNamespace: StreamDurableObjectNamespace;
  namespace: string;
  streamPath: StreamPathType;
}): SlackAgentStreamApi {
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
    async appendBatch(input) {
      const stream = await getInitializedStreamStub({
        durableObjectNamespace: args.durableObjectNamespace,
        namespace: args.namespace,
        path: resolveProcessorStreamPath({
          basePath: args.streamPath,
          pathInput: input.streamPath,
        }),
      });
      return await stream.appendBatch(input.events as EventInput[]);
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
      throw new Error("Slack agent processors receive live events through afterAppend RPC.");
    },
  };
}

async function readSlackToken(input: {
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

function resolveProcessorStreamPath(input: { basePath: StreamPathType; pathInput?: string }) {
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
