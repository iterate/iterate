import { BaseAppConfig, publicValue, redacted } from "@iterate-com/shared/apps/config";
import type { AppManifest } from "@iterate-com/shared/apps/types";
import { z } from "zod";
import packageJson from "../package.json" with { type: "json" };

export const AppConfig = BaseAppConfig.extend({
  codemodeApis: z.object({
    eventsBaseUrl: z.string().trim().url(),
    exampleBaseUrl: z.string().trim().url(),
    semaphoreBaseUrl: z.string().trim().url(),
    semaphoreApiToken: redacted(z.string().trim().min(1)),
    ingressProxyBaseUrl: z.string().trim().url(),
    ingressProxyApiToken: redacted(z.string().trim().min(1)),
  }),
  posthog: z.object({
    apiKey: publicValue(z.string().trim().min(1)),
  }),
  sharedApiSecret: redacted(z.string().trim().min(1)),
});

export type AppConfig = typeof AppConfig._output;

const manifest = {
  packageName: packageJson.name,
  version: packageJson.version,
  slug: "codemode",
  description: "Paste a snippet, run it in an isolated Cloudflare worker, and keep the result.",
} as const satisfies AppManifest;

export default manifest;
