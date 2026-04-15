import { BaseAppConfig, publicValue } from "@iterate-com/shared/apps/config";
import type { AppManifest } from "@iterate-com/shared/apps/types";
import { z } from "zod";

export const AppConfig = BaseAppConfig.extend({
  message: publicValue(z.string().trim().default("hello world")),
});

export type AppConfig = z.output<typeof AppConfig>;

const manifest = {
  packageName: "@iterate-com/agents",
  version: "0.0.1",
  slug: "agents",
  description: "Minimal Cloudflare worker for the agent package.",
} as const satisfies AppManifest;

export default manifest;
