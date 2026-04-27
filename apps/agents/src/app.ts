import { BaseAppConfig, publicValue } from "@iterate-com/shared/apps/config";
import type { AppManifest } from "@iterate-com/shared/apps/types";
import { StreamPath } from "@iterate-com/events-contract";
import { z } from "zod";
import packageJson from "../package.json" with { type: "json" };

export const AppConfig = BaseAppConfig.extend({
  apiBaseUrl: publicValue(z.string().trim().default("")),
  eventsBaseUrl: z.string().trim().url().default("https://events.iterate.com"),
  eventsProjectSlug: z.string().trim().min(1).default("public"),
  /**
   * Parent stream path to attach the `child-stream-auto-subscriber` processor
   * to via the `installProcessor` oRPC procedure. New streams that appear below
   * this path get an `iterate-agent` WebSocket subscription auto-installed.
   */
  streamPathPrefix: StreamPath.default("/agents"),
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
