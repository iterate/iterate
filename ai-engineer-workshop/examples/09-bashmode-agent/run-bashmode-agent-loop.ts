import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { os } from "@orpc/server";
import {
  createEventsClient,
  defaultWorkshopProjectSlug,
  PullSubscriptionProcessorRuntime,
  resolveWorkshopBaseUrl,
} from "ai-engineer-workshop";
import bashmode from "../../workshop/bashmode.ts";
import { createAgentProcessor } from "./agent.ts";
import { agentInputAddedType } from "./agent-types.ts";

export default os.handler(async () => {
  const baseUrl = resolveWorkshopBaseUrl();
  const openAiApiKey = process.env.OPENAI_API_KEY;
  const openAiModel = process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
  const projectSlug = process.env.PROJECT_SLUG ?? defaultWorkshopProjectSlug;
  const streamPath =
    process.env.STREAM_PATH || `${process.env.PATH_PREFIX}/09/${randomBytes(4).toString("hex")}`;
  const client = createEventsClient({ baseUrl, projectSlug });

  if (!openAiApiKey) {
    throw new Error("OPENAI_API_KEY is required");
  }

  const agentProcessor = createAgentProcessor({
    agentPath: streamPath,
    apiKey: openAiApiKey,
    model: openAiModel,
  });
  const agentRuntime = new PullSubscriptionProcessorRuntime({
    eventsClient: client,
    processor: agentProcessor,
    streamPath,
  });
  const bashmodeRuntime = new PullSubscriptionProcessorRuntime({
    eventsClient: client,
    processor: bashmode,
    streamPath,
  });

  printInstructions({ baseUrl, projectSlug, streamPath });
  installSignalHandlers(() => {
    agentProcessor.stop?.();
    agentRuntime.stop();
    bashmodeRuntime.stop();
  });

  const runPromise = Promise.all([agentRuntime.run(), bashmodeRuntime.run()]);

  const initialPrompt = process.env.INITIAL_PROMPT?.trim();
  if (initialPrompt) {
    await delay(500);
    await client.append({
      path: streamPath,
      event: {
        type: agentInputAddedType,
        payload: {
          content: initialPrompt,
        },
      },
    });
  }

  await runPromise;
});

function printInstructions({
  baseUrl,
  projectSlug,
  streamPath,
}: {
  baseUrl: string;
  projectSlug: string;
  streamPath: string;
}) {
  console.log(`\
Bashmode Agent Loop
  agent path: ${streamPath}
  project:    ${projectSlug}
  model:      ${process.env.OPENAI_MODEL ?? "gpt-4.1-mini"}

Open in browser:
  ${new URL(`/streams${streamPath}`, baseUrl)}

Append this event to kick it off:
${JSON.stringify(
  {
    type: agentInputAddedType,
    payload: {
      content:
        "Write exactly one ```bash``` block that prints hello from bashmode agent. No prose.",
    },
  },
  null,
  2,
)}
`);
}

function installSignalHandlers(stop: () => void) {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      stop();
    });
  }
}
