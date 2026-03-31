import { BaseAppConfig } from "@iterate-com/shared/apps/config";
import type { AppManifest } from "@iterate-com/shared/apps/types";
import { z } from "zod";
import packageJson from "../package.json" with { type: "json" };

export const AppConfig = BaseAppConfig;

export type AppConfig = z.output<typeof AppConfig>;

const manifest = {
  packageName: packageJson.name,
  version: packageJson.version,
  slug: "fake-os",
  description: "Deployment management UI backed by TanStack Start, oRPC, and SQLite.",
} as const satisfies AppManifest;

export default manifest;
