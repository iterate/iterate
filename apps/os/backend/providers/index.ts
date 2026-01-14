import type { MachineType } from "../db/schema.ts";
import type { CloudflareEnv } from "../../env.ts";
import type { MachineProvider } from "./types.ts";
import { createDaytonaProvider } from "./daytona.ts";

export type { MachineProvider, CreateMachineConfig, MachineProviderResult } from "./types.ts";

export interface CreateProviderOptions {
  findAvailablePort?: () => Promise<number>;
}

export async function createMachineProvider(
  type: MachineType,
  env: CloudflareEnv,
  options?: CreateProviderOptions,
): Promise<MachineProvider> {
  switch (type) {
    case "daytona":
      return createDaytonaProvider(env.DAYTONA_API_KEY, env.DAYTONA_SNAPSHOT_PREFIX);

    case "local-docker": {
      if (!import.meta.env.DEV) {
        throw new Error("local-docker provider only available in development");
      }
      if (!options?.findAvailablePort) {
        throw new Error("findAvailablePort function required for local-docker provider");
      }
      const { createLocalDockerProvider } = await import("./local-docker.ts");
      return createLocalDockerProvider({
        imageName: "iterate-sandbox:local",
        findAvailablePort: options.findAvailablePort,
      });
    }

    case "local":
    case "local-vanilla":
      // Local machines point to already-running services (e.g., local daemon)
      // They don't need a provider for creation/destruction
      throw new Error(
        "Local machines do not require a provider - they reference existing services",
      );
    default: {
      const _exhaustiveCheck: never = type;
      throw new Error(`Unknown machine type: ${_exhaustiveCheck}`);
    }
  }
}
