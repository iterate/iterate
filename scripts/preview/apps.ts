import { z } from "zod";

export const CloudflarePreviewAppSlug = z.enum(["example", "events", "semaphore", "ingress-proxy"]);

export type CloudflarePreviewAppSlug = z.infer<typeof CloudflarePreviewAppSlug>;

export type CloudflarePreviewApp = {
  slug: CloudflarePreviewAppSlug;
  displayName: string;
  appPath: `apps/${string}`;
  dopplerProject: string;
  paths: string[];
  previewResourceType: string;
  previewTestBaseUrlEnvVar: string;
  previewTestCommandArgs: readonly [string, ...string[]];
};

export const cloudflarePreviewApps = {
  example: {
    slug: "example",
    displayName: "Example",
    appPath: "apps/example",
    dopplerProject: "example",
    paths: ["apps/example/**", "apps/example-contract/**"],
    previewResourceType: "example-preview-environment",
    previewTestBaseUrlEnvVar: "EXAMPLE_BASE_URL",
    previewTestCommandArgs: ["pnpm", "test:e2e"],
  },
  events: {
    slug: "events",
    displayName: "Events",
    appPath: "apps/events",
    dopplerProject: "events",
    paths: ["apps/events/**", "apps/events-contract/**"],
    previewResourceType: "events-preview-environment",
    previewTestBaseUrlEnvVar: "EVENTS_BASE_URL",
    previewTestCommandArgs: ["pnpm", "test:e2e"],
  },
  semaphore: {
    slug: "semaphore",
    displayName: "Semaphore",
    appPath: "apps/semaphore",
    dopplerProject: "semaphore",
    paths: ["apps/semaphore/**", "apps/semaphore-contract/**"],
    previewResourceType: "semaphore-preview-environment",
    previewTestBaseUrlEnvVar: "SEMAPHORE_BASE_URL",
    previewTestCommandArgs: ["pnpm", "test:e2e"],
  },
  "ingress-proxy": {
    slug: "ingress-proxy",
    displayName: "Ingress Proxy",
    appPath: "apps/ingress-proxy",
    dopplerProject: "ingress-proxy",
    paths: ["apps/ingress-proxy/**", "apps/ingress-proxy-contract/**"],
    previewResourceType: "ingress-proxy-preview-environment",
    previewTestBaseUrlEnvVar: "INGRESS_PROXY_BASE_URL",
    previewTestCommandArgs: ["pnpm", "test:e2e"],
  },
} satisfies Record<CloudflarePreviewAppSlug, CloudflarePreviewApp>;
