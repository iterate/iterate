import { os } from "@orpc/server";
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
});
