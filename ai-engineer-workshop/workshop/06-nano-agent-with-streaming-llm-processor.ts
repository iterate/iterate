import {
  createEventsClient,
  PullSubscriptionPatternProcessorRuntime,
  os,
  runIfMain,
} from "ai-engineer-workshop";
import { z } from "zod";
import { agentProcessor } from "./agent-processor.ts";

export const handler = os
  .input(
    z.object({
      streamPatternSuffix: z
        .string()
        .default("/**")
        .describe("stream pattern suffix appended to pathPrefix"),
    }),
  )
  .handler(async ({ context, input }) => {
    const streamPattern = `${input.pathPrefix}${input.streamPatternSuffix}`;

    context.logger.info(`Watching streams matching ${streamPattern}`);

    await new PullSubscriptionPatternProcessorRuntime({
      eventsClient: createEventsClient(),
      logger: context.logger,
      processor: agentProcessor,
      streamPattern,
    }).run();
  });

runIfMain(import.meta.url, handler);
