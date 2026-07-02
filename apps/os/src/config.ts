import { parseAppConfigFromEnv, publicValue, redacted } from "@iterate-com/shared/config";
import { AppLogsConfig } from "@iterate-com/shared/evlog/types";
import { z } from "zod";

const JSONWebKeySet = z.object({
  keys: z.array(z.looseObject({ kty: z.string().trim().min(1) })),
});

const SlackScope = z.string().trim().min(1);
const GoogleScope = z.string().trim().min(1);

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
      // NOTE: there is deliberately no serviceToken here anymore. Runtime
      // OS→auth calls authenticate by holding the AUTH service binding
      // (the AUTH service binding, see src/env.ts); only deploy-time Node scripts
      // still use the shared secret, and they read it from plain env vars.
      resource: publicValue(z.url()).optional(),
      emailOtpEnabled: publicValue(z.boolean().default(false)),
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
          botToken: redacted(z.string().trim().min(1)).optional(),
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
    })
    .default({}),
  /** Legacy deployment-wide Slack bot token fallback. New configs should set
   * `integrations.slack.botToken` so each Slack app owns its own token. */
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
