import type { StreamProcessorRunnerState } from "@iterate-com/shared/durable-object-utils/mixins/with-stream-processor-runner";
import {
  createStreamProcessorRunnerDurableObject,
  type StreamProcessorRunnerInit,
} from "./stream-processor-runner-common.ts";
import { createCloudflareCodemodeCodeExecutor } from "~/stream-processors/codemode/cloudflare-code-executor.ts";
import { CodemodeProcessorContract } from "~/stream-processors/codemode/contract.ts";
import { createCodemodeProcessor } from "~/stream-processors/codemode/implementation.ts";

export type CodemodeStreamProcessorRunnerInit = StreamProcessorRunnerInit;

const CodemodeStreamProcessorRunnerBase = createStreamProcessorRunnerDurableObject({
  className: "CodemodeStreamProcessorRunner",
  processor(args) {
    return createCodemodeProcessor({
      codeExecutor: createCloudflareCodemodeCodeExecutor({
        loader: args.env.LOADER,
        outboundFetch: args.env.CODEMODE_OUTBOUND_FETCH,
      }),
      env: args.env as unknown as Record<string, unknown>,
    });
  },
});

export type CodemodeStreamProcessorRunnerState = StreamProcessorRunnerState<
  typeof CodemodeProcessorContract
>;

export class CodemodeStreamProcessorRunner extends CodemodeStreamProcessorRunnerBase {}
