import { afterEach, describe, expect, test } from "vitest";
import { createWorkshopTestHarness } from "ai-engineer-workshop";
import { llmInputAddedType } from "../../examples/06-slack-composition/agent-types.ts";
import { createAgentProcessor } from "../../examples/06-slack-composition/agent.ts";
import { createCodemodeProcessor } from "../../examples/06-slack-composition/codemode.ts";
import { createSlackInputProcessor } from "../../examples/06-slack-composition/slack-input.ts";
import {
  invalidEventAppendedType,
  slackMessageAddedType,
} from "../../examples/06-slack-composition/slack-input-types.ts";
import {
  createSlackWebhook,
  destroyLingeringSockets,
  postRawJsonToStream,
  startSlackResponseServer,
  waitForSlackPost,
} from "./slack-codemode-agent.helpers.ts";

const openAiApiKey = process.env.OPENAI_API_KEY;
const app = createWorkshopTestHarness();
const describeSlackComposition = openAiApiKey == null ? describe.skip : describe;

afterEach(() => {
  destroyLingeringSockets();
});

describeSlackComposition("06 slack composition", () => {
  test("turns a raw Slack webhook into a clean event, LLM input, and one Slack reply", async () => {
    const streamPath = app.createTestStreamPath(
      expect.getState().currentTestName ?? "slack-composition",
    );
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
      const webhook = createSlackWebhook({
        responseUrl: slackServer.responseUrl,
        text: "Reply with exactly stored 7.",
      });
      const invalidEvent = await postRawJsonToStream({
        baseUrl: app.baseUrl,
        body: webhook,
        projectSlug: app.projectSlug,
        streamPath,
      });

      expect(invalidEvent.event.type).toBe(invalidEventAppendedType);
      expect(invalidEvent.event.payload.rawInput).toMatchObject(webhook);

      await app.waitForEvent({
        predicate: (event) =>
          event.type === slackMessageAddedType &&
          Reflect.get(event.payload as object, "text") === webhook.text,
        streamPath,
      });

      const mirroredInput = await app.waitForEvent({
        predicate: (event) =>
          event.type === llmInputAddedType &&
          typeof Reflect.get(event.payload as object, "content") === "string" &&
          String(Reflect.get(event.payload as object, "content")).includes("responseUrl") &&
          String(Reflect.get(event.payload as object, "content")).includes(webhook.text),
        streamPath,
        timeoutMs: 30_000,
      });
      const slackReply = await waitForSlackPost(slackServer, 1);

      expect(mirroredInput.type).toBe(llmInputAddedType);
      expect(slackReply.text).toBe("stored 7");
    } finally {
      await runtime.stopAndWait();
      await slackServer.close();
    }
  }, 90_000);
});
