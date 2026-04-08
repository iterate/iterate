import process from "node:process";
import { runPushedProcessorProof } from "./lib/pushed-processor-proof.ts";

const eventsBaseUrl = process.env.EVENTS_BASE_URL?.trim() ?? "http://127.0.0.1:5173";
const callbackBaseUrl = process.env.PROCESSOR_BASE_URL?.trim() ?? "http://localhost:8788";
const processorKind =
  (process.env.PROCESSOR_KIND?.trim() as "ping-pong" | "openai-agent" | undefined) ?? "ping-pong";
const subscriberType =
  (process.env.SUBSCRIBER_TYPE?.trim() as "webhook" | "websocket" | undefined) ?? "websocket";
const openAiModel = process.env.OPENAI_MODEL?.trim() ?? "gpt-4o-mini";
const projectSlug = process.env.PROJECT_SLUG?.trim() ?? "test";

async function main() {
  const result = await runPushedProcessorProof({
    callbackBaseUrl,
    eventsBaseUrl,
    openAiModel,
    processorKind,
    projectSlug,
    subscriberType,
  });

  console.log(
    JSON.stringify(
      {
        callbackBaseUrl,
        eventsBaseUrl,
        ok: true,
        outputPreview: result.outputPreview,
        processorKind,
        projectSlug,
        streamPath: result.streamPath,
        subscriberType,
        subscriptionEvent: result.subscriptionEvent,
        eventTypes: result.eventTypes,
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
