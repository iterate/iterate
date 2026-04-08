import { describe, expect, test } from "vitest";
import { useProcessorTestHarness } from "../lib/test-helpers.ts";
import { agentProcessor } from "./agent-processor.ts";

const describeAgentProcessor = process.env.OPENAI_API_KEY == null ? describe.skip : describe;

describeAgentProcessor("agent processor", () => {
  test("answers that 50 - 8 is 42", async () => {
    await using f = await useProcessorTestHarness({
      processor: agentProcessor,
      pathPrefix: "/ai-engineer-workshop/workshop2/tests/agent-processor",
    });

    await f.append({
      type: "agent-input-added",
      payload: { content: "What is 50 - 8? Reply with exactly 42." },
    });

    const completedEvent = await f.waitForEvent(
      (event) =>
        event.type === "openai-response-event-added" &&
        (event.payload as { type?: string }).type === "response.completed",
      { timeout: 5_000 },
    );

    expect(completedEvent).toMatchObject({
      type: "openai-response-event-added",
      payload: {
        type: "response.completed",
        response: {
          output: [
            {
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: expect.stringContaining("42"),
                },
              ],
            },
          ],
        },
      },
    });
  }, 15_000);
});
