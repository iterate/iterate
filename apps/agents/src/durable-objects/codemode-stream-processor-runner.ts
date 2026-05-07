import type { StreamProcessorRunnerState } from "@iterate-com/shared/durable-object-utils/mixins/with-stream-processor-runner";
import { CodemodeProcessorContract } from "@iterate-com/shared/stream-processors/legacy-codemode/contract";
import { createCodemodeProcessor } from "@iterate-com/shared/stream-processors/legacy-codemode/implementation";
import {
  createStreamProcessorRunnerDurableObject,
  type StreamProcessorRunnerName,
} from "./stream-processor-runner-common.ts";
import { createCloudflareCodemodeCodeExecutor } from "~/stream-processors/codemode/cloudflare-code-executor.ts";

export type CodemodeStreamProcessorRunnerName = StreamProcessorRunnerName;

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
