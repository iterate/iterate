/**
 * Debug config - minimal settings for troubleshooting
 */

import type { BenchmarkConfig } from "../config.ts";
import { images } from "./benchmark-images.ts";

export const config: BenchmarkConfig = {
  configs: [
    {
      name: "daytona-debug",
      provider: "daytona",
      image: images["daytona-benchmark-server"],
    },
  ],

  machinesPerConfig: 1,
  requestsPerMachine: 3,
  batchSize: 1,
  restartCyclesPerMachine: 1,

  measurements: {
    coldBoot: true,
    restart: true,
    requestLatency: true,
  },

  keepAlive: false,
  output: "debug-results.db",
};
