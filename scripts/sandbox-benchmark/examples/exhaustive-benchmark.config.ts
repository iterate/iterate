/**
 * Exhaustive benchmark config - comprehensive comparison across all providers
 *
 * This config uses:
 * - Daytona: Pre-built benchmark server snapshot
 * - E2B: Built-in templates (base template - no custom build needed)
 * - Fly.io: Public Docker image (nginx) for basic latency testing
 *
 * Note: E2B and Fly configs use simpler images since custom images require
 * additional setup (E2B needs ACCESS_TOKEN for CLI, Fly needs registry push).
 *
 * Usage:
 *   doppler run --config dev -- tsx cli.ts run --config examples/exhaustive-benchmark.config.ts
 */

import type { BenchmarkConfig, ImageRef } from "../config.ts";
import { images } from "./benchmark-images.ts";

// Daytona image (pre-built with benchmark server)
const daytonaImage = images["daytona-benchmark-server"];

// E2B built-in templates - these are available without building
// Note: The "base" template is a basic Ubuntu environment
// We can't run our benchmark server on it, but we can still measure cold boot
const e2bBaseImage: ImageRef = {
  provider: "e2b",
  identifier: "base",
  dockerfile: "e2b-builtin-base",
  builtAt: "2024-01-01T00:00:00.000Z", // Built-in template
};

// Fly.io uses a simple HTTP server image for testing
// This is the official httpbin image which responds to various endpoints
const flyHttpbinImage: ImageRef = {
  provider: "fly",
  identifier: "kennethreitz/httpbin:latest",
  dockerfile: "httpbin-public-image",
  builtAt: new Date().toISOString(),
};

export const config: BenchmarkConfig = {
  configs: [
    // =====================
    // DAYTONA CONFIGURATIONS
    // =====================
    // Different CPU/memory combinations with our benchmark server
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

    // =====================
    // E2B CONFIGURATIONS
    // =====================
    // Using built-in base template
    // Note: Cold boot is measured, but request latency won't work
    // because base template doesn't have our benchmark server
    {
      name: "e2b-base",
      provider: "e2b",
      image: e2bBaseImage,
    },

    // =====================
    // FLY.IO CONFIGURATIONS
    // =====================
    // Using httpbin for testing - responds on port 80
    // Note: httpbin responds differently than our benchmark server
    {
      name: "fly-shared-1cpu-256mb",
      provider: "fly",
      image: flyHttpbinImage,
      cpuKind: "shared",
      cpus: 1,
      memoryMb: 256,
      region: "ord",
    },
    {
      name: "fly-shared-2cpu-512mb",
      provider: "fly",
      image: flyHttpbinImage,
      cpuKind: "shared",
      cpus: 2,
      memoryMb: 512,
      region: "ord",
    },
  ],

  // Number of sandboxes per configuration
  machinesPerConfig: 5,

  // Number of HTTP requests for latency testing
  // Note: Only Daytona will respond correctly to /ping
  requestsPerMachine: 30,

  // Concurrent requests
  batchSize: 5,

  // Restart cycles
  restartCyclesPerMachine: 2,

  // Output database
  output: "exhaustive-benchmark.db",

  // Keep sandboxes alive for debugging
  keepAlive: false,

  // Measurements
  measurements: {
    coldBoot: true,
    restart: true,
    requestLatency: true,
  },
};

// Daytona-only config for comprehensive testing with our benchmark server
export const daytonaOnlyConfig: BenchmarkConfig = {
  configs: [
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
    {
      name: "daytona-1cpu-2gb",
      provider: "daytona",
      image: daytonaImage,
      cpu: 1,
      memoryMb: 2048,
      region: "us-east",
    },
    {
      name: "daytona-2cpu-4gb",
      provider: "daytona",
      image: daytonaImage,
      cpu: 2,
      memoryMb: 4096,
      region: "us-east",
    },
  ],
  machinesPerConfig: 5,
  requestsPerMachine: 50,
  batchSize: 10,
  restartCyclesPerMachine: 3,
  output: "daytona-exhaustive.db",
  keepAlive: false,
  measurements: {
    coldBoot: true,
    restart: true,
    requestLatency: true,
  },
};
