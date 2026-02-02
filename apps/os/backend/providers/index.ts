import type { MachineType } from "../db/schema.ts";
import type { CloudflareEnv } from "../../env.ts";
import type { MachineProvider } from "./types.ts";
import { createDaytonaProvider } from "./daytona.ts";
import { createLocalProvider } from "./local-docker.ts";

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
    case "daytona": {
      if (!env.DAYTONA_SNAPSHOT_NAME) {
        throw new Error("DAYTONA_SNAPSHOT_NAME is required for Daytona machines");
      }
      return createDaytonaProvider({
        apiKey: env.DAYTONA_API_KEY,
        snapshotName: env.DAYTONA_SNAPSHOT_NAME,
        autoStopInterval: Number(env.DAYTONA_SANDBOX_AUTO_STOP_INTERVAL),
        autoDeleteInterval: Number(env.DAYTONA_SANDBOX_AUTO_DELETE_INTERVAL),
        externalId,
        buildProxyUrl,
      });
    }

    case "local-docker": {
      if (!import.meta.env.DEV) {
        throw new Error("local-docker provider only available in development");
      }
      // Cast env to access dev-only bindings
      const devEnv = env as CloudflareEnv & {
        LOCAL_DOCKER_COMPOSE_PROJECT_NAME?: string;
        LOCAL_DOCKER_IMAGE_NAME?: string;
        LOCAL_DOCKER_GIT_REPO_ROOT?: string;
        LOCAL_DOCKER_GIT_GITDIR?: string;
        LOCAL_DOCKER_GIT_COMMON_DIR?: string;
        LOCAL_DOCKER_REPO_CHECKOUT?: string;
        LOCAL_DOCKER_GIT_DIR?: string;
        LOCAL_DOCKER_COMMON_DIR?: string;
      };
      const { createLocalDockerProvider } = await import("./local-docker.ts");
      return createLocalDockerProvider({
        imageName: devEnv.LOCAL_DOCKER_IMAGE_NAME ?? "ghcr.io/iterate/sandbox:local",
        externalId,
        metadata,
        composeProjectName: devEnv.LOCAL_DOCKER_COMPOSE_PROJECT_NAME,
        repoCheckout: devEnv.LOCAL_DOCKER_GIT_REPO_ROOT ?? devEnv.LOCAL_DOCKER_REPO_CHECKOUT,
        gitDir: devEnv.LOCAL_DOCKER_GIT_GITDIR ?? devEnv.LOCAL_DOCKER_GIT_DIR,
        commonDir: devEnv.LOCAL_DOCKER_GIT_COMMON_DIR ?? devEnv.LOCAL_DOCKER_COMMON_DIR,
      });
    }

    case "local": {
      const typedMeta = metadata as { host?: string; ports?: Record<string, number> };
      return createLocalProvider({
        host: typedMeta.host ?? "localhost",
        ports: typedMeta.ports ?? {},
        buildProxyUrl,
      });
    }

    default: {
      const _exhaustiveCheck: never = type;
      throw new Error(`Unknown machine type: ${_exhaustiveCheck}`);
    }
  }
}
