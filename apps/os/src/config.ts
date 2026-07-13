import { parseAppConfigFromEnv, publicValue, redacted } from "@iterate-com/shared/config";
import { AppLogsConfig } from "@iterate-com/shared/evlog/types";
import { z } from "zod";

const JSONWebKeySet = z.object({
  keys: z.array(z.looseObject({ kty: z.string().trim().min(1) })),
});

const SlackScope = z.string().trim().min(1);
const GoogleScope = z.string().trim().min(1);

const DEFAULT_SLACK_BOT_SCOPES = [
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

const DEFAULT_GOOGLE_OAUTH_SCOPES = [
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
 * env overrides baked into the worker at deploy time (scripts/deploy.ts)
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
      emailOtpEnabled: publicValue(z.boolean().default(false)),
    })
    .optional(),
  openAiApiKey: redacted(z.string().trim().min(1)),
  /**
   * How agent LLM turns travel through the Cloudflare AI Gateway — see
   * CloudflareAiGatewayTransport in workers-ai-transport.ts. Values come from
   * envs.ts via envShapedVars (APP_CONFIG_CLOUDFLARE_AI_GATEWAY__*), so this
   * is per-deployment, not per-Doppler-secret.
   *
   * `byok` is the default AND what every deployed env sets explicitly: the
   * platform is gpt-5.5-only, unified billing meters OpenAI-prompt-cached
   * tokens at the uncached price (~6x at our hit rate), and BYOK benchmarked
   * latency-neutral-or-better. The default matters for LOCAL DEV, which has
   * no envs.ts entry — dev must ride the same lane as production.
   *
   * `responseCacheTtlSeconds` opts the BYOK lane into the gateway's RESPONSE
   * cache (whole-answer replay — distinct from OpenAI's prompt cache, which
   * BYOK gets unconditionally). Only for deployments whose conversations are
   * synthetic (previews, local dev); never prd.
   */
  cloudflareAiGateway: z
    .object({
      transport: z.enum(["unified", "byok"]).default("byok"),
      id: z.string().trim().min(1).default("default"),
      responseCacheTtlSeconds: z.coerce.number().int().positive().optional(),
    })
    .prefault({}),
  cloudflare: z
    .object({
      accountId: publicValue(z.string().trim().min(1)).optional(),
      artifactsNamespace: publicValue(z.string().trim().min(1)).optional(),
      workerName: publicValue(z.string().trim().min(1)).optional(),
      apiToken: redacted(z.string().trim().min(1)).optional(),
    })
    .default({}),
  projectHostnameBases: publicValue(z.array(z.string().trim().min(1)).default([])),
  /**
   * npm dependency specifier substituted for the `iterate` package when
   * seeding project repos (the template ships the pkg.pr.new `@main` URL).
   * Preview deploys set this to the PR's own pkg.pr.new build so projects
   * created there — e2e tests included — get the branch tip's `iterate/sdk`,
   * not main's. Unset (prod, local dev) keeps the template's `@main`.
   */
  iterateSdkPackageSpec: z.string().trim().min(1).optional(),
  /** First-party project email (itx.email + the inbound email() door). */
  email: z
    .object({
      /**
       * Sender allowlist for inbound project mail: exact addresses
       * (`jonas@example.com`) or whole domains (`*@example.com`). Empty means
       * inbound email is closed — every delivery is rejected at the door.
       * Doppler: `APP_CONFIG_EMAIL__ALLOWED_SENDERS='["*@example.com"]'`.
       */
      allowedSenders: z.array(z.string().trim().min(1)).default([]),
      /**
       * Require a DMARC pass from Cloudflare's inbound MX before an allowlist
       * match counts. Without it the allowlist is spoofable by anyone who can
       * write a From header. Only disable for local dev/synthetic tests.
       */
      requireDmarc: z.boolean().default(true),
    })
    .prefault({}),
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
      /** The deployment's first-party GitHub App. `appId` + `appSlug` are
       * public (JWT issuer, install URL); `privateKey` (PKCS#8 PEM) signs App
       * JWTs — never revealed, only signed with via the platform secret's
       * sign() (ADR 0006); `webhookSecret` verifies inbound App webhooks at the
       * door. `oauth*` remain for any user-authorization flow. All optional so
       * a deployment without a GitHub App still parses. */
      github: z
        .object({
          oauthClientId: publicValue(z.string().trim().min(1)),
          oauthClientSecret: redacted(z.string().trim().min(1)),
          // First-party GitHub App fields (optional): `appSlug` is the App's URL
          // handle (public) — the connect flow deep-links to
          // github.com/apps/<appSlug>/installations/new; `appId` is the JWT
          // issuer (public); `privateKey` (PKCS#8 PEM) signs App JWTs — never
          // revealed, only signed with via the platform secret's sign() (ADR
          // 0006); `webhookSecret` verifies inbound App webhooks at the door.
          // The installation-token minting mechanism is proven via a userspace
          // App; these wire the first-party App once one is registered.
          appSlug: publicValue(z.string().trim().min(1)).optional(),
          appId: publicValue(z.string().trim().min(1)).optional(),
          privateKey: redacted(z.string().trim().min(1)).optional(),
          webhookSecret: redacted(z.string().trim().min(1)).optional(),
        })
        .optional(),
      /** Telegram Bot API integration. Deliberately NO deployment credential:
       * bots connect by BotFather-token paste (`connectTelegram`), and the
       * webhook secret token is derived from SECRET_ENCRYPTION_KEY. The block
       * exists only so tests (and, in a pinch, a proxy deployment) can repoint
       * the Bot API base at a controllable fake server. */
      telegram: z
        .object({
          apiBaseUrl: z.url().default("https://api.telegram.org"),
        })
        .prefault({}),
      /** The dummy third-party used to prove the integrations model end to end
       * (apps/dummy-petshop). Its client credentials back the FIRST-PARTY
       * petshop lane's `{ platform: "integrations.petshop" }` clientCreds ref
       * (resolved by the Secret DO's oauth-refresh-token strategy). */
      petshop: z
        .object({
          /** Deployment-matched dummy provider origin. Platform OAuth client
           * credentials and the tokens they mint are confined to this origin. */
          baseUrl: publicValue(z.url()).optional(),
          oauthClientId: publicValue(z.string().trim().min(1)),
          oauthClientSecret: redacted(z.string().trim().min(1)),
        })
        .optional(),
      /** First-party Parallel API access. This is an Iterate-owned API key,
       * not a per-project connection secret. */
      parallel: z
        .object({
          apiKey: redacted(z.string().trim().min(1)),
        })
        .optional(),
      /** First-party Exa API access. Optional because Exa also exposes a
       * public MCP server that does not require deployment credentials. */
      exa: z
        .object({
          apiKey: redacted(z.string().trim().min(1)),
        })
        .optional(),
    })
    // prefault (not default): `{}` is valid INPUT — the nested telegram block
    // fills its own defaults — but not the parsed output shape.
    .prefault({}),
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
  const config = parseAppConfigFromEnv({
    configSchema: AppConfig,
    prefix: "APP_CONFIG_",
    env: env as Record<string, unknown>,
  });
  const artifactBindings = {
    accountId: readStringBinding(env, "ARTIFACTS_ACCOUNT_ID"),
    namespace: readStringBinding(env, "ARTIFACTS_NAMESPACE"),
  };
  const workerName = readStringBinding(env, "WORKER_SELF");
  const cloudflareBindings: Partial<AppConfig["cloudflare"]> = {};

  if (!config.cloudflare.accountId && artifactBindings.accountId) {
    cloudflareBindings.accountId =
      artifactBindings.accountId as AppConfig["cloudflare"]["accountId"];
  }

  if (!config.cloudflare.artifactsNamespace && artifactBindings.namespace) {
    cloudflareBindings.artifactsNamespace =
      artifactBindings.namespace as AppConfig["cloudflare"]["artifactsNamespace"];
  }

  if (!config.cloudflare.workerName && workerName) {
    cloudflareBindings.workerName = workerName as AppConfig["cloudflare"]["workerName"];
  }

  if (Object.keys(cloudflareBindings).length === 0) {
    return config;
  }

  return {
    ...config,
    cloudflare: {
      ...config.cloudflare,
      ...cloudflareBindings,
    },
  };
}

function readStringBinding(env: unknown, key: string) {
  if (env === null || typeof env !== "object") return null;

  const value = (env as Record<string, unknown>)[key];
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
