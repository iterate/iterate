/**
 * Multi-provider benchmark config - compares Daytona, E2B, and Fly.io
 *
 * Prerequisites:
 *   1. Build Daytona image: doppler run -- tsx cli.ts build-images --config examples/build.config.ts
 *   2. For E2B: Build template with e2b CLI or use "base" template
 *   3. For Fly: Use public image or push custom image to registry.fly.io
 *
 * Usage:
 *   doppler run --config dev -- tsx cli.ts run --config examples/all-providers.config.ts
 */

import type { BenchmarkConfig, ImageRef } from "../config.ts";
import { images } from "./benchmark-images.ts";

// E2B: Use base template for testing (replace with custom template for real benchmarks)
const e2bImage: ImageRef = {
  provider: "e2b",
  identifier: "base",
  dockerfile: "../sandbox-server/Dockerfile",
  builtAt: new Date().toISOString(),
};

// Fly.io: Use nginx for testing (replace with benchmark server image)
const flyImage: ImageRef = {
  provider: "fly",
  identifier: "registry-1.docker.io/library/nginx:alpine",
  dockerfile: "../sandbox-server/Dockerfile",
  builtAt: new Date().toISOString(),
};

export const config: BenchmarkConfig = {
  configs: [
    // Daytona config
    {
      name: "daytona-1cpu-1gb",
      provider: "daytona",
      image: images["daytona-benchmark-server"],
      cpu: 1,
      memoryMb: 1024,
      region: "us-east",
    },

    // E2B config (note: restart measurement disabled due to different semantics)
    {
      name: "e2b-base",
      provider: "e2b",
      image: e2bImage,
    },

    // Fly.io config
    {
      name: "fly-shared-1cpu",
      provider: "fly",
      image: flyImage,
      cpuKind: "shared",
      cpus: 1,
      memoryMb: 256,
      region: "ord",
    },
  ],

  machinesPerConfig: 1,
  requestsPerMachine: 10,
  batchSize: 1,
  restartCyclesPerMachine: 1, // E2B will skip this due to pause/resume semantics

  output: "all-providers-benchmark.db",
  keepAlive: false,

  measurements: {
    coldBoot: true,
    restart: true, // Only applies to Daytona and Fly
    requestLatency: true,
  },
};
