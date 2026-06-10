import { z } from "zod";

export const CloudflarePreviewAppSlug = z.enum(["os", "semaphore"]);

export type CloudflarePreviewAppSlug = z.infer<typeof CloudflarePreviewAppSlug>;

export type CloudflarePreviewApp = {
  slug: CloudflarePreviewAppSlug;
  displayName: string;
  appPath: `apps/${string}`;
  dopplerProject: string;
  paths: string[];
  deploymentDependencies?: CloudflarePreviewAppSlug[];
  previewDependencies?: CloudflarePreviewAppSlug[];
  previewTestBaseUrlEnvVar: string;
  previewTestCommandArgs: readonly [string, ...string[]];
};

export const cloudflareAppSharedPaths = [
  "packages/shared/src/alchemy/**",
  "packages/shared/src/config.ts",
  "packages/shared/src/dev/**",
  "packages/shared/src/evlog/**",
  "packages/ui/**",
  "packages/mock-http-proxy/**",
] as const;

export const cloudflarePreviewSharedPaths = [
  ".github/workflows/cloudflare-previews.yml",
  ".github/ts-workflows/workflows/cloudflare-previews.ts",
  ...cloudflareAppSharedPaths,
  "scripts/preview/**",
] as const;

/** Trigger preview workflow runs; apps here are not necessarily redeployed. */
export const cloudflarePreviewAdditionalTriggerPaths = [
  "apps/iterate-com/**",
  "apps/auth-example/**",
] as const;

export const cloudflarePreviewApps: Record<CloudflarePreviewAppSlug, CloudflarePreviewApp> = {
  os: {
    slug: "os",
    displayName: "OS",
    appPath: "apps/os",
    dopplerProject: "os",
    paths: ["apps/os/**", "apps/os-contract/**", "apps/auth/**", "apps/auth-contract/**"],
    previewDependencies: [],
    previewTestBaseUrlEnvVar: "OS_BASE_URL",
    // The itx e2e (node project only — the browser project needs a Playwright
    // chromium install the preview e2e job doesn't have) reads
    // APP_CONFIG_BASE_URL + APP_CONFIG_ADMIN_API_SECRET from the leased
    // preview Doppler config, same as the preview smoke.
    previewTestCommandArgs: [
      "bash",
      "-c",
      'pnpm e2e -t "OS preview smoke" && pnpm e2e:itx --project node',
    ],
  },
  semaphore: {
    slug: "semaphore",
    displayName: "Semaphore",
    appPath: "apps/semaphore",
    dopplerProject: "semaphore",
    paths: ["apps/semaphore/**"],
    previewTestBaseUrlEnvVar: "SEMAPHORE_BASE_URL",
    previewTestCommandArgs: ["pnpm", "test:e2e:preview"],
  },
};
