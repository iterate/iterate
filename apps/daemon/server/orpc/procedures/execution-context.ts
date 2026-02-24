import type { WebClient } from "@slack/web-api";
import type Replicate from "replicate";
import type { Resend } from "resend";

export interface WebchatClient {
  postMessage(params: {
    threadId: string;
    text?: string;
    attachments?: unknown[];
  }): Promise<unknown>;
  addReaction(params: { threadId: string; messageId: string; reaction: string }): Promise<unknown>;
  removeReaction(params: {
    threadId: string;
    messageId: string;
    reaction: string;
  }): Promise<unknown>;
  getThreadMessages(params: { threadId: string }): Promise<unknown>;
  listThreads(): Promise<unknown>;
}

export interface ExecutionContext {
  slack: WebClient;
  resend: Resend;
  replicate: Replicate;
  webchat: WebchatClient;
}
