import { z } from "zod";
import {
  newStyleCloudflareApps,
  newStyleCloudflareAppSharedPaths,
} from "../../packages/shared/src/apps/new-style-cloudflare-apps.ts";

export const CloudflarePreviewAppSlug = z.enum(["os", "semaphore"]);

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

/** Trigger preview workflow runs; apps here are not necessarily redeployed. */
export const cloudflarePreviewAdditionalTriggerPaths = [
  "apps/iterate-com/**",
  "apps/auth-example/**",
] as const;

export const cloudflarePreviewApps: Record<CloudflarePreviewAppSlug, CloudflarePreviewApp> = {
  os: {
    ...newStyleCloudflareApps.os,
    previewDependencies: newStyleCloudflareApps.os.deploymentDependencies?.map((appSlug) =>
      CloudflarePreviewAppSlug.parse(appSlug),
    ),
    previewTestBaseUrlEnvVar: "OS_BASE_URL",
    previewTestCommandArgs: ["pnpm", "e2e", "-t", "OS preview smoke"],
  },
  semaphore: {
    ...newStyleCloudflareApps.semaphore,
    previewTestBaseUrlEnvVar: "SEMAPHORE_BASE_URL",
    previewTestCommandArgs: ["pnpm", "test:e2e:preview"],
  },
};
