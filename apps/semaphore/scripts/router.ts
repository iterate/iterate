import { os } from "@orpc/server";
import { createCloudflarePreviewScriptRouter } from "@iterate-com/shared/apps/cloudflare-preview";
import { createSemaphoreClient } from "@iterate-com/semaphore-contract";
import {
  SeedCloudflarePreviewEnvironmentPoolInput,
  seedCloudflarePreviewEnvironmentPool,
} from "./seed-cloudflare-preview-environment-pool.ts";
import { SeedTunnelPoolInput, seedTunnelPool } from "./seed-cloudflare-tunnel-pool.ts";

export const router = os.router({
  "seed-cloudflare-preview-environment-pool": os
    .input(SeedCloudflarePreviewEnvironmentPoolInput)
    .meta({
      description: "Seed Cloudflare preview environment resources into semaphore",
    })
    .handler(async ({ input }) => {
      return await seedCloudflarePreviewEnvironmentPool(input);
    }),
  "seed-cloudflare-tunnel-pool": os
    .input(SeedTunnelPoolInput)
    .meta({
      description: "Seed Cloudflare tunnel resources into semaphore",
      default: true,
    })
    .handler(async ({ input }) => {
      return await seedTunnelPool(input);
    }),
  ...createCloudflarePreviewScriptRouter({
    appDisplayName: "Semaphore",
    appSlug: "semaphore",
    createPreviewSemaphoreResourceClient: ({ semaphoreApiToken, semaphoreBaseUrl }) => {
      const semaphore = createSemaphoreClient({
        apiKey: semaphoreApiToken,
        baseURL: semaphoreBaseUrl,
      });
      return {
        acquire: ({ leaseMs, type, waitMs }) =>
          semaphore.resources.acquire({ leaseMs, type, waitMs }),
        release: ({ leaseId, slug, type }) => semaphore.resources.release({ leaseId, slug, type }),
      };
    },
    dopplerProject: "semaphore",
    env: process.env,
    previewResourceType: "semaphore-preview-environment",
    previewTestBaseUrlEnvVar: "SEMAPHORE_BASE_URL",
    previewTestCommandArgs: ["pnpm", "test:e2e"],
    workingDirectory: process.cwd(),
  }),
});
