import {
  createEventsClient,
  PullSubscriptionProcessorRuntime,
  workshopLogger,
  workshopPathPrefix,
} from "ai-engineer-workshop";
import { agentProcessor } from "./agent-processor.ts";
import bashmode from "./bashmode.ts";

async function main() {
  const pathPrefix = workshopPathPrefix();
  const streamPath = `${pathPrefix}/bashmode-agent`;
  const eventsClient = createEventsClient();

  console.log(`Watching ${streamPath}`);

  await Promise.all([
    new PullSubscriptionProcessorRuntime({
      eventsClient,
      logger: workshopLogger,
      processor: agentProcessor,
      streamPath,
    }).run(),
    new PullSubscriptionProcessorRuntime({
      eventsClient,
      logger: workshopLogger,
      processor: bashmode,
      streamPath,
    }).run(),
  ]);
}

main().catch((error: unknown) => {
  console.log(error);
  process.exitCode = 1;
});
