import { os } from "@orpc/server";
import {
  SeedEnvironmentConfigLeasesInput,
  seedEnvironmentConfigLeases,
} from "./seed-environment-config-leases.ts";

export const router = os.router({
  "seed-environment-config-leases": os
    .input(SeedEnvironmentConfigLeasesInput)
    .meta({
      description: "Seed environment config lease resources into Semaphore for PR previews",
    })
    .handler(async ({ input }) => {
      return await seedEnvironmentConfigLeases(input);
    }),
});
