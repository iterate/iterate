import { describe, expect, test } from "vitest";
import { runDynamicOpenAiProof } from "../../scripts/lib/dynamic-openai-proof.ts";
import { requireEventsBaseUrl } from "../helpers.ts";

const openAiApiKey = process.env.OPENAI_API_KEY?.trim();

describe("dynamic worker OpenAI proof against a deployed worker", () => {
  test("builds the processor, appends it to the deployed service, and gets back 42 within 10 seconds", async () => {
    if (!openAiApiKey) {
      throw new Error("OPENAI_API_KEY is required for the preview OpenAI proof e2e.");
    }

    const result = await runDynamicOpenAiProof({
      baseUrl: requireEventsBaseUrl(),
      openAiApiKey,
      prompt: "What is 50 - 8? Reply with only the number.",
      responseTimeoutMs: 10_000,
    });

    expect(result.elapsedMs).toBeLessThanOrEqual(10_000);
    expect(result.output).toMatch(/\b42\b/);
    expect(result.eventTypes).toContain("llm-output-added");
  }, 20_000);
});
