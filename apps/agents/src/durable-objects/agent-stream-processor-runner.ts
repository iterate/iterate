import type { StreamProcessorRunnerState } from "@iterate-com/shared/durable-object-utils/mixins/with-stream-processor-runner";
import { AgentProcessorContract } from "@iterate-com/shared/stream-processors/agent/contract";
import { createAgentProcessor } from "@iterate-com/shared/stream-processors/agent/implementation";
import {
  createStreamProcessorRunnerDurableObject,
  type StreamProcessorRunnerName,
} from "./stream-processor-runner-common.ts";

export type AgentStreamProcessorRunnerName = StreamProcessorRunnerName;

const AgentStreamProcessorRunnerBase = createStreamProcessorRunnerDurableObject({
  className: "AgentStreamProcessorRunner",
  processor(args) {
    return createAgentProcessor({
      waitUntil: (promise) => args.ctx.waitUntil(promise),
    });
  },
});

export type AgentStreamProcessorRunnerState = StreamProcessorRunnerState<
  typeof AgentProcessorContract
>;

export class AgentStreamProcessorRunner extends AgentStreamProcessorRunnerBase {}
