import process from "node:process";
import { runDynamicOpenAiProof } from "./lib/dynamic-openai-proof.ts";

const baseUrl = process.env.EVENTS_BASE_URL?.trim() ?? "http://localhost:5173";
const openAiApiKey = process.env.OPENAI_API_KEY?.trim();

if (!openAiApiKey) {
  throw new Error("OPENAI_API_KEY is required");
}
const requiredOpenAiApiKey = openAiApiKey;

async function main() {
  const result = await runDynamicOpenAiProof({
    baseUrl,
    openAiApiKey: requiredOpenAiApiKey,
    prompt: "What is 50 - 8? Reply with only the number.",
    responseTimeoutMs: 10_000,
  });

  if (!/\b42\b/.test(result.output)) {
    throw new Error(`Expected llm-output-added to contain 42; got: ${result.output}`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        elapsedMs: result.elapsedMs,
        eventTypes: result.eventTypes,
        llmOutputPreview: result.output.slice(0, 160),
        openAiSecretName: result.openAiSecretName,
        path: result.path,
        processorScriptSecretName: result.processorScriptSecretName,
      },
      null,
      2,
    ),
  );
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
