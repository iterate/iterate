import {
  createEventsClient,
  PullSubscriptionPatternProcessorRuntime,
  workshopLogger,
  workshopPathPrefix,
} from "ai-engineer-workshop";
import { agentProcessor } from "./agent-processor.ts";
import bashmode from "./bashmode.ts";

async function main() {
  const pathPrefix = workshopPathPrefix();
  const eventsClient = createEventsClient();

  console.log(`Watching streams under ${pathPrefix}`);

  await Promise.all([
    new PullSubscriptionPatternProcessorRuntime({
      eventsClient,
      logger: workshopLogger,
      pathPrefix,
      processor: agentProcessor,
    }).run(),
    new PullSubscriptionPatternProcessorRuntime({
      eventsClient,
      logger: workshopLogger,
      pathPrefix,
      processor: bashmode,
    }).run(),
  ]);
}

main().catch((error: unknown) => {
  console.log(error);
  process.exitCode = 1;
});
