/**
 * Example build config for benchmark images
 *
 * Usage:
 *   doppler run -- tsx cli.ts build-images --config examples/build.config.ts
 */

import type { BuildConfig } from "../config.ts";

export const buildConfig: BuildConfig = {
  dockerfiles: [
    {
      name: "benchmark-server",
      path: "../sandbox-server/Dockerfile", // Relative to this config file
    },
  ],
  providers: ["daytona"], // Only Daytona for now, add 'e2b', 'fly' later
  outputFile: "scripts/sandbox-benchmark/examples/benchmark-images.ts",
};
