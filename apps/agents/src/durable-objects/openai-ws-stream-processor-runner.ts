import { parseAppConfig } from "@iterate-com/shared/apps/config";
import type { StreamProcessorRunnerState } from "@iterate-com/shared/durable-object-utils/mixins/with-stream-processor-runner";
import { OpenAiWsProcessorContract } from "@iterate-com/shared/stream-processors/openai-ws/contract";
import { createOpenAiWsProcessor } from "@iterate-com/shared/stream-processors/openai-ws/implementation";
import {
  createStreamProcessorRunnerDurableObject,
  type StreamProcessorRunnerInit,
} from "./stream-processor-runner-common.ts";
import { AppConfig } from "~/app.ts";

export type OpenAiWsStreamProcessorRunnerInit = StreamProcessorRunnerInit;

const OpenAiWsStreamProcessorRunnerBase = createStreamProcessorRunnerDurableObject({
  className: "OpenAiWsStreamProcessorRunner",
  processor(args) {
    const appConfig = parseAppConfig(AppConfig, args.env.APP_CONFIG);
    const apiKey = appConfig.openAiApiKey?.exposeSecret();

    return createOpenAiWsProcessor({
      /**
       * OpenAI's Responses WebSocket mode uses `response.create` frames over a
       * WebSocket connection. Cloudflare Worker code owns authentication at the
       * boundary so the shared processor never reads ambient secrets.
       *
       * https://developers.openai.com/api/docs/guides/websocket-mode
       * https://developers.cloudflare.com/workers/examples/websockets/
       */
      async openWebSocket({ url }) {
        if (apiKey == null) {
          throw new Error("OpenAI WebSocket processor requires AppConfig.openAiApiKey.");
        }

        const response = (await fetch(url.replace("wss://", "https://"), {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "OpenAI-Beta": "responses_websockets=2026-02-06",
            Upgrade: "websocket",
          },
        })) as Response & { webSocket?: WebSocket | null };

        if (response.webSocket == null) {
          throw new Error(`OpenAI WebSocket upgrade failed with status ${response.status}.`);
        }

        response.webSocket.accept();
        return response.webSocket;
      },
    });
  },
});

export type OpenAiWsStreamProcessorRunnerState = StreamProcessorRunnerState<
  typeof OpenAiWsProcessorContract
>;

export class OpenAiWsStreamProcessorRunner extends OpenAiWsStreamProcessorRunnerBase {}
