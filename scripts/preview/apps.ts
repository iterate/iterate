import { z } from "zod";
import {
  newStyleCloudflareApps,
  newStyleCloudflareAppSharedPaths,
} from "../../packages/shared/src/apps/new-style-cloudflare-apps.ts";

export const CloudflarePreviewAppSlug = z.enum(["agents", "example", "events", "os2", "semaphore"]);

export type CloudflarePreviewAppSlug = z.infer<typeof CloudflarePreviewAppSlug>;

export type CloudflarePreviewApp = {
  slug: CloudflarePreviewAppSlug;
  displayName: string;
  appPath: `apps/${string}`;
  dopplerProject: string;
  paths: string[];
  previewDependencies?: CloudflarePreviewAppSlug[];
  previewTestBaseUrlEnvVar: string;
  previewTestCommandArgs: readonly [string, ...string[]];
};

export const cloudflarePreviewSharedPaths = [
  ".github/workflows/cloudflare-previews.yml",
  ".github/ts-workflows/workflows/cloudflare-previews.ts",
  ...newStyleCloudflareAppSharedPaths,
  "scripts/preview/**",
] as const;

export const cloudflarePreviewApps: Record<CloudflarePreviewAppSlug, CloudflarePreviewApp> = {
  agents: {
    ...newStyleCloudflareApps.agents,
    previewTestBaseUrlEnvVar: "AGENTS_BASE_URL",
    previewTestCommandArgs: ["pnpm", "test:e2e:preview"],
  },
  example: {
    ...newStyleCloudflareApps.example,
    previewTestBaseUrlEnvVar: "EXAMPLE_BASE_URL",
    previewTestCommandArgs: ["pnpm", "test:e2e:preview"],
  },
  events: {
    slug: "events",
    displayName: "Events",
    appPath: "apps/events",
    dopplerProject: "events",
    paths: ["apps/events/**", "apps/events-contract/**"],
    previewDependencies: ["os2"],
    previewTestBaseUrlEnvVar: "EVENTS_BASE_URL",
    previewTestCommandArgs: ["pnpm", "test:e2e:preview"],
  },
  os2: {
    ...newStyleCloudflareApps.os2,
    previewDependencies: newStyleCloudflareApps.os2.deploymentDependencies?.map((appSlug) =>
      CloudflarePreviewAppSlug.parse(appSlug),
    ),
    previewTestBaseUrlEnvVar: "OS2_BASE_URL",
    previewTestCommandArgs: ["pnpm", "test:e2e:preview"],
  },
  semaphore: {
    ...newStyleCloudflareApps.semaphore,
    previewTestBaseUrlEnvVar: "SEMAPHORE_BASE_URL",
    previewTestCommandArgs: ["pnpm", "test:e2e:preview"],
  },
};
