import type { MachineType } from "../db/schema.ts";
import type { CloudflareEnv } from "../../env.ts";
import type { MachineProvider } from "./types.ts";
import { createDaytonaProvider } from "./daytona.ts";
import { createLocalProvider, createLocalVanillaProvider } from "./local-docker.ts";

export type { MachineProvider, CreateMachineConfig, MachineProviderResult } from "./types.ts";

export async function createMachineProvider(
  type: MachineType,
  env: CloudflareEnv,
): Promise<MachineProvider> {
  switch (type) {
    case "daytona":
      return createDaytonaProvider(env.DAYTONA_API_KEY, env.DAYTONA_SNAPSHOT_PREFIX);

    case "local-docker": {
      if (!import.meta.env.DEV) {
        throw new Error("local-docker provider only available in development");
      }
      const { createLocalDockerProvider } = await import("./local-docker.ts");
      return createLocalDockerProvider({ imageName: "iterate-sandbox:local" });
    }

    case "local":
      return createLocalProvider();

    case "local-vanilla":
      return createLocalVanillaProvider();

    default: {
      const _exhaustiveCheck: never = type;
      throw new Error(`Unknown machine type: ${_exhaustiveCheck}`);
    }
  }
}
