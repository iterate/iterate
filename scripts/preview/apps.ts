import { z } from "zod";

export const CloudflarePreviewAppSlug = z.enum([
  "agents",
  "codemode",
  "example",
  "events",
  "os2",
  "semaphore",
  "ingress-proxy",
]);

export type CloudflarePreviewAppSlug = z.infer<typeof CloudflarePreviewAppSlug>;

export type CloudflarePreviewApp = {
  slug: CloudflarePreviewAppSlug;
  displayName: string;
  appPath: `apps/${string}`;
  dopplerProject: string;
  paths: string[];
  /**
   * Temporary preview orchestration dependency graph. This belongs in app
   * manifests/contracts long-term; the preview script should not own product
   * topology once manifests can express cross-app runtime dependencies.
   */
  previewDependencies?: CloudflarePreviewAppSlug[];
  previewTestBaseUrlEnvVar: string;
  previewTestCommandArgs: readonly [string, ...string[]];
};

export const cloudflarePreviewApps: Record<CloudflarePreviewAppSlug, CloudflarePreviewApp> = {
  agents: {
    slug: "agents",
    displayName: "Agents",
    appPath: "apps/agents",
    dopplerProject: "agents",
    paths: ["apps/agents/**", "apps/agents-contract/**"],
    previewTestBaseUrlEnvVar: "AGENTS_BASE_URL",
    previewTestCommandArgs: ["pnpm", "test:e2e:preview"],
  },
  codemode: {
    slug: "codemode",
    displayName: "Codemode",
    appPath: "apps/codemode",
    dopplerProject: "codemode",
    paths: ["apps/codemode/**", "apps/codemode-contract/**"],
    previewTestBaseUrlEnvVar: "CODEMODE_BASE_URL",
    previewTestCommandArgs: ["pnpm", "test:e2e:preview"],
  },
  example: {
    slug: "example",
    displayName: "Example",
    appPath: "apps/example",
    dopplerProject: "example",
    paths: ["apps/example/**"],
    previewTestBaseUrlEnvVar: "EXAMPLE_BASE_URL",
    previewTestCommandArgs: ["pnpm", "test:e2e"],
  },
  events: {
    slug: "events",
    displayName: "Events",
    appPath: "apps/events",
    dopplerProject: "events",
    paths: ["apps/events/**"],
    previewTestBaseUrlEnvVar: "EVENTS_BASE_URL",
    previewTestCommandArgs: ["pnpm", "test:e2e:preview"],
  },
  os2: {
    slug: "os2",
    displayName: "OS",
    appPath: "apps/os2",
    dopplerProject: "os2",
    paths: ["apps/os2/**", "apps/os2-contract/**"],
    previewDependencies: ["events"],
    previewTestBaseUrlEnvVar: "OS2_BASE_URL",
    previewTestCommandArgs: ["pnpm", "test:e2e:preview"],
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
  "ingress-proxy": {
    slug: "ingress-proxy",
    displayName: "Ingress Proxy",
    appPath: "apps/ingress-proxy",
    dopplerProject: "ingress-proxy",
    paths: ["apps/ingress-proxy/**"],
    previewTestBaseUrlEnvVar: "INGRESS_PROXY_BASE_URL",
    previewTestCommandArgs: ["pnpm", "test:e2e:preview"],
  },
};
