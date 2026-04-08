import {
  createEventsClient,
  PullSubscriptionProcessorRuntime,
  workshopLogger,
  workshopPathPrefix,
} from "ai-engineer-workshop";
import { agentProcessor } from "./agent-processor.ts";

async function main() {
  const pathPrefix = workshopPathPrefix();
  const streamPath = `${pathPrefix}/nano-agent`;

  console.log(`Watching ${streamPath}`);

  await new PullSubscriptionProcessorRuntime({
    eventsClient: createEventsClient(),
    logger: workshopLogger,
    processor: agentProcessor,
    streamPath,
  }).run();
}

main().catch((error: unknown) => {
  console.log(error);
  process.exitCode = 1;
});
