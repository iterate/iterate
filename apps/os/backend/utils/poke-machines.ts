import { eq, and } from "drizzle-orm";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { createMachineStub } from "@iterate-com/sandbox/providers/machine-stub";
import type { SandboxFetcher } from "@iterate-com/sandbox/providers/types";
import type { CloudflareEnv } from "../../env.ts";
import type { DB } from "../db/client.ts";
import * as schema from "../db/schema.ts";
import { logger } from "../tag-logger.ts";

import type { TRPCRouter } from "../../../daemon/server/trpc/router.ts";

function createDaemonTrpcClient(params: { baseUrl: string; fetcher?: SandboxFetcher }) {
  const { baseUrl, fetcher } = params;
  return createTRPCClient<TRPCRouter>({
    links: [
      httpBatchLink({
        url: `${baseUrl}/api/trpc`,
        ...(fetcher ? { fetch: fetcher } : {}),
      }),
    ],
  });
}

/**
 * Build the daemon tRPC transport for a machine using the provider.
 */
async function buildDaemonTransport(
  machine: typeof schema.machine.$inferSelect,
  env: CloudflareEnv,
): Promise<{ baseUrl: string; fetcher: SandboxFetcher } | null> {
  const metadata = machine.metadata as Record<string, unknown>;

  try {
    const runtime = await createMachineStub({
      type: machine.type,
      env,
      externalId: machine.externalId,
      metadata,
    });
    const [baseUrl, fetcher] = await Promise.all([
      runtime.getBaseUrl(3000),
      runtime.getFetcher(3000),
    ]);
    return { baseUrl, fetcher };
  } catch (err) {
    logger.warn("[poke-machines] Failed to build daemon transport", {
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
  const daemonTransport = await buildDaemonTransport(machine, env);
  if (!daemonTransport) {
    logger.warn("[poke-machines] Could not build daemon transport for machine", {
      machineId: machine.id,
    });
    return;
  }

  const client = createDaemonTrpcClient(daemonTransport);

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
