import { z } from "zod/v4";

export const INTEGRATIONS_SLACK_WEBHOOK_RECEIVED_TYPE =
  "https://events.iterate.com/integrations/slack/webhook-received" as const;
export const AGENTS_PROMPT_ADDED_TYPE = "https://events.iterate.com/agents/prompt-added" as const;
export const AGENTS_STATUS_UPDATED_TYPE =
  "https://events.iterate.com/agents/status-updated" as const;
export const AGENTS_RESPONSE_ADDED_TYPE =
  "https://events.iterate.com/agents/response-added" as const;
export const AGENTS_ERROR_TYPE = "https://events.iterate.com/agents/error" as const;

export const SlackReplyTarget = z.object({
  channel: z.string().min(1),
  threadTs: z.string().min(1),
});
export type SlackReplyTarget = z.infer<typeof SlackReplyTarget>;

export const SlackWebhookReceivedPayload = z.object({
  source: z.literal("slack"),
  channel: z.string().min(1),
  threadTs: z.string().min(1),
  ts: z.string().min(1),
  user: z.string().optional(),
  subtype: z.string().optional(),
  text: z.string().min(1),
  receivedAt: z.string().datetime({ offset: true }),
});
export type SlackWebhookReceivedPayload = z.infer<typeof SlackWebhookReceivedPayload>;

export const AgentPromptAddedPayload = z.object({
  prompt: z.string().min(1),
  source: z.literal("slack"),
  virtualAgentPath: z.string().min(1),
  replyTarget: SlackReplyTarget,
});
export type AgentPromptAddedPayload = z.infer<typeof AgentPromptAddedPayload>;

export const AgentStatusPhase = z.enum(["thinking", "tool-running", "responding", "idle", "error"]);
export type AgentStatusPhase = z.infer<typeof AgentStatusPhase>;

export const AgentStatusUpdatedPayload = z.object({
  phase: AgentStatusPhase,
  text: z.string().optional(),
  emoji: z.string().optional(),
  replyTarget: SlackReplyTarget.optional(),
});
export type AgentStatusUpdatedPayload = z.infer<typeof AgentStatusUpdatedPayload>;

export const AgentResponseAddedPayload = z.object({
  text: z.string().min(1),
  replyTarget: SlackReplyTarget.optional(),
  model: z.string().optional(),
});
export type AgentResponseAddedPayload = z.infer<typeof AgentResponseAddedPayload>;

export const AgentErrorPayload = z.object({
  message: z.string().min(1),
  code: z.string().optional(),
  retryable: z.boolean().optional(),
  replyTarget: SlackReplyTarget.optional(),
});
export type AgentErrorPayload = z.infer<typeof AgentErrorPayload>;
