import type { StreamProcessorRunnerState } from "@iterate-com/shared/durable-object-utils/mixins/with-stream-processor-runner";
import { AgentProcessorContract } from "@iterate-com/shared/stream-processors/agent/contract";
import { createAgentProcessor } from "@iterate-com/shared/stream-processors/agent/implementation";
import {
  createStreamProcessorRunnerDurableObject,
  type StreamProcessorRunnerInit,
} from "./stream-processor-runner-common.ts";

export type AgentStreamProcessorRunnerInit = StreamProcessorRunnerInit;

const AgentStreamProcessorRunnerBase = createStreamProcessorRunnerDurableObject({
  className: "AgentStreamProcessorRunner",
  processor(args) {
    return createAgentProcessor({
      ai: {
        /**
         * `Ai.run` is model-specific in Cloudflare's generated types, while the
         * processor deliberately receives a tiny model-agnostic surface.
         */
        run: async (model, body, runOpts) =>
          await args.env.AI.run(model as never, body as never, runOpts as never),
      },
      waitUntil: (promise) => args.ctx.waitUntil(promise),
    });
  },
});

export type AgentStreamProcessorRunnerState = StreamProcessorRunnerState<
  typeof AgentProcessorContract
>;

export class AgentStreamProcessorRunner extends AgentStreamProcessorRunnerBase {}
