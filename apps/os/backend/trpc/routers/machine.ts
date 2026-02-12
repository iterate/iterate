import { z } from "zod/v4";
import { eq, and, or, gt, ne } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { SandboxFetcher } from "@iterate-com/sandbox/providers/types";
import { createMachineStub, type MachineStub } from "@iterate-com/sandbox/providers/machine-stub";
import {
  router,
  projectProtectedProcedure,
  projectProtectedMutation,
  publicProcedure,
} from "../trpc.ts";
import * as schema from "../../db/schema.ts";
import { waitUntil, type CloudflareEnv } from "../../../env.ts";
import type { DB } from "../../db/client.ts";
import { logger } from "../../tag-logger.ts";
import { DAEMON_DEFINITIONS, getDaemonsWithWebUI } from "../../daemons.ts";
import { createMachineForProject } from "../../services/machine-creation.ts";
import {
  buildCanonicalMachineIngressUrl,
  getIngressSchemeFromPublicUrl,
  normalizeProjectIngressCanonicalHost,
} from "../../utils/project-ingress-url.ts";
import { getProjectSandboxProviderOptions } from "../../utils/sandbox-providers.ts";
import type { TRPCRouter as DaemonTRPCRouter } from "../../../../daemon/server/trpc/router.ts";

function createDaemonTrpcClient(params: { baseUrl: string; fetcher?: SandboxFetcher }) {
  const { baseUrl, fetcher } = params;
  return createTRPCClient<DaemonTRPCRouter>({
    links: [
      httpBatchLink({
        url: `${baseUrl}/api/trpc`,
        ...(fetcher ? { fetch: fetcher } : {}),
      }),
    ],
  });
}

function parsePositiveIntegerOrDefault(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  return fallback;
}

/** Service URL options for a daemon */
interface ServiceOption {
  label: string;
  url: string;
}

/** Enrich a machine with provider-derived service URLs */
async function enrichMachineWithProviderInfo<T extends typeof schema.machine.$inferSelect>(
  machine: T,
  cloudflareEnv: CloudflareEnv,
) {
  const metadata = (machine.metadata as Record<string, unknown>) ?? {};

  if (!machine.externalId) {
    return { ...machine, metadata, services: [] };
  }

  const canonicalHost = normalizeProjectIngressCanonicalHost(
    cloudflareEnv.PROJECT_INGRESS_PROXY_CANONICAL_HOST,
  );
  if (!canonicalHost) {
    logger.error("Invalid PROJECT_INGRESS_PROXY_CANONICAL_HOST in machine router", {
      projectIngressProxyCanonicalHost: cloudflareEnv.PROJECT_INGRESS_PROXY_CANONICAL_HOST,
    });
    return { ...machine, metadata, services: [] };
  }

  const scheme = getIngressSchemeFromPublicUrl(cloudflareEnv.VITE_PUBLIC_URL);

  const services = getDaemonsWithWebUI().map((daemon) => {
    const url = buildCanonicalMachineIngressUrl({
      scheme,
      canonicalHost,
      machineId: machine.id,
      port: daemon.internalPort,
    });
    const options: ServiceOption[] = [{ label: "Open", url }];

    return {
      id: daemon.id,
      name: daemon.name,
      port: daemon.internalPort,
      options,
    };
  });

  return {
    ...machine,
    metadata,
    services,
  };
}

// Hash an API key using SHA-256
export async function hashApiKey(apiKey: string): Promise<string> {
  const encoded = new TextEncoder().encode(apiKey);
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Verify an API key against its hash (kept for backward compatibility during migration)
export async function verifyApiKey(apiKey: string, hash: string): Promise<boolean> {
  const computedHash = await hashApiKey(apiKey);
  return computedHash === hash;
}

// Helper to get provider for a machine by looking up its type from the database
async function getProviderForMachine(
  db: DB,
  projectId: string,
  machineId: string,
  cloudflareEnv: CloudflareEnv,
): Promise<{ runtime: MachineStub; machine: typeof schema.machine.$inferSelect }> {
  const machine = await db.query.machine.findFirst({
    where: and(eq(schema.machine.id, machineId), eq(schema.machine.projectId, projectId)),
  });

  if (!machine) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Machine not found",
    });
  }

  const runtime = await createMachineStub({
    type: machine.type,
    env: cloudflareEnv,
    externalId: machine.externalId,
    metadata: (machine.metadata as Record<string, unknown>) ?? {},
  });

  return { runtime, machine };
}

