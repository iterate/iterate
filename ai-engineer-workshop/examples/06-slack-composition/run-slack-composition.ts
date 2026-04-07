import { randomBytes } from "node:crypto";
import * as path from "node:path";
import {
  createEventsClient,
  PullSubscriptionProcessorRuntime,
  resolveWorkshopBaseUrl,
  resolveWorkshopProjectSlug,
  runWorkshopMain,
} from "ai-engineer-workshop";
import { createAgentProcessor } from "./agent.ts";
import { createCodemodeProcessor } from "./codemode.ts";
import { createSlackInputProcessor } from "./slack-input.ts";

export async function run() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey == null) {
    throw new Error("OPENAI_API_KEY is required");
  }

  const baseUrl = resolveWorkshopBaseUrl();
  const projectSlug = resolveWorkshopProjectSlug();
  const streamPath = `${process.env.PATH_PREFIX}/06/${randomBytes(4).toString("hex")}`;
  const codemodeRootDirectory = path.resolve(process.cwd(), ".codemode");
  const client = createEventsClient({ baseUrl, projectSlug });

  console.log(`\
Slack Composition
  stream: ${streamPath}
  baseUrl: ${baseUrl}
  project: ${projectSlug}

Post raw Slack-style JSON to:
  ${new URL(`/streams${streamPath}`, baseUrl)}
`);

  await Promise.all([
    new PullSubscriptionProcessorRuntime({
      eventsClient: client,
      processor: createSlackInputProcessor(),
      streamPath,
    }).run(),
    new PullSubscriptionProcessorRuntime({
      eventsClient: client,
      processor: createAgentProcessor({ apiKey, streamPath }),
      streamPath,
    }).run(),
    new PullSubscriptionProcessorRuntime({
      eventsClient: client,
      processor: createCodemodeProcessor({ codemodeRootDirectory, streamPath }),
      streamPath,
    }).run(),
  ]);
}

runWorkshopMain(import.meta.url, run);
