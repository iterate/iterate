import {
  createEventsClient,
  PullSubscriptionProcessorRuntime,
  os,
  runIfMain,
} from "ai-engineer-workshop";
import { agentProcessor } from "./agent-processor.ts";
import bashmode from "./bashmode.ts";

export const handler = os.handler(async ({ context, input }) => {
  const streamPath = `${input.pathPrefix}/bashmode-agent`;
  const eventsClient = createEventsClient();

  context.logger.info(`Watching ${streamPath}`);

  await Promise.all([
    new PullSubscriptionProcessorRuntime({
      eventsClient,
      logger: context.logger,
      processor: agentProcessor,
      streamPath,
    }).run(),
    new PullSubscriptionProcessorRuntime({
      eventsClient,
      logger: context.logger,
      processor: bashmode,
      streamPath,
    }).run(),
  ]);
});

runIfMain(import.meta.url, handler);
