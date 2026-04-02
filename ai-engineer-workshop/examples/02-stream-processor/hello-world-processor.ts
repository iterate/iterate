import {
  createEventsClient,
  defineProcessor,
  normalizePathPrefix,
  PullSubscriptionProcessorRuntime,
  runWorkshopMain,
} from "ai-engineer-workshop";

export default async function helloWorldProcessor(pathPrefix: string) {
  const baseUrl = process.env.BASE_URL || "https://events.iterate.com";
  const streamPath = process.env.STREAM_PATH || `${normalizePathPrefix(pathPrefix)}/processor`;

  console.log(`Watching ${streamPath}`);

  await new PullSubscriptionProcessorRuntime({
    eventsClient: createEventsClient(baseUrl),
    streamPath,
    processor: defineProcessor({
      initialState: { seenHelloWorld: false },
      reduce: (state, event) => {
        if (event.type !== "hello-world") {
          return state;
        }

        return { seenHelloWorld: true };
      },
      onEvent: async ({ append, event, prevState }) => {
        if (event.type !== "hello-world" || prevState.seenHelloWorld) {
          return;
        }

        await append({
          type: "hello-world-seen",
          payload: {
            sourceOffset: event.offset,
          },
        });
      },
    }),
  }).run();
}

runWorkshopMain(import.meta.url, helloWorldProcessor);
