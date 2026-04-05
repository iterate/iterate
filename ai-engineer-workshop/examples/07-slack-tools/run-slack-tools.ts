import { randomBytes } from "node:crypto";
import * as path from "node:path";
import {
  createProjectScopedEventsClient,
  normalizePathPrefix,
  PullSubscriptionProcessorRuntime,
  resolveWorkshopBaseUrl,
  resolveWorkshopProjectSlug,
  runWorkshopMain,
} from "ai-engineer-workshop";
import { createAgentProcessor } from "./agent.ts";
import { createCodemodeProcessor } from "./codemode.ts";
import { codemodeToolAddedType } from "./codemode-types.ts";
import { createSlackInputProcessor } from "./slack-input.ts";

async function run(pathPrefix: string) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey == null) {
    throw new Error("OPENAI_API_KEY is required");
  }

  const baseUrl = resolveWorkshopBaseUrl();
  const projectSlug = resolveWorkshopProjectSlug();
  const streamPath = `${normalizePathPrefix(pathPrefix)}/07/${randomBytes(4).toString("hex")}`;
  const codemodeRootDirectory = path.resolve(process.cwd(), ".codemode");
  const client = createProjectScopedEventsClient({ baseUrl, projectSlug });

  await client.append({
    path: streamPath,
    event: {
      type: codemodeToolAddedType,
      payload: {
        toolName: "replyToSlack",
        description: "Adds ctx.replyToSlack(responseUrl, text).",
        prompt:
          "A new tool is available: ctx.replyToSlack(responseUrl, text). Prefer it over raw fetch.",
        code: [
          "export default async function (ctx) {",
          "  ctx.replyToSlack = async (responseUrl, text) => {",
          "    const response = await fetch(responseUrl, {",
          '      method: "POST",',
          '      headers: { "content-type": "application/json" },',
          "      body: JSON.stringify({ text }),",
          "    });",
          "    return { status: response.status };",
          "  };",
          "}",
        ].join("\n"),
      },
    },
  });

  console.log(`\
Slack Tools
  stream: ${streamPath}
  baseUrl: ${baseUrl}
  project: ${projectSlug}

The stream already has one tool event:
  ${codemodeToolAddedType}

Sample real Slack API tool code:
  import { WebClient } from "@slack/web-api";
  export default async function (ctx) {
    ctx.slackApi = new WebClient(process.env.SLACK_BOT_TOKEN);
  }
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
