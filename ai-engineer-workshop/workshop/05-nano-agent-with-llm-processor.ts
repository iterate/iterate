import {
  createEventsClient,
  PullSubscriptionProcessorRuntime,
  os,
  runIfMain,
} from "ai-engineer-workshop";
import { agentProcessor } from "./agent-processor.ts";

export const handler = os.handler(async ({ context, input }) => {
  const streamPath = `${input.pathPrefix}/nano-agent`;

  context.logger.info(`Watching ${streamPath}`);

  await new PullSubscriptionProcessorRuntime({
    eventsClient: createEventsClient(),
    logger: context.logger,
    processor: agentProcessor,
    streamPath,
  }).run();
});

runIfMain(import.meta.url, handler);
