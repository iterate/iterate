import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { SlackContext } from "./pi/custom-tools.ts";

export interface Message {
  offset: string;
  content: unknown;
  timestamp: string;
  source: string;
  metadata: Record<string, unknown>;
}

export interface Agent {
  id: string;
  contentType: string;
  createdAt: string;
  messages: Message[];
  subscribers: Set<ReadableStreamDefaultController>;
  piSession?: AgentSession;
  nextOffset: number;
  slackContext?: SlackContext;
}

export interface SlackEvent {
  type: string;
  ts: string;
  thread_ts?: string;
  channel?: string;
  user?: string;
  text?: string;
  bot_id?: string;
  [key: string]: unknown;
}

export interface SlackWebhook {
  type: string;
  event?: SlackEvent;
  challenge?: string;
  [key: string]: unknown;
}
