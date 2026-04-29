import { DurableObject } from "cloudflare:workers";
import { StreamSocketFrame, type StreamPath } from "@iterate-com/events-contract";
import { withD1ObjectCatalog } from "@iterate-com/shared/durable-object-utils/mixins/with-d1-object-catalog";
import { withDurableObjectCore } from "@iterate-com/shared/durable-object-utils/mixins/with-durable-object-core";
import { withKvInspector } from "@iterate-com/shared/durable-object-utils/mixins/with-kv-inspector";
import { withLifecycleHooks } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import { withOuterbase } from "@iterate-com/shared/durable-object-utils/mixins/with-outerbase";
import {
  withStreamProcessorRunner,
  type StreamProcessorRunnerState,
} from "@iterate-com/shared/durable-object-utils/mixins/with-stream-processor-runner";
import type { StreamEvent } from "@iterate-com/shared/stream-processors";
import { createCloudflareCodemodeCodeExecutor } from "~/stream-processors/codemode/cloudflare-code-executor.ts";
import { CodemodeProcessorContract } from "~/stream-processors/codemode/contract.ts";
import { createCodemodeProcessor } from "~/stream-processors/codemode/implementation.ts";
import type { CloudflareEnv } from "~/lib/worker-env.d.ts";
import {
  createStreamProcessorApi,
  streamProcessorWebSocketMessageToString,
} from "./stream-processor-runner-common.ts";

export type CodemodeStreamProcessorRunnerInit = {
  name: string;
  streamPath: StreamPath;
};

type CodemodeStreamProcessorRunnerCatalogEnv = Pick<CloudflareEnv, "DB">;

function createCodemodeStreamProcessor(args: { env: CloudflareEnv }) {
  return createCodemodeProcessor({
    codeExecutor: createCloudflareCodemodeCodeExecutor({
      loader: args.env.LOADER,
      outboundFetch: args.env.CODEMODE_OUTBOUND_FETCH,
    }),
    env: args.env as unknown as Record<string, unknown>,
  });
}

const CodemodeStreamProcessorRunnerCore = withD1ObjectCatalog<
  CodemodeStreamProcessorRunnerInit,
  CodemodeStreamProcessorRunnerCatalogEnv
>({
  className: "CodemodeStreamProcessorRunner",
  getDatabase(env) {
    return env.DB;
  },
  indexes: {
    streamPath(params) {
      return params.streamPath;
    },
  },
})(withLifecycleHooks<CodemodeStreamProcessorRunnerInit>()(withDurableObjectCore(DurableObject)));

const CodemodeStreamProcessorRunnerBase = withStreamProcessorRunner<
  CodemodeStreamProcessorRunnerInit,
  CloudflareEnv,
  typeof CodemodeProcessorContract
>({
  processor: createCodemodeStreamProcessor,
  streamApi(args) {
    return createStreamProcessorApi({
      ctx: args.ctx,
      streamPath: args.initParams.streamPath,
    });
  },
})(CodemodeStreamProcessorRunnerCore);

const CodemodeStreamProcessorRunnerDebugBase = withOuterbase({
  unsafe: "I_UNDERSTAND_THIS_EXPOSES_SQL",
})(
  withKvInspector({
    unsafe: "I_UNDERSTAND_THIS_EXPOSES_KV",
  })(CodemodeStreamProcessorRunnerBase),
);

export type CodemodeStreamProcessorRunnerState = StreamProcessorRunnerState<
  typeof CodemodeProcessorContract
>;

/**
 * Durable Object runner for the Codemode processor.
 *
 * This class is deployment glue: it injects Cloudflare's dynamic worker code
 * executor and forwards Events websocket frames into the shared processor
 * runner mixin. Codemode's contract/reducer remain frontend-safe and its
 * implementation depends only on a narrow code-executor interface.
 */
export class CodemodeStreamProcessorRunner extends CodemodeStreamProcessorRunnerDebugBase<CloudflareEnv> {
  constructor(ctx: DurableObjectState, env: CloudflareEnv) {
    super(ctx, env);

    this.registerOnInstanceWake(async () => {
      await this.catchUp();
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return await super.fetch(request);
    }

    await this.ensureStarted();

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async webSocketMessage(_socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const text = streamProcessorWebSocketMessageToString(message);
    if (text == null) return;

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return;
    }

    const frame = StreamSocketFrame.safeParse(json);
    if (!frame.success || frame.data.type !== "event") return;

    await this.consumeEvent({ event: frame.data.event });
  }

  async catchUp(): Promise<CodemodeStreamProcessorRunnerState> {
    return await this.catchUpStreamProcessor();
  }

  async consumeEvent(args: { event: StreamEvent }): Promise<CodemodeStreamProcessorRunnerState> {
    return await this.consumeStreamProcessorEvent(args);
  }

  async getRunnerState(): Promise<CodemodeStreamProcessorRunnerState> {
    await this.ensureStarted();
    return this.getStreamProcessorRunnerState();
  }
}
