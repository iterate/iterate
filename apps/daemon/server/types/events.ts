export interface PromptEvent {
  type: "prompt";
  message: string;
}

export type IterateEvent = PromptEvent;

export function isPromptEvent(event: unknown): event is PromptEvent {
  return (
    typeof event === "object" &&
    event !== null &&
    "type" in event &&
    event.type === "prompt" &&
    "message" in event &&
    typeof event.message === "string"
  );
}
