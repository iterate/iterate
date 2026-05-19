import { BaseAppConfig, publicValue, redacted } from "@iterate-com/shared/apps/config";
import type { AppManifest } from "@iterate-com/shared/apps/types";
import { z } from "zod";
import packageJson from "../package.json" with { type: "json" };

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

export const AppConfig = BaseAppConfig.extend({
  baseUrl: publicValue(z.url()).optional(),
  adminApiSecret: redacted(z.string().trim().min(1)).optional(),
  iterateAuth: z
    .object({
      issuer: publicValue(z.url().default("https://auth.iterate.com/api/auth")),
      clientId: publicValue(z.string().trim().min(1)),
      clientSecret: redacted(z.string().trim().min(1)),
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
    })
    .default({}),
  slackBotToken: redacted(z.string().trim().min(1)).optional(),
  typeIdPrefix: redacted(
    z
      .string()
      .trim()
      .regex(/^[a-z]+$/, "Type ID prefix must contain lowercase letters only")
      .default("os"),
  ),
  posthog: z
    .object({
      apiKey: publicValue(z.string().trim().min(1)),
    })
    .optional(),
});

export type AppConfig = z.output<typeof AppConfig>;

const manifest = {
  packageName: packageJson.name,
  version: packageJson.version,
  slug: "os",
  description: "Iterate OS — dashboard and project subdomain routing.",
} as const satisfies AppManifest;

export default manifest;
