/**
 * Cold boot comparison across all three providers
 *
 * This config compares startup times without needing the benchmark server.
 * Each provider uses simple images that start quickly.
 *
 * Usage:
 *   doppler run --config dev -- tsx cli.ts run --config examples/cold-boot-comparison.config.ts
 */

import type { BenchmarkConfig, ImageRef } from "../config.ts";
import { images } from "./benchmark-images.ts";

// E2B: Use base template
const e2bImage: ImageRef = {
  provider: "e2b",
  identifier: "base",
  dockerfile: "N/A",
  builtAt: new Date().toISOString(),
};

// Fly.io: Use nginx (fast, minimal)
const flyImage: ImageRef = {
  provider: "fly",
  identifier: "registry-1.docker.io/library/nginx:alpine",
  dockerfile: "N/A",
  builtAt: new Date().toISOString(),
};

export const config: BenchmarkConfig = {
  configs: [
    // Daytona - with benchmark server
    {
      name: "daytona-1cpu-1gb",
      provider: "daytona",
      image: images["daytona-benchmark-server"],
      cpu: 1,
      memoryMb: 1024,
      region: "us-east",
    },

    // E2B - base template (no benchmark server)
    {
      name: "e2b-base-template",
      provider: "e2b",
      image: e2bImage,
    },

    // Fly.io - nginx (no benchmark server)
    {
      name: "fly-nginx-1cpu",
      provider: "fly",
      image: flyImage,
      cpuKind: "shared",
      cpus: 1,
      memoryMb: 256,
      region: "ord",
    },
  ],

  machinesPerConfig: 3, // Run 3 samples per provider
  requestsPerMachine: 0, // Skip latency (no benchmark server for E2B/Fly)
  batchSize: 1,
  restartCyclesPerMachine: 0, // Skip restart for now

  output: "cold-boot-comparison.db",
  keepAlive: false,

  measurements: {
    coldBoot: true,
    restart: false,
    requestLatency: false,
  },
};
