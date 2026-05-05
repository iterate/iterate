import { DurableObject } from "cloudflare:workers";
import { StreamSocketFrame, type StreamPath } from "@iterate-com/events-contract";
import { withD1ObjectCatalog } from "@iterate-com/shared/durable-object-utils/mixins/with-d1-object-catalog";
import { withKvInspector } from "@iterate-com/shared/durable-object-utils/mixins/with-kv-inspector";
import { withLifecycleHooks } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import { withOuterbase } from "@iterate-com/shared/durable-object-utils/mixins/with-outerbase";
import { withStreamProcessorRunner } from "@iterate-com/shared/durable-object-utils/mixins/with-stream-processor-runner";
import { z } from "zod";
import type {
  ConsumedEvent,
  EventCatalog,
  Processor,
  ProcessorState,
  StreamEvent,
} from "@iterate-com/shared/stream-processors";
import type { ProcessorStreamApi } from "@iterate-com/shared/stream-processors";
import type { CloudflareEnv } from "~/lib/worker-env.d.ts";

export type StreamProcessorRunnerInit = {
  name: string;
  streamPath: StreamPath;
};

type StreamProcessorRunnerCatalogEnv = Pick<CloudflareEnv, "DB">;

type RunnerContract<Contract> = {
  slug: string;
  stateSchema: z.ZodType;
  events: EventCatalog;
  processorDeps?: readonly unknown[];
  consumes: readonly string[];
  reduce?: (args: {
    contract: Contract;
    state: ProcessorState<Contract>;
    event: ConsumedEvent<Contract>;
  }) => ProcessorState<Contract> | null | undefined;
};

/**
 * App-local Durable Object stack for one stream-bound processor runner.
 *
 * This is intentionally not in `packages/shared`: websocket frames are an
 * Events-app transport detail, while the shared `withStreamProcessorRunner`
 * mixin only knows how to reduce and run processor hooks. The per-processor DO
 * files should only supply processor construction and class name metadata.
 */
export function createStreamProcessorRunnerDurableObject<
  Contract extends RunnerContract<Contract>,
>(options: {
  className: string;
  processor(args: {
    ctx: DurableObjectState;
    env: CloudflareEnv;
    initParams: StreamProcessorRunnerInit;
  }): Processor<Contract>;
}) {
  const Core = withD1ObjectCatalog<StreamProcessorRunnerInit, StreamProcessorRunnerCatalogEnv>({
    className: options.className,
    getDatabase(env) {
      return env.DB;
    },
    indexes: {
      streamPath(params) {
        return params.streamPath;
      },
    },
  })(withLifecycleHooks<StreamProcessorRunnerInit>()(DurableObject));

  const ProcessorRunner = withStreamProcessorRunner<
    StreamProcessorRunnerInit,
    CloudflareEnv,
    Contract
  >({
    processor: options.processor,
    streamApi(args) {
      return createStreamProcessorApi({
        ctx: args.ctx,
        streamPath: args.initParams.streamPath,
      });
    },
  })(Core);

  const DebuggableProcessorRunner = withOuterbase({
    unsafe: "I_UNDERSTAND_THIS_EXPOSES_SQL",
  })(
    withKvInspector({
      unsafe: "I_UNDERSTAND_THIS_EXPOSES_KV",
    })(ProcessorRunner),
  );

  abstract class StreamProcessorRunnerDurableObject extends DebuggableProcessorRunner<CloudflareEnv> {
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

    async catchUp() {
      return await this.catchUpStreamProcessor();
    }

    async consumeEvent(args: { event: StreamEvent }) {
      return await this.consumeStreamProcessorEvent(args);
    }

    async getRunnerState() {
      await this.ensureStarted();
      return this.getStreamProcessorRunnerState();
    }
  }

  return StreamProcessorRunnerDurableObject;
}

/**
 * Creates the scoped stream API WorkerEntrypoint that processor implementations use.
 *
 * The Durable Object runner binds this to its immutable stream path from
 * lifecycle init params. Processor implementations receive only the scoped API,
 * not Cloudflare storage, Durable Object state, or raw events service bindings.
 */
export function createStreamProcessorApi<Contract>(args: {
  ctx: DurableObjectState;
  streamPath: string;
}): ProcessorStreamApi<Contract> {
  const ctx = args.ctx as DurableObjectState & {
    exports: {
      StreamApi(args: { props: { streamPath: string } }): unknown;
    };
  };

  return ctx.exports.StreamApi({
    props: { streamPath: args.streamPath },
  }) as unknown as ProcessorStreamApi<Contract>;
}

export function streamProcessorWebSocketMessageToString(
  message: string | ArrayBuffer,
): string | null {
  if (typeof message === "string") return message;
  return new TextDecoder().decode(message);
}
