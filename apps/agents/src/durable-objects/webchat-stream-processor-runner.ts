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
import { WebchatProcessorContract } from "~/stream-processors/webchat/contract.ts";
import { createWebchatProcessor } from "~/stream-processors/webchat/implementation.ts";
import type { CloudflareEnv } from "~/lib/worker-env.d.ts";
import {
  createStreamProcessorApi,
  streamProcessorWebSocketMessageToString,
} from "./stream-processor-runner-common.ts";

export type WebchatStreamProcessorRunnerInit = {
  name: string;
  streamPath: StreamPath;
};

type WebchatStreamProcessorRunnerCatalogEnv = Pick<CloudflareEnv, "DB">;

const WebchatStreamProcessorRunnerCore = withD1ObjectCatalog<
  WebchatStreamProcessorRunnerInit,
  WebchatStreamProcessorRunnerCatalogEnv
>({
  className: "WebchatStreamProcessorRunner",
  getDatabase(env) {
    return env.DB;
  },
  indexes: {
    streamPath(params) {
      return params.streamPath;
    },
  },
})(withLifecycleHooks<WebchatStreamProcessorRunnerInit>()(withDurableObjectCore(DurableObject)));

const WebchatStreamProcessorRunnerBase = withStreamProcessorRunner<
  WebchatStreamProcessorRunnerInit,
  CloudflareEnv,
  typeof WebchatProcessorContract
>({
  processor: createWebchatProcessor,
  streamApi(args) {
    return createStreamProcessorApi({
      ctx: args.ctx,
      streamPath: args.initParams.streamPath,
    });
  },
})(WebchatStreamProcessorRunnerCore);

const WebchatStreamProcessorRunnerDebugBase = withOuterbase({
  unsafe: "I_UNDERSTAND_THIS_EXPOSES_SQL",
})(
  withKvInspector({
    unsafe: "I_UNDERSTAND_THIS_EXPOSES_KV",
  })(WebchatStreamProcessorRunnerBase),
);

export type WebchatStreamProcessorRunnerState = StreamProcessorRunnerState<
  typeof WebchatProcessorContract
>;

/**
 * Durable Object runner for the Webchat processor.
 *
 * Webchat has no backend-only runtime dependencies today, but it still runs in
 * its own Durable Object so webchat event rendering, Agent LLM scheduling, and
 * Codemode execution are independently deployable processors.
 */
export class WebchatStreamProcessorRunner extends WebchatStreamProcessorRunnerDebugBase<CloudflareEnv> {
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

  async catchUp(): Promise<WebchatStreamProcessorRunnerState> {
    return await this.catchUpStreamProcessor();
  }

  async consumeEvent(args: { event: StreamEvent }): Promise<WebchatStreamProcessorRunnerState> {
    return await this.consumeStreamProcessorEvent(args);
  }

  async getRunnerState(): Promise<WebchatStreamProcessorRunnerState> {
    await this.ensureStarted();
    return this.getStreamProcessorRunnerState();
  }
}
