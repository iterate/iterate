import { BaseAppConfig, publicValue, redacted } from "@iterate-com/shared/apps/config";
import type { AppManifest } from "@iterate-com/shared/apps/types";
import { z } from "zod";
import packageJson from "../package.json" with { type: "json" };

const ClerkMcpOauthScope = z.enum(["openid", "profile", "email"]);

export const AppConfig = BaseAppConfig.extend({
  eventsBaseUrl: z.string().trim().url(),
  clerk: z.object({
    publishableKey: publicValue(z.string().trim().min(1)),
    secretKey: redacted(z.string().trim().min(1)),
    jwtKey: redacted(z.string().trim().min(1)),
    // Deprecated static OAuth app config. MCP now uses Clerk dynamic client registration,
    // but older CI/Doppler configs may still provide these keys.
    oauthClientId: publicValue(z.string().trim().min(1)).optional(),
    oauthClientSecret: redacted(z.string().trim().min(1)).optional(),
    signInUrl: publicValue(z.string().trim().min(1).default("/sign-in")),
    signUpUrl: publicValue(z.string().trim().min(1).default("/sign-up")),
    afterSignInUrl: publicValue(z.string().trim().min(1).default("/")),
    afterSignUpUrl: publicValue(z.string().trim().min(1).default("/")),
    mcpOauthScopes: z
      .array(ClerkMcpOauthScope)
      .default(["email", "profile"])
      .transform((scopes) =>
        scopes.filter((scope): scope is "email" | "profile" => scope !== "openid"),
      ),
  }),
  mcpProofSecret: redacted(z.string().trim().min(1)),
  projectHostnameBases: publicValue(z.array(z.string().trim().min(1)).default([])),
  projectStreamsEventsBaseUrl: publicValue(
    z.string().trim().url().default("https://events.iterate.com"),
  ),
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
  slug: "os2",
  description: "Iterate OS v2 — dashboard and project subdomain routing.",
} as const satisfies AppManifest;

export default manifest;
