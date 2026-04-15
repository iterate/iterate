import { z } from "zod";

export const CloudflarePreviewAppSlug = z.enum([
  "agents",
  "codemode",
  "example",
  "events",
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
  previewResourceType: string;
  previewTestBaseUrlEnvVar: string;
  previewTestCommandArgs: readonly [string, ...string[]];
};

export const cloudflarePreviewApps = {
  agents: {
    slug: "agents",
    displayName: "Agents",
    appPath: "apps/agents",
    dopplerProject: "agents",
    paths: ["apps/agents/**", "apps/agents-contract/**"],
    previewResourceType: "agents-preview-environment",
    previewTestBaseUrlEnvVar: "AGENTS_BASE_URL",
    previewTestCommandArgs: ["pnpm", "test:e2e:preview"],
  },
  codemode: {
    slug: "codemode",
    displayName: "Codemode",
    appPath: "apps/codemode",
    dopplerProject: "codemode",
    paths: ["apps/codemode/**", "apps/codemode-contract/**"],
    previewResourceType: "codemode-preview-environment",
    previewTestBaseUrlEnvVar: "CODEMODE_BASE_URL",
    previewTestCommandArgs: ["pnpm", "test:e2e:preview"],
  },
  example: {
    slug: "example",
    displayName: "Example",
    appPath: "apps/example",
    dopplerProject: "example",
    paths: ["apps/example/**"],
    previewResourceType: "example-preview-environment",
    previewTestBaseUrlEnvVar: "EXAMPLE_BASE_URL",
    previewTestCommandArgs: ["pnpm", "test:e2e"],
  },
  events: {
    slug: "events",
    displayName: "Events",
    appPath: "apps/events",
    dopplerProject: "events",
    paths: ["apps/events/**"],
    previewResourceType: "events-preview-environment",
    previewTestBaseUrlEnvVar: "EVENTS_BASE_URL",
    previewTestCommandArgs: ["pnpm", "test:e2e:preview"],
  },
  semaphore: {
    slug: "semaphore",
    displayName: "Semaphore",
    appPath: "apps/semaphore",
    dopplerProject: "semaphore",
    paths: ["apps/semaphore/**"],
    previewResourceType: "semaphore-preview-environment",
    previewTestBaseUrlEnvVar: "SEMAPHORE_BASE_URL",
    previewTestCommandArgs: ["pnpm", "test:e2e:preview"],
  },
  "ingress-proxy": {
    slug: "ingress-proxy",
    displayName: "Ingress Proxy",
    appPath: "apps/ingress-proxy",
    dopplerProject: "ingress-proxy",
    paths: ["apps/ingress-proxy/**"],
    previewResourceType: "ingress-proxy-preview-environment",
    previewTestBaseUrlEnvVar: "INGRESS_PROXY_BASE_URL",
    previewTestCommandArgs: ["pnpm", "test:e2e:preview"],
  },
} satisfies Record<CloudflarePreviewAppSlug, CloudflarePreviewApp>;
