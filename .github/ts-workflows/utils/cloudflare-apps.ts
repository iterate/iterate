export type CloudflareAppSlug = "example" | "events" | "semaphore" | "ingress-proxy";

export type CloudflareApp = {
  slug: CloudflareAppSlug;
  displayName: string;
  appPath: `apps/${string}`;
  dopplerProject: string;
  paths: string[];
  previewTest: {
    command: string;
    baseUrlEnvVar: string;
  };
};

const commonPaths = [
  "packages/shared/src/apps/common-router-contract.ts",
  ".github/ts-workflows/utils/cloudflare-app-workflow.ts",
  ".github/ts-workflows/utils/cloudflare-apps.ts",
  ".github/ts-workflows/utils/cloudflare-preview-comment.ts",
  ".github/ts-workflows/workflows/cleanup-cloudflare-previews.ts",
  "apps/semaphore/scripts/preview-workflow.ts",
];

export const cloudflareApps = {
  example: {
    slug: "example",
    displayName: "Example",
    appPath: "apps/example",
    dopplerProject: "example",
    paths: ["apps/example/**", "apps/example-contract/**", ...commonPaths],
    previewTest: {
      command: "pnpm test:e2e",
      baseUrlEnvVar: "EXAMPLE_BASE_URL",
    },
  },
  events: {
    slug: "events",
    displayName: "Events",
    appPath: "apps/events",
    dopplerProject: "events",
    paths: ["apps/events/**", "apps/events-contract/**", ...commonPaths],
    previewTest: {
      command: "pnpm test:e2e",
      baseUrlEnvVar: "EVENTS_BASE_URL",
    },
  },
  semaphore: {
    slug: "semaphore",
    displayName: "Semaphore",
    appPath: "apps/semaphore",
    dopplerProject: "semaphore",
    paths: ["apps/semaphore/**", "apps/semaphore-contract/**", ...commonPaths],
    previewTest: {
      command: "pnpm test:e2e",
      baseUrlEnvVar: "SEMAPHORE_BASE_URL",
    },
  },
  "ingress-proxy": {
    slug: "ingress-proxy",
    displayName: "Ingress Proxy",
    appPath: "apps/ingress-proxy",
    dopplerProject: "ingress-proxy",
    paths: ["apps/ingress-proxy/**", "apps/ingress-proxy-contract/**", ...commonPaths],
    previewTest: {
      command: "pnpm test:e2e",
      baseUrlEnvVar: "INGRESS_PROXY_BASE_URL",
    },
  },
} satisfies Record<CloudflareAppSlug, CloudflareApp>;
