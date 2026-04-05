import type { Event, JSONObject } from "ai-engineer-workshop";

export const invalidEventAppendedType =
  "https://events.iterate.com/events/stream/invalid-event-appended" as const;
export const llmInputAddedType = "llm-input-added" as const;
export const llmRequestStartedType = "llm-request-started" as const;
export const llmRequestCanceledType = "llm-request-canceled" as const;
export const llmRequestFailedType = "llm-request-failed" as const;
export const openAiResponseEventAddedType = "openai-response-event-added" as const;
export const llmRequestCompletedType = "llm-request-completed" as const;

const agentEventTypes = new Set<string>([
  llmInputAddedType,
  llmRequestStartedType,
  llmRequestCanceledType,
  llmRequestFailedType,
  openAiResponseEventAddedType,
  llmRequestCompletedType,
]);

export type LlmConversationMessage = { role: "user" | "assistant"; content: string };

export function isAgentEventType(type: string) {
  return agentEventTypes.has(type);
}

export function shouldMirrorEventToLlmInput(event: Event) {
  return event.type === invalidEventAppendedType || !isCoreStreamEventType(event.type);
}

export function readLlmInput(payload: unknown) {
  if (
    typeof payload !== "object" ||
    payload == null ||
    typeof Reflect.get(payload, "content") !== "string" ||
    (Reflect.get(payload, "source") !== "user" && Reflect.get(payload, "source") !== "event")
  ) {
    return null;
  }

  return {
    content: Reflect.get(payload, "content") as string,
    source: Reflect.get(payload, "source") as "user" | "event",
  };
}

export function readOutputText(payload: unknown) {
  return typeof Reflect.get(payload as object, "outputText") === "string"
    ? (Reflect.get(payload as object, "outputText") as string)
    : null;
}

export function buildConversationInput(conversation: LlmConversationMessage[]) {
  return conversation.map((message) =>
    message.role === "assistant"
      ? { content: message.content, phase: "final_answer" as const, role: "assistant" as const }
      : { content: message.content, role: "user" as const },
  );
}

export function formatEventAsPromptInput(event: Event) {
  return [
    "Please process this event.",
    "",
    "```yaml",
    toYaml({
      metadata: event.metadata,
      offset: event.offset,
      payload: event.payload,
      streamPath: event.streamPath,
      type: event.type,
    }),
    "```",
  ].join("\n");
}

export function toJsonObject(value: unknown): JSONObject {
  const json = JSON.parse(JSON.stringify(value));
  if (json == null || typeof json !== "object" || Array.isArray(json)) {
    throw new Error("Expected a JSON object payload");
  }

  return json as JSONObject;
}

function isCoreStreamEventType(type: string) {
  return type.startsWith("https://events.iterate.com/events/stream/") || agentEventTypes.has(type);
}

function toYaml(value: unknown, indent = 0): string {
  if (value == null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value.length === 0
      ? "[]"
      : value
          .map((item) =>
            isScalar(item)
              ? `${" ".repeat(indent)}- ${toYaml(item, indent + 2)}`
              : `${" ".repeat(indent)}-\n${toYaml(item, indent + 2)}`,
          )
          .join("\n");
  }

  const entries = Object.entries(value).filter(([, candidate]) => candidate !== undefined);
  return entries.length === 0
    ? "{}"
    : entries
        .map(([key, candidate]) =>
          isScalar(candidate)
            ? `${" ".repeat(indent)}${key}: ${toYaml(candidate, indent + 2)}`
            : `${" ".repeat(indent)}${key}:\n${toYaml(candidate, indent + 2)}`,
        )
        .join("\n");
}

export const buildConversationFromState = ({
  conversation,
}: {
  conversation: LlmConversationMessage[];
}) => buildConversationInput(conversation);

export const readCompletedPayload = (payload: unknown) => {
  const outputText = readOutputText(payload);
  const requestId = readRequestId(payload);
  return outputText == null || requestId == null ? null : { outputText, requestId };
};

export const readLlmInputPayload = readLlmInput;

export function readRequestId(payload: unknown) {
  return typeof Reflect.get(payload as object, "requestId") === "string"
    ? (Reflect.get(payload as object, "requestId") as string)
    : null;
}

function isScalar(value: unknown) {
  return (
    value == null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}
