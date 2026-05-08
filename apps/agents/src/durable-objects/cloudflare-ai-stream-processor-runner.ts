import type { StreamProcessorRunnerState } from "@iterate-com/shared/durable-object-utils/mixins/with-stream-processor-runner";
import { CloudflareAiProcessorContract } from "@iterate-com/shared/stream-processors/cloudflare-ai/contract";
import { createCloudflareAiProcessor } from "@iterate-com/shared/stream-processors/cloudflare-ai/implementation";
import {
  createStreamProcessorRunnerDurableObject,
  type StreamProcessorRunnerName,
} from "./stream-processor-runner-common.ts";

export type CloudflareAiStreamProcessorRunnerName = StreamProcessorRunnerName;

const CloudflareAiStreamProcessorRunnerBase = createStreamProcessorRunnerDurableObject({
  className: "CloudflareAiStreamProcessorRunner",
  processor(args) {
    return createCloudflareAiProcessor({
      ai: {
        /**
         * `Ai.run` supports an optional Gateway options argument on the Workers
         * binding. The generated overloads are model-specific, while the stream
         * processor receives the provider-agnostic model/body shape from
         * `agent/llm-request-requested`.
         *
         * https://developers.cloudflare.com/ai-gateway/providers/workersai/
         */
        run: async (model, body, runOpts) =>
          await args.env.AI.run(model as never, body as never, runOpts as never),
        get aiGatewayLogId() {
          return args.env.AI.aiGatewayLogId ?? undefined;
        },
      },
    });
  },
});

export type CloudflareAiStreamProcessorRunnerState = StreamProcessorRunnerState<
  typeof CloudflareAiProcessorContract
>;

export class CloudflareAiStreamProcessorRunner extends CloudflareAiStreamProcessorRunnerBase {}
