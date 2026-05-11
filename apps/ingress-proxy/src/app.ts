import { BaseAppConfig, publicValue, redacted } from "@iterate-com/shared/apps/config";
import type { AppManifest } from "@iterate-com/shared/apps/types";
import { z } from "zod";
import packageJson from "../package.json" with { type: "json" };

export const AppConfig = BaseAppConfig.extend({
  posthog: z.object({
    apiKey: publicValue(z.string().trim().min(1)),
  }),
  sharedApiSecret: redacted(z.string().trim().min(1)),
  typeIdPrefix: redacted(z.string().trim().min(1)),
});
export type AppConfig = z.output<typeof AppConfig>;

const manifest = {
  packageName: packageJson.name,
  version: packageJson.version,
  slug: "ingress-proxy",
  description: "TanStack Start frontend plus Cloudflare ingress proxy and D1 route registry.",
} as const satisfies AppManifest;

export default manifest;
