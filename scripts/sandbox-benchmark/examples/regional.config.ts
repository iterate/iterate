/**
 * Regional benchmark config - 5 machines across "EU" and "US" configurations
 *
 * Note: Currently Daytona target is set at client level, so all machines
 * run in the same region. The config names simulate regions for report grouping.
 *
 * Usage:
 *   doppler run -- tsx cli.ts run --config scripts/sandbox-benchmark/examples/regional.config.ts
 */

import type { BenchmarkConfig } from "../config.ts";
import { images } from "./benchmark-images.ts";

export const config: BenchmarkConfig = {
  configs: [
    {
      name: "daytona-eu-west",
      provider: "daytona",
      image: images["daytona-benchmark-server"],
      region: "eu-west",
    },
    {
      name: "daytona-eu-central",
      provider: "daytona",
      image: images["daytona-benchmark-server"],
      region: "eu-central",
    },
    {
      name: "daytona-us-east",
      provider: "daytona",
      image: images["daytona-benchmark-server"],
      region: "us-east",
    },
    {
      name: "daytona-us-west",
      provider: "daytona",
      image: images["daytona-benchmark-server"],
      region: "us-west",
    },
    {
      name: "daytona-us-central",
      provider: "daytona",
      image: images["daytona-benchmark-server"],
      region: "us-central",
    },
  ],

  machinesPerConfig: 1, // 1 machine per config = 5 total machines
  requestsPerMachine: 100,
  batchSize: 10, // 10 concurrent requests
  restartCyclesPerMachine: 1,

  measurements: {
    coldBoot: true,
    restart: true,
    requestLatency: true,
  },

  keepAlive: false,
  output: "regional-benchmark.db",
};
