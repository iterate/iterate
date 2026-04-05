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
    processor: defineProcessor<{ helloWorldCount: number }>(() => ({
      slug: "hello-world",
      initialState: { helloWorldCount: 0 },
      reduce: ({ event, state }) => {
        if (event.type !== "hello-world") {
          return state;
        }

        return { helloWorldCount: state.helloWorldCount + 1 };
      },
      afterAppend: async ({ append, event, state }) => {
        if (event.type !== "hello-world" || state.helloWorldCount !== 1) {
          return;
        }

        await append({
          type: "hello-world-seen",
          payload: {
            sourceOffset: event.offset,
          },
        });
      },
    })),
  }).run();
}

runWorkshopMain(import.meta.url, helloWorldProcessor);
