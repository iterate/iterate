import { BaseAppConfig, publicValue } from "@iterate-com/shared/apps/config";
import type { AppManifest } from "@iterate-com/shared/apps/types";
import { z } from "zod";
import packageJson from "../package.json" with { type: "json" };

export const AppConfig = BaseAppConfig.extend({
  posthog: z.object({
    apiKey: publicValue(z.string().trim().min(1)),
  }),
});

export type AppConfig = z.output<typeof AppConfig>;

const manifest = {
  packageName: packageJson.name,
  version: packageJson.version,
  slug: "daemon-v2",
  description: "Node-only daemon v2 app with the registry control-plane feature set.",
} as const satisfies AppManifest;

export default manifest;
