import { os } from "@orpc/server";
import { SeedTunnelPoolInput, seedTunnelPool } from "./seed-cloudflare-tunnel-pool.ts";

export const router = {
  "seed-cloudflare-tunnel-pool": os
    .input(SeedTunnelPoolInput)
    .meta({
      description: "Seed Cloudflare tunnel resources into semaphore",
      default: true,
    })
    .handler(async ({ input }) => {
      return await seedTunnelPool(input);
    }),
};
