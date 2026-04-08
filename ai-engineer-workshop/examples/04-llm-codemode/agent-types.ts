import { z } from "zod";
import type { Event, JSONObject } from "ai-engineer-workshop";

export const llmInputAddedType = "llm-input-added" as const;
export const llmRequestStartedType = "llm-request-started" as const;
export const llmRequestCanceledType = "llm-request-canceled" as const;
export const llmRequestFailedType = "llm-request-failed" as const;
export const openAiResponseEventAddedType = "openai-response-event-added" as const;
export const llmRequestCompletedType = "llm-request-completed" as const;

const knownAgentEventTypes = new Set<string>([
  llmInputAddedType,
  llmRequestStartedType,
  llmRequestCanceledType,
  llmRequestFailedType,
  openAiResponseEventAddedType,
  llmRequestCompletedType,
]);

export const LlmInputAddedPayload = z.object({
  content: z.string().min(1),
  source: z.enum(["user", "event"]),
  sourceEventOffset: z.number().int().positive().optional(),
  sourceEventType: z.string().min(1).optional(),
});

export const LlmRequestStartedPayload = z.object({
  requestId: z.string().min(1),
  inputOffset: z.number().int().positive(),
  inputSource: z.enum(["user", "event"]),
});

export const LlmRequestCanceledPayload = z.object({
  requestId: z.string().min(1),
  replacementInputOffset: z.number().int().positive(),
});

export const LlmRequestFailedPayload = z.object({
  requestId: z.string().min(1),
  message: z.string().min(1),
});

export const LlmRequestCompletedPayload = z.object({
  requestId: z.string().min(1),
  outputText: z.string(),
});

export type LlmConversationMessage = {
  role: "user" | "assistant";
  content: string;
};

export function isCoreStreamEventType(type: string) {
  return type.startsWith("https://events.iterate.com/events/stream/");
}

export function isAgentEventType(type: string) {
  return knownAgentEventTypes.has(type);
}

export function shouldMirrorEventToLlmInput(event: Event) {
  return !isCoreStreamEventType(event.type) && !isAgentEventType(event.type);
}

export function formatEventAsPromptInput(event: Event) {
  const payload = JSON.stringify(event.payload, null, 2);
  const metadata =
    event.metadata == null ? "" : `\nmetadata:\n${JSON.stringify(event.metadata, null, 2)}\n`;

  return [
    "A new stream event was appended. Use it as fresh context.",
    `type: ${event.type}`,
    `offset: ${event.offset}`,
    `streamPath: ${event.streamPath}`,
    "payload:",
    payload,
    metadata.trim(),
  ]
    .filter((part) => part.length > 0)
    .join("\n");
}

export function buildConversationFromState(state: { conversation: LlmConversationMessage[] }) {
  return state.conversation.map((message) =>
    message.role === "assistant"
      ? {
          content: message.content,
          phase: "final_answer" as const,
          role: "assistant" as const,
        }
      : {
          content: message.content,
          role: "user" as const,
        },
  );
}

export function toJsonObject(value: unknown): JSONObject {
  const json = JSON.parse(JSON.stringify(value));
  if (json == null || typeof json !== "object" || Array.isArray(json)) {
    throw new Error("Expected a JSON object payload");
  }

  return json as JSONObject;
}
