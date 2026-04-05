import {
  createEventsClient,
  defineProcessor,
  PullSubscriptionPatternProcessorRuntime,
  runWorkshopMain,
} from "ai-engineer-workshop";

export const jonasStreamPattern = "/jonas/**/*";

export const jonasPingPongProcessor = defineProcessor<{ pingCount: number }>(() => ({
  slug: "ping-pong",
  initialState: { pingCount: 0 },

  reduce: ({ event, state }) => {
    if (event.type !== "ping") {
      return state;
    }

    return { pingCount: state.pingCount + 1 };
  },

  async afterAppend({ append, event, state }) {
    if (event.type !== "ping") {
      return;
    }

    await append({
      type: "pong",
      payload: {
        message: "pong",
        replyToOffset: event.offset,
        pingCount: state.pingCount,
      },
    });
  },
}));

export function createJonasPingPongRuntime(baseUrl: string) {
  return new PullSubscriptionPatternProcessorRuntime({
    eventsClient: createEventsClient(baseUrl),
    streamPattern: jonasStreamPattern,
    processor: jonasPingPongProcessor,
  });
}

export default async function runJonasPingPongProcessor(_pathPrefix: string) {
  const baseUrl = process.env.BASE_URL || "http://127.0.0.1:4317";

  console.log(`Watching ${jonasStreamPattern} for ping -> pong via ${baseUrl}`);

  await createJonasPingPongRuntime(baseUrl).run();
}

runWorkshopMain(import.meta.url, runJonasPingPongProcessor);
