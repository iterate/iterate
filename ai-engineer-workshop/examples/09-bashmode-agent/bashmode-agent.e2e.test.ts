import { afterEach, describe, expect, test } from "vitest";
import { createWorkshopTestHarness } from "ai-engineer-workshop";
import bashmode from "../08-bashmode/bashmode.ts";
import { createAgentProcessor } from "./agent.ts";
import { agentInputAddedType, agentOutputAddedType } from "./agent-types.ts";
import { destroyLingeringSockets } from "../../e2e/vitest/slack-codemode-agent.helpers.ts";

const openAiApiKey = process.env.OPENAI_API_KEY;
const openAiModel = process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
const app = createWorkshopTestHarness({
  baseUrl: "https://events.iterate.com",
  projectSlug: "public",
});
const describeBashmodeAgent = openAiApiKey == null ? describe.skip : describe;

afterEach(() => {
  destroyLingeringSockets();
});

describeBashmodeAgent("09 bashmode agent", () => {
  test("uses bashmode and then answers from the bash result", async () => {
    const streamPath = app.createTestStreamPath(
      expect.getState().currentTestName ?? "bashmode-agent",
    );
    const runtime = await app.startProcessors({
      processors: [
        createAgentProcessor({
          agentPath: streamPath,
          apiKey: openAiApiKey!,
          model: openAiModel,
        }),
        bashmode,
      ],
      streamPath,
    });

    try {
      await app.append({
        path: streamPath,
        event: {
          type: agentInputAddedType,
          payload: {
            content: [
              "First, reply with exactly one ```bash``` block and nothing else.",
              "The bash block must print PASSED on a single line.",
              "After you later receive a message that starts with Bash result:,",
              "reply with exactly PASSED and no code block.",
            ].join(" "),
          },
        },
      });

      const bashResultEvent = await app.waitForEvent({
        predicate: (event) =>
          event.type === agentInputAddedType &&
          readContent(event).includes("Bash result:") &&
          readContent(event).includes("PASSED") &&
          readContent(event).includes("exitCode: 0"),
        streamPath,
        timeoutMs: 60_000,
      });

      const finalOutputEvent = await app.waitForEvent({
        predicate: (event) =>
          event.type === agentOutputAddedType && readContent(event).trim() === "PASSED",
        streamPath,
        timeoutMs: 60_000,
      });

      expect(readContent(bashResultEvent)).toContain("PASSED");
      expect(readContent(finalOutputEvent).trim()).toBe("PASSED");
    } finally {
      await runtime.stopAndWait();
    }
  }, 90_000);
});

function readContent(event: { payload: unknown }) {
  if (
    typeof event.payload !== "object" ||
    event.payload == null ||
    !("content" in event.payload) ||
    typeof event.payload.content !== "string"
  ) {
    throw new Error("Expected payload.content to be a string");
  }

  return event.payload.content;
}
