/**
 * Example Fly.io benchmark config
 *
 * Fly.io supports using public Docker images directly.
 * For custom images, push to registry.fly.io or another registry.
 *
 * Required env vars:
 *   - FLY_API_KEY or FLY_API_TOKEN
 *   - FLY_ORG_SLUG (defaults to 'iterate')
 *
 * Usage:
 *   doppler run --config dev -- tsx cli.ts run --config examples/fly.config.ts
 */

import type { BenchmarkConfig, ImageRef } from "../config.ts";

// Use a public Docker image for testing
// For real benchmarks, use a custom image with the benchmark server
const flyImage: ImageRef = {
  provider: "fly",
  // Using nginx for simple connectivity testing
  // Replace with your custom image: registry.fly.io/your-app:tag
  identifier: "registry-1.docker.io/library/nginx:alpine",
  dockerfile: "../sandbox-server/Dockerfile",
  builtAt: new Date().toISOString(),
};

export const config: BenchmarkConfig = {
  configs: [
    {
      name: "fly-shared-1cpu",
      provider: "fly",
      image: flyImage,
      cpuKind: "shared",
      cpus: 1,
      memoryMb: 256,
      region: "ord", // Chicago
    },
    // Uncomment for performance comparison:
    // {
    //   name: "fly-shared-2cpu",
    //   provider: "fly",
    //   image: flyImage,
    //   cpuKind: "shared",
    //   cpus: 2,
    //   memoryMb: 512,
    //   region: "ord",
    // },
  ],

  // Number of sandboxes per config
  machinesPerConfig: 1,

  // HTTP requests per sandbox
  requestsPerMachine: 10,

  // Concurrency
  batchSize: 1,

  // Restart cycles
  restartCyclesPerMachine: 1,

  // Output
  output: "fly-benchmark.db",

  // Keep alive for debugging
  keepAlive: false,

  // Measurements
  measurements: {
    coldBoot: true,
    restart: true,
    requestLatency: true,
  },
};
