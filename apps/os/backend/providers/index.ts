import type { MachineType } from "../db/schema.ts";
import type { CloudflareEnv } from "../../env.ts";
import type { MachineProvider } from "./types.ts";
import { createDaytonaProvider } from "./daytona.ts";
import { createLocalProvider, createLocalVanillaProvider } from "./local-docker.ts";

export type {
  MachineProvider,
  CreateMachineConfig,
  MachineProviderResult,
  MachineDisplayInfo,
  MachineCommand,
  TerminalOption,
} from "./types.ts";

export interface CreateMachineProviderOptions {
  type: MachineType;
  env: CloudflareEnv;
  externalId: string;
  metadata: Record<string, unknown>;
  buildProxyUrl: (port: number) => string;
}

export async function createMachineProvider(
  options: CreateMachineProviderOptions,
): Promise<MachineProvider> {
  const { type, env, externalId, metadata, buildProxyUrl } = options;

  switch (type) {
    case "daytona":
      return createDaytonaProvider({
        apiKey: env.DAYTONA_API_KEY,
        snapshotName: env.DAYTONA_SNAPSHOT_NAME,
        externalId,
        buildProxyUrl,
      });

    case "local-docker": {
      if (!import.meta.env.DEV) {
        throw new Error("local-docker provider only available in development");
      }
      const { createLocalDockerProvider } = await import("./local-docker.ts");
      return createLocalDockerProvider({
        imageName: "iterate-sandbox:local",
        externalId,
        metadata: metadata as {
          containerId?: string;
          port?: number;
          ports?: Record<string, number>;
        },
        buildProxyUrl,
      });
    }

    case "local":
      return createLocalProvider({
        metadata: metadata as { host?: string; port?: number; ports?: Record<string, number> },
        buildProxyUrl,
      });

    case "local-vanilla":
      return createLocalVanillaProvider({ buildProxyUrl });

    default: {
      const _exhaustiveCheck: never = type;
      throw new Error(`Unknown machine type: ${_exhaustiveCheck}`);
    }
  }
}
