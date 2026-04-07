import type { Event } from "ai-engineer-workshop";

export const invalidEventAppendedType =
  "https://events.iterate.com/events/stream/invalid-event-appended" as const;
export const slackMessageAddedType = "slack-message-added" as const;

export function readSlackWebhook(event: Event) {
  if (event.type !== invalidEventAppendedType) {
    return null;
  }

  const rawInput = Reflect.get(event.payload as object, "rawInput");
  const responseUrl = Reflect.get(rawInput as object, "response_url");
  const text = Reflect.get(rawInput as object, "text");
  if (typeof responseUrl !== "string" || typeof text !== "string") {
    return null;
  }

  return { responseUrl, text };
}
