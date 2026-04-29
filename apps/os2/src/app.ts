import { BaseAppConfig, publicValue, redacted } from "@iterate-com/shared/apps/config";
import type { AppManifest } from "@iterate-com/shared/apps/types";
import { z } from "zod";
import packageJson from "../package.json" with { type: "json" };

export const AppConfig = BaseAppConfig.extend({
  eventsBaseUrl: z.string().trim().url(),
  clerk: z.object({
    publishableKey: publicValue(z.string().trim().min(1)),
    secretKey: redacted(z.string().trim().min(1)),
    jwtKey: redacted(z.string().trim().min(1)),
    oauthClientId: publicValue(z.string().trim().min(1)).optional(),
    oauthClientSecret: redacted(z.string().trim().min(1)).optional(),
    signInUrl: publicValue(z.string().trim().min(1).default("/sign-in")),
    signUpUrl: publicValue(z.string().trim().min(1).default("/sign-up")),
    afterSignInUrl: publicValue(z.string().trim().min(1).default("/")),
    afterSignUpUrl: publicValue(z.string().trim().min(1).default("/")),
    mcpOauthScopes: z
      .array(z.enum(["profile", "email", "public_metadata", "private_metadata"]))
      .default(["email", "profile"]),
  }),
  mcpProofSecret: redacted(z.string().trim().min(1)),
  projectHostnameBases: z.array(z.string().trim().min(1)).default([]),
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
