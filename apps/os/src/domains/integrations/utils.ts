// Shared constants + tiny readers for the integrations domain (Phase 12
// resurrection of the pre-migration slack/google plumbing). Cruft acceptable
// here by design — behavior mirrors the pre-migration reference (git history).

/** Per-project stream that receives raw Slack webhooks + connect/disconnect facts. */
export const SLACK_INTEGRATION_STREAM_PATH = "/integrations/slack";

/** Per-project stream holding Google OAuth token facts (AES-GCM ciphertext payloads). */
export const GOOGLE_INTEGRATION_STREAM_PATH = "/integrations/google";

/**
 * Deployment-wide (projectId: null) stream mapping Slack team ids to the
 * project that claimed them. The webhook route folds this to decide where a
 * validly-signed event should land; the OAuth callback appends claims here.
 */
export const SLACK_TEAM_DIRECTORY_STREAM_PATH = "/integrations/slack-team-directory";

/** Itx secret Durable Object path holding the project's Slack bot token. */
export const SLACK_BOT_TOKEN_SECRET_PATH = "/secrets/integrations/slack/bot-token";

export const SLACK_CONNECTED_EVENT_TYPE = "events.iterate.com/slack/connected";
export const SLACK_DISCONNECTED_EVENT_TYPE = "events.iterate.com/slack/disconnected";
export const SLACK_WEBHOOK_RECEIVED_EVENT_TYPE = "events.iterate.com/slack/webhook-received";
export const SLACK_TEAM_CLAIMED_EVENT_TYPE = "events.iterate.com/slack/team-claimed";
export const SLACK_TEAM_UNCLAIMED_EVENT_TYPE = "events.iterate.com/slack/team-unclaimed";

export const GOOGLE_CONNECTED_EVENT_TYPE = "events.iterate.com/google/connected";
export const GOOGLE_DISCONNECTED_EVENT_TYPE = "events.iterate.com/google/disconnected";
export const GOOGLE_TOKEN_REFRESHED_EVENT_TYPE = "events.iterate.com/google/token-refreshed";

export function readRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function sanitizePathPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
}

/** The routed agent stream path for one Slack thread. Stable wire shape. */
export function slackThreadStreamPath(input: { channel: string; threadTs: string }): string {
  return `/agents/slack/${sanitizePathPart(input.channel)}/ts-${sanitizePathPart(input.threadTs)}`;
}

export function isSlackAgentPath(agentPath: string): boolean {
  const normalized = agentPath.toLowerCase();
  return normalized === "/agents/slack" || normalized.startsWith("/agents/slack/");
}
