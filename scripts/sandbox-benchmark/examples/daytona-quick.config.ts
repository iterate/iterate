/**
 * Quick Daytona benchmark - fast comprehensive test
 */
import type { BenchmarkConfig } from "../config.ts";
import { images } from "./benchmark-images.ts";

const daytonaImage = images["daytona-benchmark-server"];

export const config: BenchmarkConfig = {
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
  ],
  machinesPerConfig: 3,
  requestsPerMachine: 20,
  batchSize: 5,
  restartCyclesPerMachine: 2,
  output: "daytona-quick.db",
  keepAlive: false,
  measurements: {
    coldBoot: true,
    restart: true,
    requestLatency: true,
  },
};
