/**
 * Example E2B benchmark config
 *
 * E2B requires templates to be built beforehand using the CLI:
 *   e2b template build --dockerfile ../sandbox-server/Dockerfile --name benchmark-server
 *
 * For a quick test, you can use E2B's base template (no custom image needed).
 *
 * Usage:
 *   doppler run --config dev -- tsx cli.ts run --config examples/e2b.config.ts
 */

import type { BenchmarkConfig, ImageRef } from "../config.ts";

// Pre-built E2B template (build with: e2b template build ...)
// Or use "base" for E2B's default template
const e2bImage: ImageRef = {
  provider: "e2b",
  identifier: "base", // E2B's default template - replace with your custom template name
  dockerfile: "../sandbox-server/Dockerfile",
  builtAt: new Date().toISOString(),
};

export const config: BenchmarkConfig = {
  configs: [
    {
      name: "e2b-base",
      provider: "e2b",
      image: e2bImage,
      // E2B resources are determined at template build time, not runtime
    },
  ],

  // Number of sandboxes to create
  machinesPerConfig: 1,

  // HTTP requests per sandbox
  requestsPerMachine: 10,

  // Concurrency
  batchSize: 1,

  // Restart cycles (E2B uses pause/resume instead of stop/start)
  restartCyclesPerMachine: 0, // Set to 0 since E2B restart semantics differ

  // Output
  output: "e2b-benchmark.db",

  // Keep alive for debugging
  keepAlive: false,

  // Measurements
  measurements: {
    coldBoot: true,
    restart: false, // E2B uses pause/resume, not stop/start
    requestLatency: true,
  },
};
