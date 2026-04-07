import { randomBytes } from "node:crypto";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  createEventsClient,
  defaultWorkshopProjectSlug,
  PullSubscriptionProcessorRuntime,
  resolveWorkshopBaseUrl,
} from "ai-engineer-workshop";
import { createAgentProcessor } from "./agent.ts";
import { llmInputAddedType } from "./agent-types.ts";
import { createCodemodeProcessor } from "./codemode.ts";

export async function run() {
  const baseUrl = resolveWorkshopBaseUrl();
  const openAiApiKey = process.env.OPENAI_API_KEY;
  const openAiModel = process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
  const projectSlug = process.env.PROJECT_SLUG ?? defaultWorkshopProjectSlug;
  const streamPath =
    process.env.STREAM_PATH || `${process.env.PATH_PREFIX}/04/${randomBytes(4).toString("hex")}`;
  const codemodeRootDirectory = path.resolve(process.cwd(), ".codemode");
  const client = createEventsClient({ baseUrl, projectSlug });

  if (!openAiApiKey) {
    throw new Error("OPENAI_API_KEY is required");
  }

  const agentProcessor = createAgentProcessor({
    agentPath: streamPath,
    apiKey: openAiApiKey,
    baseUrl,
    codemodeRootDirectory,
    model: openAiModel,
    projectSlug,
    workingDirectory: process.cwd(),
  });
  const codemodeProcessor = createCodemodeProcessor({
    codemodeRootDirectory,
  });

  const llmRuntime = new PullSubscriptionProcessorRuntime({
    eventsClient: client,
    processor: agentProcessor,
    streamPath,
  });
  const codemodeRuntime = new PullSubscriptionProcessorRuntime({
    eventsClient: client,
    processor: codemodeProcessor,
    streamPath,
  });

  printInstructions({
    baseUrl,
    codemodeRootDirectory,
    projectSlug,
    streamPath,
  });
  installSignalHandlers(() => {
    agentProcessor.stop?.();
    llmRuntime.stop();
    codemodeRuntime.stop();
  });

  const runPromise = Promise.all([llmRuntime.run(), codemodeRuntime.run()]);

  const initialPrompt = process.env.INITIAL_PROMPT?.trim();
  if (initialPrompt) {
    await delay(500);
    await client.append({
      path: streamPath,
      event: {
        type: llmInputAddedType,
        payload: {
          content: initialPrompt,
          source: "user",
        },
      },
    });
  }

  await runPromise;
}

function printInstructions({
  baseUrl,
  codemodeRootDirectory,
  projectSlug,
  streamPath,
}: {
  baseUrl: string;
  codemodeRootDirectory: string;
  projectSlug: string;
  streamPath: string;
}) {
  console.log(`\
LLM + Codemode Loop
  agent path: ${streamPath}
  project:    ${projectSlug}
  model:      ${process.env.OPENAI_MODEL ?? "gpt-4.1-mini"}
  codemode:   ${codemodeRootDirectory}

Open in browser:
  ${new URL(`/streams${streamPath}`, baseUrl)}

Append this event to kick it off:
${JSON.stringify(
  {
    type: llmInputAddedType,
    payload: {
      content:
        "Write exactly one ```ts``` block that fetches your own stream history and logs the most recent event as JSON. No prose.",
      source: "user",
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
