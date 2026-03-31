import { BaseAppConfig, publicValue } from "@iterate-com/shared/apps/config";
import type { AppManifest } from "@iterate-com/shared/apps/types";
import { z } from "zod";
import packageJson from "../package.json" with { type: "json" };

export const AppConfig = BaseAppConfig.extend({
  posthog: z.object({
    apiKey: publicValue(z.string().trim().min(1)),
  }),
});

export type AppConfig = typeof AppConfig._output;

const manifest = {
  packageName: packageJson.name,
  version: packageJson.version,
  slug: "codemode",
  description: "Paste a snippet, run it in an isolated Cloudflare worker, and keep the result.",
} as const satisfies AppManifest;

export default manifest;
