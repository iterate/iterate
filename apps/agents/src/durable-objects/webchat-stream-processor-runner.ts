import type { StreamProcessorRunnerState } from "@iterate-com/shared/durable-object-utils/mixins/with-stream-processor-runner";
import { WebchatProcessorContract } from "@iterate-com/shared/stream-processors/webchat/contract";
import { createWebchatProcessor } from "@iterate-com/shared/stream-processors/webchat/implementation";
import {
  createStreamProcessorRunnerDurableObject,
  type StreamProcessorRunnerInit,
} from "./stream-processor-runner-common.ts";

export type WebchatStreamProcessorRunnerInit = StreamProcessorRunnerInit;

const WebchatStreamProcessorRunnerBase = createStreamProcessorRunnerDurableObject({
  className: "WebchatStreamProcessorRunner",
  processor() {
    return createWebchatProcessor();
  },
});

export type WebchatStreamProcessorRunnerState = StreamProcessorRunnerState<
  typeof WebchatProcessorContract
>;

export class WebchatStreamProcessorRunner extends WebchatStreamProcessorRunnerBase {}
