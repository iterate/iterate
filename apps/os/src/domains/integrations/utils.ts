// Shared constants + path/name primitives for the integrations domain. The
// path helpers ARE the address model: /integrations/{slug}/{connection} and
// its projections (thread paths, secret paths, connection-from-path).

import { computeHmacHex } from "../secrets/utils.ts";
import type { BuiltinIntegrationSlug } from "./types.ts";

/**
 * Deployment-wide (projectId: null) stream mapping `(slug, externalId)` — a
 * provider-side account id like a Slack team id or a GitHub installation id —
 * to the project + named connection that claimed it. The generic webhook door
 * folds this to route a validly-signed event; connect/disconnect append the
 * claim/unclaim (D4). Provider-agnostic: one directory for every integration.
 */
export const INTEGRATION_DIRECTORY_STREAM_PATH = "/integrations/_directory";

/** Directory claim/unclaim facts, payload `{ slug, externalId, projectId,
 * connection }` — see `foldConnectionDirectory`. */
export const CONNECTION_CLAIMED_EVENT_TYPE = "events.iterate.com/integration/connection-claimed";
export const CONNECTION_UNCLAIMED_EVENT_TYPE =
  "events.iterate.com/integration/connection-unclaimed";

/**
 * The integration slugs whose call surfaces ship with the OS deployment. ONE
 * constant on purpose — the collection's dispatch, list()'s source labeling,
 * and the capability-mount collision guard all consume it, so a new builtin
 * cannot silently miss one of them.
 */
export const BUILTIN_INTEGRATION_SLUGS: ReadonlySet<string> = new Set([
  "slack",
  "google",
  "github",
  "telegram",
]);

/** Type-guard view of {@link BUILTIN_INTEGRATION_SLUGS}: narrows an arbitrary
 * slug string to the BuiltinIntegrationSlug union. */
export function isBuiltinIntegrationSlug(slug: string): slug is BuiltinIntegrationSlug {
  return BUILTIN_INTEGRATION_SLUGS.has(slug);
}

export const SLACK_CONNECTED_EVENT_TYPE = "events.iterate.com/slack/connected";
export const SLACK_DISCONNECTED_EVENT_TYPE = "events.iterate.com/slack/disconnected";
export const SLACK_WEBHOOK_RECEIVED_EVENT_TYPE = "events.iterate.com/slack/webhook-received";

export const GOOGLE_CONNECTED_EVENT_TYPE = "events.iterate.com/google/connected";
export const GOOGLE_DISCONNECTED_EVENT_TYPE = "events.iterate.com/google/disconnected";

export const GITHUB_CONNECTED_EVENT_TYPE = "events.iterate.com/github/connected";
export const GITHUB_DISCONNECTED_EVENT_TYPE = "events.iterate.com/github/disconnected";
export const GITHUB_WEBHOOK_RECEIVED_EVENT_TYPE = "events.iterate.com/github/webhook-received";

export const TELEGRAM_CONNECTED_EVENT_TYPE = "events.iterate.com/telegram/connected";
export const TELEGRAM_DISCONNECTED_EVENT_TYPE = "events.iterate.com/telegram/disconnected";
export const TELEGRAM_WEBHOOK_RECEIVED_EVENT_TYPE = "events.iterate.com/telegram/webhook-received";
// The journaled-send pair (`telegram/send-requested` → `telegram/message-sent`)
// is declared on the telegram processor contracts, not here: contract event
// catalogs need literal keys, and no door-side code composes those strings.

/**
 * How old a webhook may be and still deserve its user-visible acknowledgement
 * (the 👀 reaction, the assistant status). Acks mean "your message was just
 * picked up" — they are only meaningful near arrival. A full journal refold
 * (the normal aftermath of deploying a state-schema change) or a late wake
 * replays historical webhooks; re-acking those would resurrect reactions on
 * old messages, and a burst of them is a Slack rate-limit crash-loop
 * (docs/writing-stream-processors.md, "Refold safety").
 */
const WEBHOOK_ACK_FRESHNESS_MS = 15 * 60_000;

/** Whether an event is young enough for its acknowledgement lane to act. */
export function webhookAckIsFresh(event: { createdAt: string }, now: number): boolean {
  return now - Date.parse(event.createdAt) <= WEBHOOK_ACK_FRESHNESS_MS;
}

