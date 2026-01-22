/**
 * All providers benchmark - Daytona + Fly.io
 *
 * Note: E2B requires a separate ACCESS_TOKEN from dashboard (not API_KEY)
 * Get it from: https://e2b.dev/dashboard?tab=personal
 */
import type { BenchmarkConfig, ImageRef } from "../config.ts";
import { images } from "./benchmark-images.ts";

const daytonaImage = images["daytona-benchmark-server"];

// Fly.io benchmark server image - deployed via `fly deploy`
const flyImage: ImageRef = {
  provider: "fly",
  identifier: "registry.fly.io/benchmark-server-image:deployment-01KFHDT9WN62WAJMQFJF6JVSK2",
  dockerfile: "sandbox-server/Dockerfile",
  builtAt: "2026-01-21T23:23:17Z",
};

export const config: BenchmarkConfig = {
  configs: [
    // Daytona configurations
    {
      name: "daytona-1cpu-1gb",
      provider: "daytona",
      image: daytonaImage,
      cpu: 1,
      memoryMb: 1024,
      region: "us-east",
    },
    {
      name: "daytona-2cpu-2gb",
      provider: "daytona",
      image: daytonaImage,
      cpu: 2,
      memoryMb: 2048,
      region: "us-east",
    },
    {
      name: "daytona-4cpu-4gb",
      provider: "daytona",
      image: daytonaImage,
      cpu: 4,
      memoryMb: 4096,
      region: "us-east",
    },

    // Fly.io configurations
    {
      name: "fly-shared-1cpu-256mb",
      provider: "fly",
      image: flyImage,
      cpuKind: "shared",
      cpus: 1,
      memoryMb: 256,
      region: "ord",
    },
    {
      name: "fly-shared-1cpu-512mb",
      provider: "fly",
      image: flyImage,
      cpuKind: "shared",
      cpus: 1,
      memoryMb: 512,
      region: "ord",
    },
    {
      name: "fly-shared-2cpu-1gb",
      provider: "fly",
      image: flyImage,
      cpuKind: "shared",
      cpus: 2,
      memoryMb: 1024,
      region: "ord",
    },
  ],
  machinesPerConfig: 3,
  requestsPerMachine: 20,
  batchSize: 5,
  restartCyclesPerMachine: 2,
  output: "all-providers.db",
  keepAlive: false,
  measurements: {
    coldBoot: true,
    restart: true,
    requestLatency: true,
  },
};
