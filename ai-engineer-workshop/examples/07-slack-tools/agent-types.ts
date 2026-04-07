import type { Event } from "ai-engineer-workshop";
import { codemodeResultAddedType } from "./codemode-types.ts";

export const llmInputAddedType = "llm-input-added" as const;
export const llmRequestStartedType = "llm-request-started" as const;
export const llmRequestCompletedType = "llm-request-completed" as const;

export type ConversationMessage = { role: "user" | "assistant"; content: string };

const agentEventTypes = new Set<string>([
  llmInputAddedType,
  llmRequestStartedType,
  llmRequestCompletedType,
]);

export function isAgentEventType(type: string) {
  return agentEventTypes.has(type);
}

export function shouldMirrorToLlmInput(event: Event) {
  if (
    event.type === codemodeResultAddedType &&
    Reflect.get(event.payload as object, "ok") === true
  ) {
    return false;
  }

  return (
    !isAgentEventType(event.type) &&
    !event.type.startsWith("https://events.iterate.com/events/stream/")
  );
}

export function readLlmInput(payload: unknown) {
  const content = Reflect.get(payload as object, "content");
  return typeof content === "string" ? content : null;
}

export function readLlmOutput(payload: unknown) {
  const outputText = Reflect.get(payload as object, "outputText");
  return typeof outputText === "string" ? outputText : null;
}

export function formatEventForLlm(event: Event) {
  const prompt = Reflect.get(event.payload as object, "prompt");
  if (typeof prompt === "string") {
    return prompt;
  }

  return [
    "Please process this event.",
    "",
    "```json",
    JSON.stringify(
      {
        type: event.type,
        streamPath: event.streamPath,
        offset: event.offset,
        payload: event.payload,
      },
      null,
      2,
    ),
    "```",
  ].join("\n");
}

export function buildOpenAiInput(conversation: ConversationMessage[]) {
  return conversation.map((message) =>
    message.role === "assistant"
      ? { role: "assistant" as const, content: message.content, phase: "final_answer" as const }
      : { role: "user" as const, content: message.content },
  );
}
