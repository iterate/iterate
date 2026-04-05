import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createWorkshopTestHarness } from "ai-engineer-workshop";
import {
  invalidEventAppendedType,
  llmInputAddedType,
} from "../../examples/05-slack-codemode/agent-types.ts";
import { createSlackAgentProcessor } from "../../examples/05-slack-codemode/agent.ts";
import { createCodemodeProcessor } from "../../examples/05-slack-codemode/codemode.ts";
import {
  CodemodeResultAddedPayload,
  codemodeResultAddedType,
} from "../../examples/05-slack-codemode/codemode-types.ts";
import {
  createSlackWebhook,
  destroyLingeringSockets,
  postRawJsonToStream,
  startSlackResponseServer,
  waitForSlackPost,
} from "./slack-codemode-agent.helpers.ts";

const openAiApiKey = process.env.OPENAI_API_KEY;
const app = createWorkshopTestHarness();
const describeSlackAgent = openAiApiKey == null ? describe.skip : describe;

afterEach(() => {
  destroyLingeringSockets();
});

describeSlackAgent("slack codemode agent", () => {
  test("turns raw Slack webhooks into YAML input and keeps Slack conversation state", async () => {
    const streamPath = app.createTestStreamPath(
      expect.getState().currentTestName ?? "slack-codemode-agent",
    );
    const codemodeRootDirectory = path.resolve(process.cwd(), ".codemode");
    const runtime = await app.startProcessors({
      processors: [
        createSlackAgentProcessor({
          apiKey: openAiApiKey!,
          baseUrl: app.baseUrl,
          codemodeRootDirectory,
          projectSlug: app.projectSlug,
          streamPath,
          workingDirectory: process.cwd(),
        }),
        createCodemodeProcessor({ codemodeRootDirectory, streamPath }),
      ],
      streamPath,
    });
    const slackServer = await startSlackResponseServer();

    try {
      const firstWebhook = createSlackWebhook({
        responseUrl: slackServer.responseUrl,
        text: "Remember exactly this fact for later in this same stream: my favorite number is 7. Reply in one short sentence confirming you stored it.",
      });
      const firstAppend = await postRawJsonToStream({
        baseUrl: app.baseUrl,
        body: firstWebhook,
        projectSlug: app.projectSlug,
        streamPath,
      });

      expect(firstAppend.event.type).toBe(invalidEventAppendedType);
      expect(firstAppend.event.payload.rawInput).toMatchObject(firstWebhook);

      const mirroredInput = await app.waitForEvent({
        predicate: (event) =>
          event.type === llmInputAddedType &&
          typeof event.payload === "object" &&
          event.payload != null &&
          "content" in event.payload &&
          typeof event.payload.content === "string" &&
          event.payload.content.includes("Please process this event.") &&
          event.payload.content.includes("```yaml"),
        streamPath,
        timeoutMs: 30_000,
      });

      expect(mirroredInput.type).toBe(llmInputAddedType);
      expect((await waitForSlackPost(slackServer, 1)).text).toMatch(/7|remember/i);

      await postRawJsonToStream({
        baseUrl: app.baseUrl,
        body: createSlackWebhook({
          responseUrl: slackServer.responseUrl,
          text: "What is my favorite number in this same stream? Reply with a short sentence that includes the number.",
          triggerId: "1337.43",
        }),
        projectSlug: app.projectSlug,
        streamPath,
      });

      const secondSlackReply = await waitForSlackPost(slackServer, 2);
      const codemodeResult = CodemodeResultAddedPayload.parse(
        (
          await app.waitForEvent({
            predicate: (event) =>
              event.type === codemodeResultAddedType &&
              CodemodeResultAddedPayload.safeParse(event.payload).success,
            streamPath,
            timeoutMs: 60_000,
          })
        ).payload,
      );
      const outputText = await fs.readFile(codemodeResult.outputPath, "utf8");
      const artifactPrefix = path.join(
        codemodeRootDirectory,
        ...streamPath.split("/").filter(Boolean),
      );

      expect(secondSlackReply.text).toContain("7");
      expect(codemodeResult.codePath.startsWith(artifactPrefix)).toBe(true);
      expect(codemodeResult.outputPath.startsWith(artifactPrefix)).toBe(true);
      expect(outputText).toContain("status");
    } finally {
      await runtime.stopAndWait();
      await slackServer.close();
    }
  }, 120_000);
});
