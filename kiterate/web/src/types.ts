/**
 * Local type definitions to avoid external dependencies
 */

export interface FileUIPart {
  type: "file";
  url?: string;
  mediaType?: string;
  filename?: string;
}

export type MessageRole = "user" | "assistant" | "system" | "tool";

export interface UIMessage {
  id: string;
  role: MessageRole;
  content: string;
  parts?: unknown[];
}
