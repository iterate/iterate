import { os } from "@orpc/server";
import {
  SeedEnvironmentConfigLeasesInput,
  seedEnvironmentConfigLeases,
} from "./seed-environment-config-leases.ts";
import { SeedTunnelPoolInput, seedTunnelPool } from "./seed-cloudflare-tunnel-pool.ts";

export const router = os.router({
  "seed-environment-config-leases": os
    .input(SeedEnvironmentConfigLeasesInput)
    .meta({
      description: "Seed environment config lease resources into Semaphore for PR previews",
    })
    .handler(async ({ input }) => {
      return await seedEnvironmentConfigLeases(input);
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
