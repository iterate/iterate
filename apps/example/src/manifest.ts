import type { AppManifest } from "@iterate-com/shared/apps/define-app";
import packageJson from "../package.json" with { type: "json" };

const manifest = {
  packageName: packageJson.name,
  version: packageJson.version,
  slug: "example",
  description: "Minimal full-stack example app with Hono, oRPC, and Hono websocket helpers.",
} as const satisfies AppManifest;

export default manifest;