export function readRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Parse a body as a JSON object; null for non-JSON or non-object bodies
 * (arrays included) — the webhook doors ACK-and-drop those. */
export function parseJsonRecord(body: string): Record<string, unknown> | null {
  try {
    return readRecord(JSON.parse(body) as unknown);
  } catch {
    return null;
  }
}

export function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** `value` as a finite number when it is one; undefined otherwise (webhook bodies are untrusted). */
export function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Normalizes an arbitrary string (Slack team domain, Gmail local part, …) into
 * a connection name that is safe as a single path segment: lowercased, runs of
 * characters outside `[a-z0-9_-]` collapsed to `-`, and leading/trailing `-`
 * stripped. May return "" — callers must supply their own fallback.
 */
export function sanitizeConnectionName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Per-project stream for one named integration connection: connect/disconnect
 * facts and the webhook router's events (slack) all live at
 * `/integrations/{slug}/{connection}`.
 */
export function integrationConnectionStreamPath(slug: string, connection: string): string {
  return `/integrations/${slug}/${connection}`;
}

/** Itx secret Durable Object path holding one Slack connection's bot token. */
export function slackBotTokenSecretPath(connection: string): string {
  return `/secrets/integrations/slack/${connection}/bot-token`;
}

/** Google's OAuth token endpoint (code exchange + refresh). */
export const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

/** The Google connection secret: holds `{ accessToken, refreshToken }`; the
 * shared oauth-refresh-token strategy refreshes on 401 in the Secret DO. */
export function googleConnectionSecretPath(connection: string): string {
  return `/secrets/integrations/google/${connection}`;
}

/** Hosts a Google connection secret's egress is pinned to: the token endpoint
 * (refresh) and the Gmail API (consumer calls). */
export const GOOGLE_CONNECTION_EGRESS_URLS = [
  "https://oauth2.googleapis.com",
  "https://gmail.googleapis.com",
];

/** The GitHub connection secret: material is just `{ accessToken }` (minted on
 * first use), and the secret carries the github-app-installation refresh
 * strategy — trusted DO code signs an App JWT to mint the installation token
 * and re-mints on 401. Octokit rides this secret's `fetch()` with an
 * `accessToken` placeholder (github-api.ts), same connection-root shape as
 * Google. */
export function githubConnectionSecretPath(connection: string): string {
  return `/secrets/integrations/github/${connection}`;
}

/**
 * The `getSecret` header placeholder for one GitHub connection's installation
 * token: the connection secret's `accessToken` field, substituted (and minted
 * on first use / re-minted on 401) only at the project egress door. One
 * builder so the wrapped Octokit's Authorization header (github-api.ts) and
 * the sandbox `GH_TOKEN` env var can't drift from the material's field name.
 */
export function githubAccessTokenPlaceholder(connection: string): string {
  return `getSecret({ path: "${githubConnectionSecretPath(connection)}", field: "accessToken" })`;
}

/** Hosts a GitHub connection secret's egress is pinned to: the API (REST +
 * installation-token mint), plus github.com/uploads/objects as deliberate
 * headroom for release assets and upload/redirect hosts Octokit may follow. */
export const GITHUB_CONNECTION_EGRESS_URLS = [
  "https://api.github.com",
  "https://github.com",
  "https://uploads.github.com",
  "https://objects.githubusercontent.com",
];

/** Itx secret Durable Object path holding one Telegram connection's bot token. */
export function telegramBotTokenSecretPath(connection: string): string {
  return `/secrets/integrations/telegram/${connection}/bot-token`;
}

/**
 * The stateless `X-Telegram-Bot-Api-Secret-Token` for one bot's webhook,
 * derived from the deployment's SECRET_ENCRYPTION_KEY — same spirit as
 * oauth-state.ts. Both halves compute it independently: the connect flow
 * passes it to `setWebhook`, the webhook door verifies the header against it.
 * Nothing is stored and no new deployment secret exists (previews work with
 * zero config changes). Hex output satisfies Telegram's 1–256 chars of
 * `[A-Za-z0-9_-]`.
 */
export function telegramWebhookSecretToken(input: {
  botId: string;
  keyMaterial: string;
}): Promise<string> {
  return computeHmacHex({ key: input.keyMaterial, payload: `telegram-webhook:${input.botId}` });
}

