import type { MachineType } from "../db/schema.ts";
import type { CloudflareEnv } from "../../env.ts";
import type { MachineProvider } from "./types.ts";
import { createDaytonaProvider } from "./daytona.ts";
import { createFlyProvider } from "./fly.ts";
import { createLocalProvider } from "./local-docker.ts";

export type {
  MachineProvider,
  CreateMachineConfig,
  MachineProviderResult,
  MachineDisplayInfo,
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
      // Allow metadata.snapshotName to override env var (used by webhook for specific commits)
      const typedMeta = metadata as { snapshotName?: string };
      const snapshotName =
        typedMeta.snapshotName ?? env.DAYTONA_SNAPSHOT_NAME ?? env.VITE_DAYTONA_SNAPSHOT_NAME;
      if (!snapshotName) {
        throw new Error(
          "DAYTONA_SNAPSHOT_NAME or VITE_DAYTONA_SNAPSHOT_NAME is required for Daytona machines",
        );
      }
      return createDaytonaProvider({
        apiKey: env.DAYTONA_API_KEY,
        organizationId: env.DAYTONA_ORG_ID,
        snapshotName,
        autoStopInterval: Number(env.DAYTONA_SANDBOX_AUTO_STOP_INTERVAL),
        autoDeleteInterval: Number(env.DAYTONA_SANDBOX_AUTO_DELETE_INTERVAL),
        externalId,
        appStage: env.APP_STAGE,
      });
    }

    case "docker": {
      if (!import.meta.env.DEV) {
        throw new Error("docker provider only available in development");
      }
      const { createLocalDockerProvider } = await import("./local-docker.ts");
      return createLocalDockerProvider({
        imageName: env.DOCKER_IMAGE_NAME || env.LOCAL_DOCKER_IMAGE_NAME || "iterate-sandbox:local",
        externalId,
        metadata,
        composeProjectName:
          env.DOCKER_COMPOSE_PROJECT_NAME || env.LOCAL_DOCKER_COMPOSE_PROJECT_NAME || undefined,
        repoCheckout:
          env.DOCKER_GIT_REPO_ROOT ||
          env.LOCAL_DOCKER_GIT_REPO_ROOT ||
          env.LOCAL_DOCKER_REPO_CHECKOUT ||
          undefined,
        gitDir: env.DOCKER_GIT_GITDIR || env.LOCAL_DOCKER_GIT_GITDIR || undefined,
        commonDir: env.DOCKER_GIT_COMMON_DIR || env.LOCAL_DOCKER_GIT_COMMON_DIR || undefined,
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

    case "fly": {
      return createFlyProvider({
        externalId,
        metadata,
        rawEnv: env as unknown as Record<string, string | undefined>,
      });
    }

    default: {
      const _exhaustiveCheck: never = type;
      throw new Error(`Unknown machine type: ${_exhaustiveCheck}`);
    }
  }
}
