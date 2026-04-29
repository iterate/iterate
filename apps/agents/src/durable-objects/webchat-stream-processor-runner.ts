import type { StreamProcessorRunnerState } from "@iterate-com/shared/durable-object-utils/mixins/with-stream-processor-runner";
import {
  createStreamProcessorRunnerDurableObject,
  type StreamProcessorRunnerInit,
} from "./stream-processor-runner-common.ts";
import { WebchatProcessorContract } from "~/stream-processors/webchat/contract.ts";
import { createWebchatProcessor } from "~/stream-processors/webchat/implementation.ts";

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
