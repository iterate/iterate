import {
  createEventsClient,
  PullProcessorRuntime,
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
    new PullProcessorRuntime({
      eventsClient,
      logger: workshopLogger,
      path: pathPrefix,
      processor: agentProcessor,
    }).run(),
    new PullProcessorRuntime({
      eventsClient,
      logger: workshopLogger,
      path: pathPrefix,
      processor: bashmode,
    }).run(),
  ]);
}

main().catch((error: unknown) => {
  console.log(error);
  process.exitCode = 1;
});
