import { afterEach, describe, expect, test } from "vitest";
import { createWorkshopTestHarness } from "ai-engineer-workshop";
import { agentProcessor } from "./agent-processor.ts";
import bashmode from "./bashmode.ts";

const openAiApiKey = process.env.OPENAI_API_KEY;
const app = createWorkshopTestHarness({
  baseUrl: "https://events.iterate.com",
  projectSlug: "public",
});
const describeBashmodeAgent = openAiApiKey == null ? describe.skip : describe;

afterEach(() => {
  destroyLingeringSockets();
});

describeBashmodeAgent("07 bashmode agent", () => {
  test("runs a bash block and feeds the result back to the agent", async () => {
    const streamPath = app.createTestStreamPath(
      expect.getState().currentTestName ?? "bashmode-agent",
    );
    const runtime = await app.startProcessors({
      processors: [agentProcessor, bashmode],
      streamPath,
    });

    try {
      await app.append({
        path: streamPath,
        event: {
          type: "agent-input-added",
          payload: {
            content: [
              "First reply with exactly one ```bash``` block and nothing else.",
              "The bash block must be exactly `echo PASSED`.",
              "After you later receive a message that starts with `Bash result:`,",
              "reply with exactly `PASSED` and no code block.",
            ].join(" "),
          },
        },
      });

      const bashBlockEvent = await app.waitForEvent({
        predicate: (event) =>
          event.type === "bashmode-block-added" && readContent(event).trim() === "echo PASSED",
        streamPath,
        timeoutMs: 60_000,
      });

      const bashResultEvent = await app.waitForEvent({
        predicate: (event) =>
          event.type === "agent-input-added" &&
          readContent(event).includes("Bash result:") &&
          readContent(event).includes("PASSED") &&
          readContent(event).includes("exitCode: 0"),
        streamPath,
        timeoutMs: 60_000,
      });

      const finalOutputEvent = await app.waitForEvent({
        predicate: (event) => getOutputText(event)?.trim() === "PASSED",
        streamPath,
        timeoutMs: 60_000,
      });

      expect(readContent(bashBlockEvent)).toBe("echo PASSED");
      expect(readContent(bashResultEvent)).toContain("PASSED");
      expect(getOutputText(finalOutputEvent)?.trim()).toBe("PASSED");
    } finally {
      await runtime.stopAndWait();
    }
  }, 90_000);
});

function getOutputText(event: { type: string; payload: unknown }) {
  if (event.type !== "openai-response-event-added") {
    return null;
  }

  const payload = event.payload;
  if (typeof payload !== "object" || payload == null) {
    return null;
  }

  if (!("type" in payload) || payload.type !== "response.output_text.done") {
    return null;
  }

  if (!("text" in payload) || typeof payload.text !== "string") {
    return null;
  }

  return payload.text;
}

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

function destroyLingeringSockets() {
  const getHandles = Reflect.get(process, "_getActiveHandles");
  const handles = typeof getHandles === "function" ? getHandles.call(process) : undefined;
  if (!Array.isArray(handles)) return;

  for (const handle of handles) {
    if (
      typeof handle === "object" &&
      handle != null &&
      "constructor" in handle &&
      handle.constructor?.name === "Socket" &&
      "destroy" in handle &&
      typeof handle.destroy === "function"
    ) {
      handle.destroy();
    }
  }
}
