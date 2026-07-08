/**
 * Integration data shapes shared by the connection flows, the webhook router,
 * and the itx `integrations` capability surface. The unit is a CONNECTION at a
 * fully qualified path `/integrations/<slug>/<connection>` — one integration
 * (slack) can hold many connections (main-slack, support-slack).
 */

/** The integration slugs whose call surfaces ship with the OS deployment
 * (mirrored by BUILTIN_INTEGRATION_SLUGS in domains/integrations/utils.ts). */
export type BuiltinIntegrationSlug = "github" | "google" | "slack";

/** Input to `itx.integrations.google["<connection>"].gmail.request(...)` — a
 * Gmail REST call relative to https://gmail.googleapis.com/gmail/v1; the
 * response is `{ data, headers, status, statusText }`. */
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

/**
 * One entry of `integrations.list()`. Discriminated on `source`: built-in
 * entries always name a concrete connection (they come from
 * `/integrations/<slug>/<connection>` journals); provided entries may be
 * integration-level mounts (`connection: null` — one recipe serving every
 * connection name beneath it, path `/integrations/<slug>`).
 */
export type IntegrationConnectionListEntry =
  | {
      connection: string;
      integration: BuiltinIntegrationSlug;
      /** The fully qualified connection path, e.g. `/integrations/slack/main-slack`. */
      path: string;
      source: "builtin";
    }
  | {
      connection: string | null;
      integration: string;
      path: string;
      source: "provided";
    };

export type CompleteConnectResult =
  | { callbackUrl: string | null; ok: true }
  | { callbackUrl: string | null; error: string; ok: false };
