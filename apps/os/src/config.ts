import { parseAppConfigFromEnv, publicValue, redacted } from "@iterate-com/shared/config";
import { AppLogsConfig } from "@iterate-com/shared/evlog/types";
import { z } from "zod";

const SlackScope = z.string().trim().min(1);
const GoogleScope = z.string().trim().min(1);
const JSONWebKeySet = z.object({
  keys: z.array(z.looseObject({ kty: z.string().trim().min(1) })),
});

export const DEFAULT_SLACK_BOT_SCOPES = [
  "channels:history",
  "channels:join",
  "channels:manage",
  "channels:read",
  "chat:write",
  "chat:write.public",
  "files:read",
  "files:write",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "im:write",
  "mpim:history",
  "mpim:read",
  "reactions:read",
  "reactions:write",
  "users.profile:read",
  "users:read",
  "users:read.email",
  "assistant:write",
  "conversations.connect:write",
];

export const DEFAULT_GOOGLE_OAUTH_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.labels",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/drive",
];

/**
 * OS runtime config, parsed from the `APP_CONFIG` JSON blob plus `APP_CONFIG_*`
 * env overrides that Doppler/alchemy bake into the worker at deploy time
 * (e.g. `APP_CONFIG_BASE_URL`, `APP_CONFIG_ITERATE_AUTH__CLIENT_SECRET`).
 *
 * `publicValue` fields are exposed to the browser via the public-config schema
 * below; `redacted` fields parse into `Redacted` wrappers that must be
 * explicitly unwrapped with `.exposeSecret()` and never serialize their value.
 */
export const AppConfig = z.object({
  baseUrl: publicValue(z.url().optional()),
  logs: AppLogsConfig.default({
    stdoutFormat: "pretty",
    filtering: { rules: [] },
  }),
  mcp: z
    .object({
      baseUrl: publicValue(z.url()),
    })
    .optional(),
  adminApiSecret: redacted(z.string().trim().min(1)).optional(),
  iterateAuth: z
    .object({
      issuer: publicValue(z.url().default("https://auth.iterate.com/api/auth")),
      clientId: publicValue(z.string().trim().min(1)),
      clientSecret: redacted(z.string().trim().min(1)),
      jwks: JSONWebKeySet.optional(),
      serviceToken: redacted(z.string().trim().min(1)).optional(),
      resource: publicValue(z.url()).optional(),
    })
    .optional(),
  openAiApiKey: redacted(z.string().trim().min(1)),
  cloudflare: z
    .object({
      apiToken: redacted(z.string().trim().min(1)).optional(),
    })
    .default({}),
  projectHostnameBases: publicValue(z.array(z.string().trim().min(1)).default([])),
  integrations: z
    .object({
      slack: z
        .object({
          oauthClientId: publicValue(z.string().trim().min(1)),
          oauthClientSecret: redacted(z.string().trim().min(1)),
          webhookSigningSecret: redacted(z.string().trim().min(1)),
          scopes: publicValue(z.array(SlackScope).default(DEFAULT_SLACK_BOT_SCOPES)),
        })
        .optional(),
      google: z
        .object({
          oauthClientId: publicValue(z.string().trim().min(1)),
          oauthClientSecret: redacted(z.string().trim().min(1)),
          scopes: publicValue(z.array(GoogleScope).default(DEFAULT_GOOGLE_OAUTH_SCOPES)),
        })
        .optional(),
      // iterate's GitHub App (migrated from os-legacy-backup Doppler).
      // appId + privateKey mint App JWTs -> installation tokens (the script-
      // derivation gap); oauthClient* serve the user OAuth flow; the webhook
      // signing secret verifies ingress.
      github: z
        .object({
          appId: publicValue(z.string().trim().min(1)),
          appSlug: publicValue(z.string().trim().min(1)),
          oauthClientId: publicValue(z.string().trim().min(1)),
          oauthClientSecret: redacted(z.string().trim().min(1)),
          privateKey: redacted(z.string().trim().min(1)),
          webhookSigningSecret: redacted(z.string().trim().min(1)),
        })
        .optional(),
    })
    .default({}),
  // Extra itx dial allowlist entries for this deployment, merged with the
  // hardcoded DIALABLE_BINDINGS / DIALABLE_LOOPBACKS defaults (itx-next.md
  // §2). Config can only WIDEN the lists — the defaults always apply.
  itx: z
    .object({
      dialableBindings: publicValue(z.array(z.string().trim().min(1)).default([])),
      dialableDurableObjects: publicValue(z.array(z.string().trim().min(1)).default([])),
      dialableLoopbacks: publicValue(z.array(z.string().trim().min(1)).default([])),
    })
    .optional(),
  slackBotToken: redacted(z.string().trim().min(1)).optional(),
  typeIdPrefix: z
    .string()
    .trim()
    .regex(/^[a-z]+$/, "Type ID prefix must contain lowercase letters only")
    .default("os"),
  posthog: z
    .object({
      apiKey: publicValue(z.string().trim().min(1)),
    })
    .optional(),
});

export type AppConfig = z.output<typeof AppConfig>;

/**
 * Parse OS config from a worker or durable object `env` (the `cloudflare:workers`
 * import, `this.env`, an `ExecutionContext`'s bindings — all `APP_CONFIG_*`
 * carriers). Accepts `unknown` so callers don't need a cast at every site.
 */
export function parseConfig(env: unknown): AppConfig {
  return parseAppConfigFromEnv({
    configSchema: AppConfig,
    prefix: "APP_CONFIG_",
    env: env as Record<string, unknown>,
  });
}