export const machineRouter = router({
  // List machines in project
  list: projectProtectedProcedure
    .input(
      z.object({
        includeArchived: z.boolean().default(false).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const includeArchived = input.includeArchived ?? false;

      // Show non-archived machines, plus recently archived ones (last 60s) for smooth UI transition
      const recentlyArchivedCutoff = new Date(Date.now() - 60 * 1000);

      const machines = await ctx.db.query.machine.findMany({
        where: includeArchived
          ? eq(schema.machine.projectId, ctx.project.id)
          : and(
              eq(schema.machine.projectId, ctx.project.id),
              or(
                ne(schema.machine.state, "archived"),
                gt(schema.machine.updatedAt, recentlyArchivedCutoff),
              ),
            ),
        orderBy: (m, { desc }) => [desc(m.createdAt)],
      });

      // Enrich each machine with provider info
      return Promise.all(machines.map((m) => enrichMachineWithProviderInfo(m, ctx.env)));
    }),

  // Get machine by ID
  byId: projectProtectedProcedure
    .input(
      z.object({
        machineId: z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const m = await ctx.db.query.machine.findFirst({
        where: and(
          eq(schema.machine.id, input.machineId),
          eq(schema.machine.projectId, ctx.project.id),
        ),
      });

      if (!m) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Machine not found",
        });
      }

      return enrichMachineWithProviderInfo(m, ctx.env);
    }),

  // Get provider-level state (e.g., Daytona sandbox state)
  // This queries the provider directly to get fresh state info
  getProviderState: projectProtectedProcedure
    .input(
      z.object({
        machineId: z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { runtime, machine } = await getProviderForMachine(
        ctx.db,
        ctx.project.id,
        input.machineId,
        ctx.env,
      );

      if (!runtime.getProviderState) {
        // Provider doesn't support state querying (e.g., docker)
        return {
          machineId: input.machineId,
          machineType: machine.type,
          providerState: null,
        };
      }

      const providerState = await runtime.getProviderState().catch((err) => {
        logger.error("Failed to get provider state", { machineId: input.machineId, err });
        return { state: "error", errorReason: String(err) };
      });

      return {
        machineId: input.machineId,
        machineType: machine.type,
        providerState,
      };
    }),

  // Create a new machine
  // Returns apiKey for local machines (user needs to configure daemon manually)
  create: projectProtectedMutation
    .input(
      z.object({
        name: z.string().min(1).max(100),
        metadata: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const result = await createMachineForProject({
          db: ctx.db,
          env: ctx.env,
          projectId: ctx.project.id,
          organizationId: ctx.organization.id,
          organizationSlug: ctx.organization.slug,
          projectSlug: ctx.project.slug,
          name: input.name,
          metadata: input.metadata,
        });

        // Provision in background — the DB record is already created
        if (result.provisionPromise) {
          waitUntil(result.provisionPromise);
        }

        // Return apiKey for local machines - user needs this to configure their daemon
        if (result.apiKey) {
          return { ...result.machine, apiKey: result.apiKey };
        }

        return result.machine;
      } catch (err) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to create machine: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }),

  // Archive a machine
  archive: projectProtectedMutation
    .input(
      z.object({
        machineId: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { runtime } = await getProviderForMachine(
        ctx.db,
        ctx.project.id,
        input.machineId,
        ctx.env,
      );

      const [updated] = await ctx.db
        .update(schema.machine)
        .set({ state: "archived" })
        .where(
          and(eq(schema.machine.id, input.machineId), eq(schema.machine.projectId, ctx.project.id)),
        )
        .returning();

      if (!updated) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Machine not found",
        });
      }

      await runtime.archive().catch((err) => {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to archive machine: ${err instanceof Error ? err.message : String(err)}`,
        });
      });

      return updated;
    }),

  // Restart a machine (stops and starts the sandbox)
  restart: projectProtectedMutation
    .input(
      z.object({
        machineId: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { runtime, machine } = await getProviderForMachine(
        ctx.db,
        ctx.project.id,
        input.machineId,
        ctx.env,
      );

      // Set daemonStatus to "restarting" so UI shows "Restarting..." until daemon reports ready
      const updatedMetadata = {
        ...((machine.metadata as Record<string, unknown>) ?? {}),
        daemonStatus: "restarting",
        daemonReadyAt: null,
      };

      await ctx.db
        .update(schema.machine)
        .set({ metadata: updatedMetadata })
        .where(eq(schema.machine.id, input.machineId));

      // Broadcast invalidation immediately so UI updates to show "Restarting..."
      const { broadcastInvalidation } = await import("../../utils/query-invalidation.ts");
      await broadcastInvalidation(ctx.env).catch((err) => {
        logger.error("Failed to broadcast invalidation", err);
      });

      await runtime.restart().catch((err) => {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to restart machine: ${err instanceof Error ? err.message : String(err)}`,
        });
      });

      return { success: true };
    }),

  // Restart just the daemon process (faster than full machine restart)
  // Uses s6 supervisor to restart the daemon without touching the sandbox
  restartDaemon: projectProtectedMutation
    .input(
      z.object({
        machineId: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { runtime, machine } = await getProviderForMachine(
        ctx.db,
        ctx.project.id,
        input.machineId,
        ctx.env,
      );

      // Set daemonStatus to "restarting" so UI shows "Restarting..." until daemon reports ready
      const updatedMetadata = {
        ...((machine.metadata as Record<string, unknown>) ?? {}),
        daemonStatus: "restarting",
        daemonReadyAt: null,
      };

      await ctx.db
        .update(schema.machine)
        .set({ metadata: updatedMetadata })
        .where(eq(schema.machine.id, input.machineId));

      // Broadcast invalidation immediately so UI updates to show "Restarting..."
      const { broadcastInvalidation } = await import("../../utils/query-invalidation.ts");
      await broadcastInvalidation(ctx.env).catch((err) => {
        logger.error("Failed to broadcast invalidation", err);
      });

      // Call daemon's restartDaemon endpoint
      const [daemonBaseUrl, daemonFetcher] = await Promise.all([
        runtime.getBaseUrl(3000),
        runtime.getFetcher(3000),
      ]);
      const daemonClient = createDaemonTrpcClient({
        baseUrl: daemonBaseUrl,
        fetcher: daemonFetcher,
      });
      await daemonClient.restartDaemon.mutate().catch((err) => {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to restart daemon: ${err instanceof Error ? err.message : String(err)}`,
        });
      });

      return { success: true };
    }),

  // Delete a machine permanently
  delete: projectProtectedMutation
    .input(
      z.object({
        machineId: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { runtime } = await getProviderForMachine(
        ctx.db,
        ctx.project.id,
        input.machineId,
        ctx.env,
      );

      // Best-effort provider cleanup first — don't block DB deletion if provider fails
      // (e.g. sandbox already deleted, invalid externalId, provider API down)
      await runtime.delete().catch((err) => {
        logger.warn("Failed to delete provider sandbox, proceeding with DB cleanup", {
          machineId: input.machineId,
          error: err instanceof Error ? err.message : String(err),
        });
      });

      // Delete machine from DB (token is shared across project, so we keep it)
      const deleted = await ctx.db
        .delete(schema.machine)
        .where(
          and(eq(schema.machine.id, input.machineId), eq(schema.machine.projectId, ctx.project.id)),
        )
        .returning();

      if (deleted.length === 0) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Machine not found",
        });
      }

      return { success: true };
    }),

  // Get daemon definitions (for frontend to know what daemons exist)
  getDaemonDefinitions: publicProcedure.query(() => {
    return {
      daemons: DAEMON_DEFINITIONS,
      daemonsWithWebUI: getDaemonsWithWebUI(),
    };
  }),

  // Get default snapshot/image for each provider (used by create-machine UI)
  getDefaultSnapshots: publicProcedure.query(({ ctx }) => {
    return {
      daytona: ctx.env.DAYTONA_DEFAULT_SNAPSHOT ?? null,
      fly: ctx.env.FLY_DEFAULT_IMAGE ?? null,
      docker: ctx.env.DOCKER_DEFAULT_IMAGE ?? null,
      flyMachineCpus: parsePositiveIntegerOrDefault(ctx.env.FLY_DEFAULT_CPUS, 4),
    };
  }),

  // Get available machine types (checks which providers are configured)
  getAvailableMachineTypes: publicProcedure.query(({ ctx }) => {
    const types: Array<{
      type: (typeof schema.MachineType)[number];
      label: string;
      disabledReason?: string;
    }> = [];

    for (const provider of getProjectSandboxProviderOptions(ctx.env, import.meta.env.DEV)) {
      types.push({
        type: provider.type,
        label: provider.label,
        disabledReason: provider.disabledReason,
      });
    }

    if (import.meta.env.DEV) {
      types.push({ type: "local", label: "Local (Host:Port)" });
    }

    return types;
  }),

  // List agents running on a machine (proxies to daemon)
  listAgents: projectProtectedProcedure
    .input(
      z.object({
        machineId: z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const machineRecord = await ctx.db.query.machine.findFirst({
        where: and(
          eq(schema.machine.id, input.machineId),
          eq(schema.machine.projectId, ctx.project.id),
        ),
      });
      if (!machineRecord) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Machine not found",
        });
      }

      const runtime = await createMachineStub({
        type: machineRecord.type,
        env: ctx.env,
        externalId: machineRecord.externalId,
        metadata: (machineRecord.metadata as Record<string, unknown>) ?? {},
      });
      const [daemonBaseUrl, daemonFetcher] = await Promise.all([
        runtime.getBaseUrl(3000),
        runtime.getFetcher(3000),
      ]);
      const daemonClient = createDaemonTrpcClient({
        baseUrl: daemonBaseUrl,
        fetcher: daemonFetcher,
      });
      const [agents, serverInfo] = await Promise.all([
        daemonClient.listAgents.query(),
        daemonClient.getServerCwd.query(),
      ]);
      return { agents, customerRepoPath: serverInfo.customerRepoPath };
    }),
});
