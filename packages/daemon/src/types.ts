export interface Message {
  offset: string;
  content: unknown;
  timestamp: string;
  source: string;
  metadata: Record<string, unknown>;
}

// Control events that trigger actions after being appended to the stream
export type ControlEvent =
  | { type: "iterate:control"; action: "prompt"; payload: { text: string } };

export function isControlEvent(content: unknown): content is ControlEvent {
  return (
    typeof content === "object" &&
    content !== null &&
    (content as Record<string, unknown>).type === "iterate:control"
  );
}

import type { AgentSession } from "@mariozechner/pi-coding-agent";

export interface Agent {
  id: string;
  contentType: string;
  createdAt: string;
  messages: Message[];
  subscribers: Set<ReadableStreamDefaultController>;
  piSession?: AgentSession;
  nextOffset: number;
}

export interface SlackEvent {
  type: string;
  ts: string;
  thread_ts?: string;
  channel?: string;
  user?: string;
  text?: string;
  [key: string]: unknown;
}

export interface SlackWebhook {
  type: string;
  event?: SlackEvent;
  challenge?: string;
  [key: string]: unknown;
}
