/**
 * Example run config for benchmarking
 *
 * Usage:
 *   doppler run -- tsx cli.ts run --config examples/run.config.ts
 */

import type { BenchmarkConfig } from "../config.ts";
import { images } from "./benchmark-images.ts";

export const config: BenchmarkConfig = {
  configs: [
    {
      name: "daytona-small",
      provider: "daytona",
      image: images["daytona-benchmark-server"],
      cpu: 1,
      memoryMb: 1024,
      region: "us-east",
    },
    // Uncomment for larger config comparison:
    // {
    //   name: "daytona-large",
    //   provider: "daytona",
    //   image: images["daytona-benchmark-server"],
    //   cpu: 2,
    //   memoryMb: 2048,
    //   region: "us-east",
    // },
  ],

  // Number of sandboxes to create per config
  machinesPerConfig: 1,

  // Number of HTTP requests to make to each sandbox for latency measurement
  requestsPerMachine: 10,

  // Batch size for concurrent requests (1 = sequential, higher = parallel)
  batchSize: 1,

  // Number of restart cycles per sandbox
  restartCyclesPerMachine: 1,

  // Output SQLite database
  output: "benchmark-results.db",

  // Keep sandboxes alive after benchmark (for debugging)
  keepAlive: false,

  // Which measurements to run
  measurements: {
    coldBoot: true,
    restart: true,
    requestLatency: true,
  },
};
