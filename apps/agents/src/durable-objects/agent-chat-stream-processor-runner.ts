import type { StreamProcessorRunnerState } from "@iterate-com/shared/durable-object-utils/mixins/with-stream-processor-runner";
import { AgentChatProcessorContract } from "@iterate-com/shared/stream-processors/agent-chat/contract";
import { createAgentChatProcessor } from "@iterate-com/shared/stream-processors/agent-chat/implementation";
import {
  createStreamProcessorRunnerDurableObject,
  type StreamProcessorRunnerName,
} from "./stream-processor-runner-common.ts";

export type AgentChatStreamProcessorRunnerName = StreamProcessorRunnerName;

const AgentChatStreamProcessorRunnerBase = createStreamProcessorRunnerDurableObject({
  className: "AgentChatStreamProcessorRunner",
  processor() {
    return createAgentChatProcessor();
  },
});

export type AgentChatStreamProcessorRunnerState = StreamProcessorRunnerState<
  typeof AgentChatProcessorContract
>;

export class AgentChatStreamProcessorRunner extends AgentChatStreamProcessorRunnerBase {}
