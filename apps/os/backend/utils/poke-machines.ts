import { eq, and } from "drizzle-orm";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { CloudflareEnv } from "../../env.ts";
import type { DB } from "../db/client.ts";
import * as schema from "../db/schema.ts";
import { logger } from "../tag-logger.ts";
import { createMachineProvider } from "../providers/index.ts";

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
 * Build the daemon tRPC base URL for a machine using the provider.
 */
async function buildDaemonBaseUrl(
  machine: typeof schema.machine.$inferSelect,
  env: CloudflareEnv,
): Promise<string | null> {
  const metadata = machine.metadata as Record<string, unknown>;

  try {
    const provider = await createMachineProvider({
      type: machine.type,
      env,
      externalId: machine.externalId,
      metadata,
      buildProxyUrl: () => "", // Not used here
    });
    return provider.previewUrl;
  } catch (err) {
    logger.warn("[poke-machines] Failed to build daemon URL", {
      machineId: machine.id,
      type: machine.type,
      error: err instanceof Error ? err.message : String(err),
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
    where: and(eq(schema.machine.projectId, projectId), eq(schema.machine.state, "active")),
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

type PokeResult = { machineId: string; success: boolean; error?: string };

/**
 * Poke a machine's daemon to pull the iterate repo.
 * Called after a prod deploy to update daemon code on all running machines.
 */
async function pokeMachineToPullIterateRepo(
  machine: typeof schema.machine.$inferSelect,
  env: CloudflareEnv,
): Promise<PokeResult> {
  const daemonBaseUrl = await buildDaemonBaseUrl(machine, env);
  if (!daemonBaseUrl) {
    return { machineId: machine.id, success: false, error: "Could not build daemon URL" };
  }

  const client = createDaemonTrpcClient(daemonBaseUrl);

  try {
    await client.platform.pullIterateRepo.mutate();
    logger.info("[poke-machines] Poked machine to pull iterate repo", { machineId: machine.id });
    return { machineId: machine.id, success: true };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error("[poke-machines] Failed to poke machine for iterate repo pull", {
      machineId: machine.id,
      error: errorMsg,
    });
    return { machineId: machine.id, success: false, error: errorMsg };
  }
}

/**
 * Poke all provided machines to pull the iterate repo.
 * Called by the service endpoint after a prod deploy.
 */
export async function pokeAllMachinesToPullIterateRepo(
  _db: DB,
  machines: (typeof schema.machine.$inferSelect)[],
  env: CloudflareEnv,
): Promise<PokeResult[]> {
  logger.info("[poke-machines] Poking all machines to pull iterate repo", {
    machineCount: machines.length,
  });

  return Promise.all(machines.map((machine) => pokeMachineToPullIterateRepo(machine, env)));
}
