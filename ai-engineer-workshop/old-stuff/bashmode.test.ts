import { describe, expect, test } from "vitest";
import { useProcessorTestHarness } from "../lib/test-helpers.ts";
import bashmode, { BashmodeBlockAddedEventInput } from "./bashmode.ts";

describe("bashmode", () => {
  test("turns stdout into agent-input-added", async () => {
    await using f = await useProcessorTestHarness({
      processor: bashmode,
      pathPrefix: "/ai-engineer-workshop/workshop2/tests/bashmode",
    });

    await f.append(
      BashmodeBlockAddedEventInput.parse({
        type: "bashmode-block-added",
        payload: {
          content: 'echo "hello from bashmode"',
        },
      }),
    );

    const resultEvent = await f.waitForEvent((event) => event.type === "agent-input-added", {
      timeout: 5_000,
    });

    expect(readContent(resultEvent)).toBe(
      ["Bash result:", "stdout:", "hello from bashmode\n", "stderr:", "", "exitCode: 0"].join("\n"),
    );
  }, 15_000);

  test("includes stderr in the result", async () => {
    await using f = await useProcessorTestHarness({
      processor: bashmode,
      pathPrefix: "/ai-engineer-workshop/workshop2/tests/bashmode",
    });

    await f.append(
      BashmodeBlockAddedEventInput.parse({
        type: "bashmode-block-added",
        payload: {
          content: 'echo "boom" >&2',
        },
      }),
    );

    const resultEvent = await f.waitForEvent((event) => event.type === "agent-input-added", {
      timeout: 5_000,
    });

    expect(readContent(resultEvent)).toBe(
      ["Bash result:", "stdout:", "", "stderr:", "boom\n", "exitCode: 0"].join("\n"),
    );
  }, 15_000);

  test("extracts bash blocks from completed openai responses", async () => {
    await using f = await useProcessorTestHarness({
      processor: bashmode,
      pathPrefix: "/ai-engineer-workshop/workshop2/tests/bashmode",
    });

    await f.append({
      type: "openai-response-event-added",
      payload: {
        type: "response.completed",
        response: {
          output: [
            {
              type: "reasoning",
            },
            {
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: 'Run this:\n```bash\necho "hello from completed response"\n```',
                },
              ],
            },
          ],
        },
      },
    });

    const bashBlockEvent = await f.waitForEvent((event) => event.type === "bashmode-block-added", {
      timeout: 5_000,
    });

    expect(readContent(bashBlockEvent)).toBe('echo "hello from completed response"');
  }, 15_000);
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
