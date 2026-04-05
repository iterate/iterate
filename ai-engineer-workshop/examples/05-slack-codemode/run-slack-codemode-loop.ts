import { randomBytes } from "node:crypto";
import * as path from "node:path";
import {
  createProjectScopedEventsClient,
  defaultWorkshopProjectSlug,
  normalizePathPrefix,
  PullSubscriptionProcessorRuntime,
  resolveWorkshopBaseUrl,
} from "ai-engineer-workshop";
import { createSlackAgentProcessor } from "./agent.ts";
import { createCodemodeProcessor } from "./codemode.ts";

export default async function runSlackCodemodeLoop(pathPrefix: string) {
  const baseUrl = resolveWorkshopBaseUrl();
  const openAiApiKey = process.env.OPENAI_API_KEY;
  const projectSlug = process.env.PROJECT_SLUG ?? defaultWorkshopProjectSlug;
  const streamPath =
    process.env.STREAM_PATH ||
    `${normalizePathPrefix(pathPrefix)}/05/${randomBytes(4).toString("hex")}`;
  const codemodeRootDirectory = path.resolve(process.cwd(), ".codemode");

  if (!openAiApiKey) {
    throw new Error("OPENAI_API_KEY is required");
  }

  const client = createProjectScopedEventsClient({ baseUrl, projectSlug });
  const agentProcessor = createSlackAgentProcessor({
    apiKey: openAiApiKey,
    baseUrl,
    codemodeRootDirectory,
    projectSlug,
    streamPath,
    workingDirectory: process.cwd(),
  });
  const codemodeProcessor = createCodemodeProcessor({ codemodeRootDirectory, streamPath });
  const agentRuntime = new PullSubscriptionProcessorRuntime({
    eventsClient: client,
    processor: agentProcessor,
    streamPath,
  });
  const codemodeRuntime = new PullSubscriptionProcessorRuntime({
    eventsClient: client,
    processor: codemodeProcessor,
    streamPath,
  });

  printInstructions({ baseUrl, projectSlug, streamPath });
  installSignalHandlers(() => {
    agentProcessor.stop?.();
    agentRuntime.stop();
    codemodeRuntime.stop();
  });

  await Promise.all([agentRuntime.run(), codemodeRuntime.run()]);
}

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
Slack Codemode Agent
  agent path: ${streamPath}
  project:    ${projectSlug}
  model:      gpt-5.4

Open in browser:
  ${new URL(`/streams${streamPath}`, baseUrl)}
`);
}

function installSignalHandlers(stop: () => void) {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, stop);
  }
}