/**
 * The routed agent stream path for one Telegram chat of one named connection:
 * `/agents/telegram/{connection}/chat-{chatId}`, plus a `/topic-{threadId}`
 * segment for forum supergroup topics. Chat ids are Telegram-issued integers
 * (negative for groups/channels) used verbatim — the sign is significant
 * (chat 42 and group -42 must not collide), and digits/minus are already safe
 * path characters, so no sanitization.
 */
export function telegramChatStreamPath(input: {
  chatId: string;
  connection: string;
  messageThreadId?: string;
  /** The `/new` session start, as unix seconds (the /new message's `date`).
   * Omitted = session zero: the bare chat path, which is exactly the v1
   * shape, so chats keep their history until their first `/new`. */
  session?: string;
}): string {
  const base = `/agents/telegram/${input.connection}/chat-${input.chatId}`;
  const topical =
    input.messageThreadId === undefined ? base : `${base}/topic-${input.messageThreadId}`;
  return input.session === undefined ? topical : `${topical}/session-${input.session}`;
}

/**
 * Connection segment of a routed Telegram agent path
 * (`/agents/telegram/{connection}/chat-{chatId}[/topic-{threadId}]`), or null
 * when the path is not a connection-qualified Telegram agent path.
 */
export function telegramConnectionFromAgentPath(agentPath: string): string | null {
  const segments = agentPath.split("/");
  if (segments.length >= 5 && segments[1] === "agents" && segments[2] === "telegram") {
    return segments[3] || null;
  }
  return null;
}

/** Chat id of a routed Telegram agent path (the `chat-{chatId}` segment), or
 * null. The id is what `sendMessage({ chat_id })` wants — the agent's system
 * prompt embeds it so replies need no payload spelunking. */
export function telegramChatIdFromAgentPath(agentPath: string): string | null {
  const segments = agentPath.split("/");
  if (segments.length >= 5 && segments[1] === "agents" && segments[2] === "telegram") {
    const chatSegment = segments[4]!;
    if (chatSegment.startsWith("chat-")) return chatSegment.slice("chat-".length) || null;
  }
  return null;
}

/** Forum topic id of a routed Telegram agent path (the optional
 * `topic-{threadId}` segment after the chat segment), or null. The journaled
 * send effect passes it back as `message_thread_id` so replies land in the
 * right topic. */
export function telegramTopicIdFromAgentPath(agentPath: string): string | null {
  const segments = agentPath.split("/");
  if (segments.length >= 6 && segments[1] === "agents" && segments[2] === "telegram") {
    const topicSegment = segments[5]!;
    if (topicSegment.startsWith("topic-")) return topicSegment.slice("topic-".length) || null;
  }
  return null;
}

/**
 * The routed agent stream path for one Slack thread of one named connection.
 * Stable wire shape: `/agents/slack/{connection}/{channel}/ts-{threadTs}`.
 * The connection segment is already sanitized by construction
 * (sanitizeConnectionName at connect time); channel and ts are sanitized here
 * with the same rule.
 */
export function slackThreadStreamPath(input: {
  channel: string;
  connection: string;
  threadTs: string;
}): string {
  return `/agents/slack/${input.connection}/${sanitizeConnectionName(input.channel)}/ts-${sanitizeConnectionName(input.threadTs)}`;
}

/**
 * Connection segment of a routed Slack agent path
 * (`/agents/slack/{connection}/{channel}/ts-{ts}`), or null when the path is
 * not a connection-qualified Slack agent path.
 */
export function slackConnectionFromAgentPath(agentPath: string): string | null {
  const segments = agentPath.split("/");
  if (segments.length >= 6 && segments[1] === "agents" && segments[2] === "slack") {
    return segments[3] || null;
  }
  return null;
}

/**
 * The `{ slug, connection }` coordinates of an integration connection stream
 * path (`/integrations/{slug}/{connection}`), or null for any other path —
 * notably the connection directory stream and the project root.
 */
export function integrationCoordinatesFromStreamPath(
  path: string,
): { connection: string; slug: string } | null {
  const segments = path.split("/");
  if (segments.length !== 4 || segments[0] !== "" || segments[1] !== "integrations") return null;
  if (!segments[2] || !segments[3]) return null;
  return { connection: segments[3], slug: segments[2] };
}

/** Connection segment of an integration connection stream path, or null. */
export function connectionFromIntegrationStreamPath(path: string): string | null {
  return integrationCoordinatesFromStreamPath(path)?.connection ?? null;
}
