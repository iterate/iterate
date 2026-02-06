import { z } from "zod/v4";
import { eq, and, or, gt, ne } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import {
  router,
  projectProtectedProcedure,
  projectProtectedMutation,
  publicProcedure,
} from "../trpc.ts";
import * as schema from "../../db/schema.ts";
import type { CloudflareEnv } from "../../../env.ts";
import type { DB } from "../../db/client.ts";
import { createMachineProvider, type MachineProvider } from "../../providers/index.ts";
import { logger } from "../../tag-logger.ts";
import { DAEMON_DEFINITIONS, getDaemonsWithWebUI } from "../../daemons.ts";
import { createMachineForProject } from "../../services/machine-creation.ts";
import type { TRPCRouter as DaemonTRPCRouter } from "../../../../daemon/server/trpc/router.ts";

function createDaemonTrpcClient(baseUrl: string) {
  return createTRPCClient<DaemonTRPCRouter>({
    links: [
      httpBatchLink({
        url: `${baseUrl}/api/trpc`,
      }),
    ],
  });
}

/** Service URL options for a daemon */
interface ServiceOption {
  label: string;
  url: string;
}

/** Enrich a machine with display info and service URLs from its provider */
async function enrichMachineWithProviderInfo<T extends typeof schema.machine.$inferSelect>(
  machine: T,
  cloudflareEnv: CloudflareEnv,
  orgSlug: string,
  projectSlug: string,
) {
  const metadata = (machine.metadata as Record<string, unknown>) ?? {};
  const buildProxyUrl = (port: number) =>
    `/org/${orgSlug}/proj/${projectSlug}/${machine.id}/proxy/${port}/`;
  const provider = await createMachineProvider({
    type: machine.type,
    env: cloudflareEnv,
    externalId: machine.externalId,
    metadata,
    buildProxyUrl,
  });

  // Build service options for each daemon with web UI
  const services = getDaemonsWithWebUI().map((daemon) => {
    const nativeUrl = provider.getPreviewUrl(daemon.internalPort);
    const proxyUrl = buildProxyUrl(daemon.internalPort);
    const options: ServiceOption[] = [];

    // Add native URL if different from proxy (e.g., Daytona has direct access)
    if (nativeUrl && !nativeUrl.startsWith("/")) {
      options.push({ label: "Direct", url: nativeUrl });
    }
    options.push({ label: options.length > 0 ? "Proxy" : "Open", url: proxyUrl });

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
    displayInfo: provider.displayInfo,
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
): Promise<{ provider: MachineProvider; machine: typeof schema.machine.$inferSelect }> {
  const machine = await db.query.machine.findFirst({
    where: and(eq(schema.machine.id, machineId), eq(schema.machine.projectId, projectId)),
  });

  if (!machine) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Machine not found",
    });
  }

  const provider = await createMachineProvider({
    type: machine.type,
    env: cloudflareEnv,
    externalId: machine.externalId,
    metadata: (machine.metadata as Record<string, unknown>) ?? {},
    buildProxyUrl: () => "", // Not used for lifecycle operations
  });

  return { provider, machine };
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
      return Promise.all(
        machines.map((m) =>
          enrichMachineWithProviderInfo(m, ctx.env, ctx.organization.slug, ctx.project.slug),
        ),
      );
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

      return enrichMachineWithProviderInfo(m, ctx.env, ctx.organization.slug, ctx.project.slug);
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
      const { provider, machine } = await getProviderForMachine(
        ctx.db,
        ctx.project.id,
        input.machineId,
        ctx.env,
      );

      if (!provider.getProviderState) {
        // Provider doesn't support state querying (e.g., docker)
        return {
          machineId: input.machineId,
          machineType: machine.type,
          providerState: null,
        };
      }

      const providerState = await provider.getProviderState().catch((err) => {
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
        type: z.enum(schema.MachineType).default("daytona"),
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
          organizationSlug: input.organizationSlug,
          projectSlug: input.projectSlug,
          name: input.name,
          type: input.type,
          metadata: input.metadata,
        });

        // Return apiKey for local machines - user needs this to configure their daemon
        if (input.type === "local" && result.apiKey) {
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
      const { provider } = await getProviderForMachine(
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

      await provider.archive().catch((err) => {
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
      const { provider, machine } = await getProviderForMachine(
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

      await provider.restart().catch((err) => {
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
      const { provider, machine } = await getProviderForMachine(
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
      const daemonClient = createDaemonTrpcClient(provider.previewUrl);
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
      const { provider } = await getProviderForMachine(
        ctx.db,
        ctx.project.id,
        input.machineId,
        ctx.env,
      );

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

      await provider.delete().catch((err) => {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to delete machine: ${err instanceof Error ? err.message : String(err)}`,
        });
      });

      return { success: true };
    }),

  // Get daemon definitions (for frontend to know what daemons exist)
  getDaemonDefinitions: publicProcedure.query(() => {
    return {
      daemons: DAEMON_DEFINITIONS,
      daemonsWithWebUI: getDaemonsWithWebUI(),
    };
  }),

  // Get available machine types (checks which providers are configured)
  getAvailableMachineTypes: publicProcedure.query(({ ctx }) => {
    const isMachineType = (value: string): value is (typeof schema.MachineType)[number] =>
      (schema.MachineType as ReadonlyArray<string>).includes(value);
    const configuredProviders = (ctx.env.SANDBOX_MACHINE_PROVIDERS ?? "")
      .split(",")
      .map((provider) => provider.trim())
      .filter(isMachineType);
    const enabledProviders = new Set(
      configuredProviders.length > 0
        ? configuredProviders
        : import.meta.env.DEV
          ? ["docker", "daytona", "fly", "local"]
          : ["daytona"],
    );
    const types: Array<{
      type: (typeof schema.MachineType)[number];
      label: string;
      disabledReason?: string;
    }> = [];

    if (enabledProviders.has("docker")) {
      types.push({
        type: "docker",
        label: "Docker",
        disabledReason: import.meta.env.DEV
          ? undefined
          : "Docker provider only available in development",
      });
    }

    if (enabledProviders.has("daytona")) {
      types.push({
        type: "daytona",
        label: "Daytona (Cloud)",
        disabledReason: ctx.env.DAYTONA_SNAPSHOT_NAME ? undefined : "DAYTONA_SNAPSHOT_NAME not set",
      });
    }

    if (enabledProviders.has("fly")) {
      const hasFlyToken = Boolean(ctx.env.FLY_API_TOKEN ?? ctx.env.FLY_API_KEY);
      types.push({
        type: "fly",
        label: "Fly.io",
        disabledReason: hasFlyToken ? undefined : "FLY_API_TOKEN (or FLY_API_KEY) not set",
      });
    }

    if (enabledProviders.has("local")) {
      types.push({ type: "local", label: "Local (Host:Port)" });
    }

    return types;
  }),

  getPreviewInfo: projectProtectedProcedure
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

      const buildProxyUrl = (port: number) =>
        `/org/${ctx.organization.slug}/proj/${ctx.project.slug}/${machineRecord.id}/proxy/${port}/`;

      // Metadata can have old format { port, containerId } or new format { ports, containerId }
      const metadata = machineRecord.metadata as {
        containerId?: string;
        port?: number;
        ports?: Record<string, number>;
        host?: string;
      };

      // Get the provider to build native URLs
      const provider = await createMachineProvider({
        type: machineRecord.type,
        env: ctx.env,
        externalId: machineRecord.externalId,
        metadata,
        buildProxyUrl,
      });

      // Build per-daemon URLs using provider
      const daemons = getDaemonsWithWebUI().map((daemon) => ({
        id: daemon.id,
        name: daemon.name,
        internalPort: daemon.internalPort,
        proxyUrl: buildProxyUrl(daemon.internalPort),
        nativeUrl: provider.getPreviewUrl(daemon.internalPort),
      }));

      // Terminal URL
      const terminalInternalPort = 22222;
      const terminalNativeUrl = provider.getPreviewUrl(terminalInternalPort);

      // Legacy fields for backward compatibility
      const iterateDaemon = DAEMON_DEFINITIONS.find((d) => d.id === "iterate-daemon");

      return {
        // New per-daemon URLs
        daemons,
        terminalUrl: buildProxyUrl(terminalInternalPort),
        nativeTerminalUrl: terminalNativeUrl,
        // Legacy fields (kept for backward compatibility)
        url: buildProxyUrl(iterateDaemon?.internalPort ?? 3000),
        daemonUrl: buildProxyUrl(iterateDaemon?.internalPort ?? 3000),
        nativeDaemonUrl: provider.getPreviewUrl(iterateDaemon?.internalPort ?? 3000),
        machineType: machineRecord.type,
        containerId: metadata.containerId,
        hostPort: metadata.ports?.["iterate-daemon"] ?? metadata.port,
      };
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

      const provider = await createMachineProvider({
        type: machineRecord.type,
        env: ctx.env,
        externalId: machineRecord.externalId,
        metadata: (machineRecord.metadata as Record<string, unknown>) ?? {},
        buildProxyUrl: () => "", // Not used here
      });
      const daemonClient = createDaemonTrpcClient(provider.previewUrl);
      const [agents, serverInfo] = await Promise.all([
        daemonClient.listAgents.query(),
        daemonClient.getServerCwd.query(),
      ]);
      return { agents, customerRepoPath: serverInfo.customerRepoPath };
    }),
});
