/**
 * Benchmark configuration types
 */

// Image reference returned by build step
export interface ImageRef {
  provider: ProviderName;
  identifier: string; // snapshot name, template ID, or image tag
  dockerfile: string;
  builtAt: string;
}

export type ProviderName = "daytona" | "e2b" | "fly";

// Provider-specific config types
export interface DaytonaProviderConfig {
  name: string;
  provider: "daytona";
  image: ImageRef;
  cpu?: number; // Default: 2
  memoryMb?: number; // Default: 2048
  region?: string;
}

export interface E2BProviderConfig {
  name: string;
  provider: "e2b";
  image: ImageRef;
  // E2B resources determined by template, not configurable at runtime
}

export interface FlyProviderConfig {
  name: string;
  provider: "fly";
  image: ImageRef;
  cpuKind: "shared" | "performance";
  cpus: number;
  memoryMb: number;
  region: string;
}

export type ProviderConfig = DaytonaProviderConfig | E2BProviderConfig | FlyProviderConfig;

// Measurement toggles
export interface MeasurementConfig {
  coldBoot: boolean;
  restart: boolean;
  requestLatency: boolean;
}

// Main benchmark config (exported from user's config file)
export interface BenchmarkConfig {
  configs: ProviderConfig[];
  machinesPerConfig: number;
  requestsPerMachine: number;
  batchSize: number; // Concurrency for request latency measurements
  restartCyclesPerMachine: number;
  output: string; // SQLite db path
  keepAlive?: boolean; // Don't destroy sandboxes after run
  measurements: MeasurementConfig;
}

// Build config for image building step
export interface BuildConfig {
  dockerfiles: {
    name: string; // e.g., "python-minimal"
    path: string; // e.g., "dockerfiles/python-minimal.Dockerfile"
  }[];
  providers: ProviderName[];
  outputFile: string; // e.g., "benchmark-images.ts"
}

// Hard limit to prevent accidental resource creation
export const MAX_SANDBOXES = 200;

// Validate config and return total sandbox count
export function validateConfig(config: BenchmarkConfig): number {
  const totalSandboxes = config.configs.length * config.machinesPerConfig;

  if (totalSandboxes > MAX_SANDBOXES) {
    throw new Error(
      `Config would create ${totalSandboxes} sandboxes, exceeding limit of ${MAX_SANDBOXES}`,
    );
  }

  if (config.machinesPerConfig < 1) {
    throw new Error("machinesPerConfig must be at least 1");
  }

  if (config.requestsPerMachine < 0) {
    throw new Error("requestsPerMachine must be non-negative");
  }

  if (config.batchSize < 1) {
    throw new Error("batchSize must be at least 1");
  }

  if (config.restartCyclesPerMachine < 0) {
    throw new Error("restartCyclesPerMachine must be non-negative");
  }

  // Validate each provider config
  for (const providerConfig of config.configs) {
    if (!providerConfig.name) {
      throw new Error("Each provider config must have a name");
    }
    if (!providerConfig.image) {
      throw new Error(`Provider config "${providerConfig.name}" missing image`);
    }
  }

  return totalSandboxes;
}
