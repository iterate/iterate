import type { AppManifest } from "@iterate-com/shared/jonasland";
import packageJson from "../package.json" with { type: "json" };

export const appManifest = {
  packageName: packageJson.name,
  version: packageJson.version,
  slug: "example",
  description: "Minimal full-stack example app with Hono, oRPC, and CrossWS.",
} as const satisfies AppManifest;
