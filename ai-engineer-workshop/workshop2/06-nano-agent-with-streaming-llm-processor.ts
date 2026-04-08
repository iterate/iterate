import {
  createEventsClient,
  PullSubscriptionPatternProcessorRuntime,
  workshopLogger,
  workshopPathPrefix,
} from "ai-engineer-workshop";
import { agentProcessor } from "./agent-processor.ts";

try {
  const pathPrefix = workshopPathPrefix();

  console.log(`Watching streams under ${pathPrefix}`);

  await new PullSubscriptionPatternProcessorRuntime({
    eventsClient: createEventsClient(),
    logger: workshopLogger,
    pathPrefix,
    processor: agentProcessor,
  }).run();
} catch (error: unknown) {
  console.log(error);
  process.exitCode = 1;
}
