export type CloudflareAppSlug = "example" | "events" | "semaphore" | "ingress-proxy";

export type CloudflareApp = {
  slug: CloudflareAppSlug;
  displayName: string;
  appPath: `apps/${string}`;
  dopplerProject: string;
  paths: string[];
};

const commonPaths = [
  ".github/ts-workflows/utils/cloudflare-app-workflow.ts",
  ".github/ts-workflows/utils/cloudflare-apps.ts",
  ".github/ts-workflows/workflows/cleanup-cloudflare-previews.ts",
  "apps/semaphore-contract/**",
  "packages/shared/src/apps/cloudflare-preview-comment.ts",
  "packages/shared/src/apps/cloudflare-preview.ts",
];

export const cloudflareApps = {
  example: {
    slug: "example",
    displayName: "Example",
    appPath: "apps/example",
    dopplerProject: "example",
    paths: ["apps/example/**", "apps/example-contract/**", ...commonPaths],
  },
  events: {
    slug: "events",
    displayName: "Events",
    appPath: "apps/events",
    dopplerProject: "events",
    paths: ["apps/events/**", "apps/events-contract/**", ...commonPaths],
  },
  semaphore: {
    slug: "semaphore",
    displayName: "Semaphore",
    appPath: "apps/semaphore",
    dopplerProject: "semaphore",
    paths: ["apps/semaphore/**", "apps/semaphore-contract/**", ...commonPaths],
  },
  "ingress-proxy": {
    slug: "ingress-proxy",
    displayName: "Ingress Proxy",
    appPath: "apps/ingress-proxy",
    dopplerProject: "ingress-proxy",
    paths: ["apps/ingress-proxy/**", "apps/ingress-proxy-contract/**", ...commonPaths],
  },
} satisfies Record<CloudflareAppSlug, CloudflareApp>;
