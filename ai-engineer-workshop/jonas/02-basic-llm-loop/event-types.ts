/**
 * URL-style event types for the events app (see apps/events-contract).
 */
export const INPUT_ITEM_ADDED_TYPE = "https://events.iterate.com/agent/input-item-added" as const;
export const OUTPUT_ITEM_ADDED_TYPE = "https://events.iterate.com/agent/output-item-added" as const;

export type ChatItem = {
  role: "user" | "assistant" | "system";
  content: string;
};

export type InputItemAddedPayload = {
  item: ChatItem;
};

export type OutputItemAddedPayload = {
  /** Offset of the input event that triggered this LLM run */
  sourceOffset: string;
  /** Raw TanStack AI stream chunk (AG-UI protocol), JSON-serializable */
  chunk: unknown;
};

export function isInputItemAddedType(type: string): type is typeof INPUT_ITEM_ADDED_TYPE {
  return type === INPUT_ITEM_ADDED_TYPE;
}
