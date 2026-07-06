/**
 * Integration (Slack + Google) data shapes shared by the connection flows, the
 * webhook router, and the itx `integrations` capability surface.
 */

export type IntegrationProvider = "google" | "slack";

export type GmailRequestInput = {
  body?: unknown;
  headers?: Record<string, string>;
  method?: string;
  path: string;
  query?: Record<string, boolean | number | string | null | undefined>;
};

export type IntegrationConnectionStatus = {
  connected: boolean;
  displayName: string | null;
  externalId: string | null;
  metadata: Record<string, unknown>;
};

export type CompleteConnectResult =
  | { callbackUrl: string | null; ok: true }
  | { callbackUrl: string | null; error: string; ok: false };

export type RouteSlackWebhookResult =
  | { ok: true; projectId: string }
  | { ignored: "team-not-claimed"; ok: true };
