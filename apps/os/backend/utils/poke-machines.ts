import { eq, and } from "drizzle-orm";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { CloudflareEnv } from "../../env.ts";
import type { DB } from "../db/client.ts";
import * as schema from "../db/schema.ts";
import { logger } from "../tag-logger.ts";
import { createDaytonaProvider } from "../providers/daytona.ts";
import type { TRPCRouter } from "../../../daemon/server/trpc/router.ts";

function createDaemonTrpcClient(baseUrl: string) {
  return createTRPCClient<TRPCRouter>({
    links: [
      httpBatchLink({
        url: `${baseUrl}/api/trpc`,
      }),
    ],
  });
}

/**
 * Build the daemon tRPC base URL for a machine.
 * Uses port 3000 which is where the daemon's tRPC server runs.
 */
async function buildDaemonBaseUrl(
  machine: typeof schema.machine.$inferSelect,
  env: CloudflareEnv,
): Promise<string | null> {
  const metadata = machine.metadata as Record<string, unknown>;

  switch (machine.type) {
    case "daytona": {
      const provider = createDaytonaProvider(env.DAYTONA_API_KEY, env.DAYTONA_SNAPSHOT_PREFIX);
      return provider.getPreviewUrl(machine.externalId, metadata, 3000);
    }
    case "local-docker": {
      if (!import.meta.env.DEV) {
        logger.warn("[poke-machines] local-docker provider only available in development", {
          machineId: machine.id,
        });
        return null;
      }
      const { createLocalDockerProvider } = await import("../providers/local-docker.ts");
      const provider = createLocalDockerProvider({ imageName: "iterate-sandbox:local" });
      return provider.getPreviewUrl(machine.externalId, metadata, 3000);
    }
    case "local-vanilla":
    case "local": {
      const host = (metadata.host as string) ?? "localhost";
      const ports = metadata.ports as Record<string, number> | undefined;
      const port = ports?.["iterate-daemon"] ?? (metadata.port as number | undefined) ?? 3000;
      return `http://${host}:${port}`;
    }
    default:
      logger.warn("[poke-machines] Unknown machine type for daemon URL", {
        machineId: machine.id,
        type: machine.type,
      });
      return null;
  }
}

/**
 * Poke a machine's daemon to trigger a bootstrap data refresh.
 * The daemon will pull fresh data from the control plane.
 */
async function pokeMachineToRefresh(
  machine: typeof schema.machine.$inferSelect,
  env: CloudflareEnv,
): Promise<void> {
  const daemonBaseUrl = await buildDaemonBaseUrl(machine, env);
  if (!daemonBaseUrl) {
    logger.warn("[poke-machines] Could not build daemon URL for machine", {
      machineId: machine.id,
    });
    return;
  }

  const client = createDaemonTrpcClient(daemonBaseUrl);

  try {
    await client.platform.refreshEnv.mutate();
    logger.info("[poke-machines] Poked machine to refresh env", { machineId: machine.id });
  } catch (err) {
    logger.error("[poke-machines] Failed to poke machine for refresh", err);
  }
}

/**
 * Poke all running machines for a project to refresh their bootstrap data.
 * Called after env vars change or OAuth tokens are updated.
 */
export async function pokeRunningMachinesToRefresh(
  db: DB,
  projectId: string,
  env: CloudflareEnv,
): Promise<void> {
  const runningMachines = await db.query.machine.findMany({
    where: and(eq(schema.machine.projectId, projectId), eq(schema.machine.state, "started")),
  });

  if (runningMachines.length === 0) {
    logger.info("[poke-machines] No running machines to poke", { projectId });
    return;
  }

  logger.info("[poke-machines] Poking machines to refresh env", {
    projectId,
    machineCount: runningMachines.length,
  });

  await Promise.all(runningMachines.map((machine) => pokeMachineToRefresh(machine, env)));
}
