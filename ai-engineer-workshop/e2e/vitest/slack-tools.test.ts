import { afterEach, describe, expect, test } from "vitest";
import { createWorkshopTestHarness } from "ai-engineer-workshop";
import { createAgentProcessor } from "../../examples/07-slack-tools/agent.ts";
import { createCodemodeProcessor } from "../../examples/07-slack-tools/codemode.ts";
import {
  codemodeBlockAddedType,
  codemodeToolAddedType,
} from "../../examples/07-slack-tools/codemode-types.ts";
import { createSlackInputProcessor } from "../../examples/07-slack-tools/slack-input.ts";
import {
  createSlackWebhook,
  destroyLingeringSockets,
  postRawJsonToStream,
  startSlackResponseServer,
  waitForSlackPostMatching,
} from "./slack-codemode-agent.helpers.ts";

const openAiApiKey = process.env.OPENAI_API_KEY;
const app = createWorkshopTestHarness();
const describeSlackTools = openAiApiKey == null ? describe.skip : describe;

afterEach(() => {
  destroyLingeringSockets();
});

describeSlackTools("07 slack tools", () => {
  test("adds a tool, uses ctx.replyToSlack, and keeps context across two Slack turns", async () => {
    const streamPath = app.createTestStreamPath(expect.getState().currentTestName ?? "slack-tools");
    const codemodeRootDirectory = `${process.cwd()}/.codemode`;
    const runtime = await app.startProcessors({
      processors: [
        createSlackInputProcessor(),
        createAgentProcessor({ apiKey: openAiApiKey!, streamPath }),
        createCodemodeProcessor({ codemodeRootDirectory, streamPath }),
      ],
      streamPath,
    });
    const slackServer = await startSlackResponseServer();

    try {
      await app.append({
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

      await app.append({
        path: streamPath,
        event: {
          type: codemodeBlockAddedType,
          payload: {
            blockId: "tool-proof",
            code: [
              "export default async function (ctx) {",
              `  await ctx.replyToSlack(${JSON.stringify(slackServer.responseUrl)}, "tool-ready");`,
              "}",
            ].join("\n"),
          },
        },
      });

      const toolReply = await waitForSlackPostMatching(
        slackServer,
        (post) => post.text === "tool-ready",
        { timeoutMs: 180_000 },
      );

      await postRawJsonToStream({
        baseUrl: app.baseUrl,
        body: createSlackWebhook({
          responseUrl: slackServer.responseUrl,
          text: "Remember mango. Reply exactly stored.",
        }),
        projectSlug: app.projectSlug,
        streamPath,
      });

      const firstReply = await waitForSlackPostMatching(
        slackServer,
        (post) => post.text === "stored",
        { timeoutMs: 180_000 },
      );
      await postRawJsonToStream({
        baseUrl: app.baseUrl,
        body: createSlackWebhook({
          responseUrl: slackServer.responseUrl,
          text: "Look back at earlier conversation in this same stream. What word did I ask you to remember? Reply with exactly one word.",
        }),
        projectSlug: app.projectSlug,
        streamPath,
      });

      const secondReply = await waitForSlackPostMatching(
        slackServer,
        (post) => post.text.toLowerCase().includes("mango"),
        { timeoutMs: 180_000 },
      );

      expect(toolReply.text).toBe("tool-ready");
      expect(firstReply.text).toBe("stored");
      expect(secondReply.text.toLowerCase()).toContain("mango");
    } finally {
      await runtime.stopAndWait();
      await slackServer.close();
    }
  }, 240_000);
});
