// Shared constants + path/name primitives for the integrations domain. The
// path helpers ARE the address model: /integrations/{slug}/{connection} and
// its projections (thread paths, secret paths, connection-from-path).

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
]);

export const SLACK_CONNECTED_EVENT_TYPE = "events.iterate.com/slack/connected";
export const SLACK_DISCONNECTED_EVENT_TYPE = "events.iterate.com/slack/disconnected";
export const SLACK_WEBHOOK_RECEIVED_EVENT_TYPE = "events.iterate.com/slack/webhook-received";

export const GOOGLE_CONNECTED_EVENT_TYPE = "events.iterate.com/google/connected";
export const GOOGLE_DISCONNECTED_EVENT_TYPE = "events.iterate.com/google/disconnected";

export const GITHUB_CONNECTED_EVENT_TYPE = "events.iterate.com/github/connected";
export const GITHUB_DISCONNECTED_EVENT_TYPE = "events.iterate.com/github/disconnected";

export function readRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
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
 * facts, token ciphertext (google), and the webhook router's events (slack)
 * all live at `/integrations/{slug}/{connection}`.
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

/** The v6 Google connection secret: holds `{ accessToken, refreshToken }` and
 * hosts the refresh worker (google-worker.ts). Egress-pinned to the token +
 * Gmail hosts; the worker refreshes the access token on a 401. */
export function googleConnectionSecretPath(connection: string): string {
  return `/secrets/integrations/google/${connection}`;
}

/** Hosts a Google connection secret's egress is pinned to: the token endpoint
 * (refresh) and the Gmail API (consumer calls). */
export const GOOGLE_CONNECTION_EGRESS_URLS = [
  "https://oauth2.googleapis.com",
  "https://gmail.googleapis.com",
];

/** Itx secret Durable Object path holding one GitHub connection's user token.
 * Consumed two ways: `getSecret` placeholder substitution for API calls
 * through project egress, and the audited platform reveal that hands `gh`
 * inside a sandbox its GH_TOKEN. */
export function githubTokenSecretPath(connection: string): string {
  return `/secrets/integrations/github/${connection}/token`;
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
 * notably the three-segment team directory stream and the project root.
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
