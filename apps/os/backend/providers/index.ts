import type { MachineType } from "../db/schema.ts";
import type { CloudflareEnv } from "../../env.ts";
import type { MachineProvider } from "./types.ts";
import { createDaytonaProvider } from "./daytona.ts";
import { createLocalDockerProvider } from "./local-docker.ts";

export type { MachineProvider, CreateMachineConfig, MachineProviderResult } from "./types.ts";

export interface CreateProviderOptions {
  findAvailablePort?: () => Promise<number>;
}

export function createMachineProvider(
  type: MachineType,
  env: CloudflareEnv,
  options?: CreateProviderOptions,
): MachineProvider {
  switch (type) {
    case "daytona":
      return createDaytonaProvider(env.DAYTONA_API_KEY, env.DAYTONA_SNAPSHOT_PREFIX);

    case "local-docker":
      if (!options?.findAvailablePort) {
        throw new Error("findAvailablePort function required for local-docker provider");
      }
      return createLocalDockerProvider({
        imageName: "iterate-sandbox:local",
        findAvailablePort: options.findAvailablePort,
      });

    default: {
      const _exhaustiveCheck: never = type;
      throw new Error(`Unknown machine type: ${_exhaustiveCheck}`);
    }
  }
}
