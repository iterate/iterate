import { BaseAppConfig, publicValue } from "@iterate-com/shared/apps/config";
import type { AppManifest } from "@iterate-com/shared/apps/types";
import { z } from "zod";
import packageJson from "../package.json" with { type: "json" };

export const AppConfig = BaseAppConfig.extend({
  apiBaseUrl: publicValue(z.string().trim().default("")),
  posthog: z
    .object({
      apiKey: publicValue(z.string().trim().default("")),
    })
    .optional(),
});

export type AppConfig = z.output<typeof AppConfig>;

const manifest = {
  packageName: packageJson.name,
  version: packageJson.version,
  slug: "agents",
  description: "Minimal TanStack Start app with PostHog and one sample oRPC procedure.",
} as const satisfies AppManifest;

export default manifest;
