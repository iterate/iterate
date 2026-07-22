/**
 * Integration data shapes shared by the connection flows, the webhook router,
 * and the itx `integrations` capability surface. The unit is a CONNECTION at a
 * fully qualified path `/integrations/<slug>/<connection>` — one integration
 * (slack) can hold many connections (main-slack, support-slack).
 */

import type { WakeableStreamProcessorRpc } from "iterate/processors";

/** The integration slugs whose call surfaces ship with the OS deployment
 * (mirrored by BUILTIN_INTEGRATION_SLUGS in domains/integrations/utils.ts). */
export type BuiltinIntegrationSlug = "github" | "google" | "slack" | "telegram" | "waitrose";

/** Public connection-family names. Google OAuth is presented as the Gmail
 * capability it actually supplies, while management APIs retain the provider
 * slug `google`. */
export type PublicBuiltinIntegrationSlug = "github" | "gmail" | "slack" | "telegram" | "waitrose";

/** The built-ins that connect via a redirect flow (OAuth code exchange or
 * GitHub App installation) — the `startOAuthFlow`/`completeConnect` pair.
 * Telegram is excluded: it connects by bot-token paste (`connectTelegram`),
 * with no redirect and no signed state. Waitrose is excluded too: it connects
 * by writing the connection secret (username/password plus the
 * `waitrose-session` refresh strategy) — the Secret DO logs in itself on
 * first use. */
export type OAuthProviderSlug = Exclude<BuiltinIntegrationSlug, "telegram" | "waitrose">;

/** Input to `itx.integrations.gmail.get("<connection>").request(...)` — a
 * Gmail REST call relative to https://gmail.googleapis.com/gmail/v1; the
 * response is `{ data, headers, status, statusText }`. */
export type GmailRequestInput = {
  body?: unknown;
  headers?: Record<string, string>;
  method?: string;
  path: string;
  query?: Record<string, boolean | number | string | null | undefined>;
};

/** A connection family on `itx.integrations`. `get()` selects the first
 * connected account; pass a slug only when the exact account matters. The
 * return value is an RPC capability (not a Promise), so calls pipeline in one
 * expression: `itx.integrations.github.get().octokit.rest.repos.get(...)`. */
export type IntegrationFamily<Connection> = {
  get(connection?: string): Connection;
};

/** The normal all-in-one Octokit package with iterate supplying GitHub App
 * installation auth and transport. Both REST and GraphQL are available. */
export type GithubConnection = { octokit: import("octokit").Octokit };

/** A Slack WebClient connection. Web API namespaces and methods are dynamic;
 * `processor` is the connection's durable webhook router. */
export type SlackConnection = Record<string, any> & {
  processor: WakeableStreamProcessorRpc;
};

/** The Gmail REST API connection exposed by a connected Google account.
 * `data` is whatever the addressed REST resource returns — the caller
 * supplies the expected shape via `request<T>` (no invented Gmail schemas
 * here); it defaults to the honest `unknown` when uninstantiated. */
export type GmailConnection = {
  request<T = unknown>(
    input: GmailRequestInput,
  ): Promise<{
    data: T;
    headers: Record<string, string>;
    status: number;
    statusText: string;
  }>;
};

/** The commonly used Telegram Bot API surface. The runtime accepts every
 * flat Bot API method with one params object; these members keep the generated
 * script types useful without maintaining a second copy of Telegram's API. */
export type TelegramConnection = {
  getMe(params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  processor: WakeableStreamProcessorRpc;
  sendChatAction(params: Record<string, unknown>): Promise<Record<string, unknown>>;
  sendMessage(
    params: { chat_id: number | string; text: string } & Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  sendPhoto(params: Record<string, unknown>): Promise<Record<string, unknown>>;
};

/** iterate's small, connection-scoped Waitrose client. */
export type WaitroseConnection = {
  addToTrolley(lineNumber: string, quantity?: number): Promise<Record<string, unknown>>;
  removeFromTrolley(lineNumber: string): Promise<Record<string, unknown>>;
  searchProducts(
    searchTerm: string,
    options?: { size?: number; sortBy?: string; start?: number },
  ): Promise<{
    products: Array<{ displayPrice?: string; lineNumber: string; name: string; size?: string }>;
    totalMatches: number;
  }>;
  shoppingContext(): Promise<{
    customerId: string;
    customerOrderId: string;
    customerOrderState: string;
    defaultBranchId: string;
  }>;
  trolley(orderId?: string): Promise<Record<string, unknown>>;
  updateTrolleyItems(
    items: Array<{
      canSubstitute?: boolean;
      lineNumber: string;
      noteToShopper?: string;
      quantity: { amount: number; uom: string };
    }>,
    orderId?: string,
  ): Promise<Record<string, unknown>>;
};

/** Connection health for one integration connection (what
 * `getConnectionStatus` returns): whether it is connected, plus the external
 * account's id, display name, and provider-specific metadata. */
export type IntegrationConnectionStatus = {
  connected: boolean;
  displayName: string | null;
  externalId: string | null;
  metadata: Record<string, unknown>;
};

/**
 * One entry of `integrations.list()`. Discriminated on `source`: built-in
 * entries always name a concrete connection (normally from
 * `/integrations/<slug>/<connection>` journals; credential-defined Waitrose
 * connections come from their session-secret paths); provided entries may be
 * integration-level mounts (`connection: null` — one recipe serving every
 * connection name beneath it, path `/integrations/<slug>`).
 */
export type IntegrationConnectionListEntry =
  | {
      connection: string;
      integration: PublicBuiltinIntegrationSlug;
      /** The internal connection path, e.g. `/integrations/slack/main-slack`;
       * Gmail entries retain their `/integrations/google/...` journal path. */
      path: string;
      source: "builtin";
    }
  | {
      connection: string | null;
      integration: string;
      path: string;
      source: "provided";
    };

/** Outcome of `completeConnect` (the OAuth/installation redirect callback):
 * `ok` plus the browser's next URL (a provider authorization URL for an
 * intermediate step, otherwise the product callback); on failure, a
 * human-readable `error`. */
export type CompleteConnectResult =
  | { callbackUrl: string | null; ok: true }
  | { callbackUrl: string | null; error: string; ok: false };
