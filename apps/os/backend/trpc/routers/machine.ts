import { z } from "zod/v4";
import { eq, and, isNull } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { typeid } from "typeid-js";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import {
  router,
  projectProtectedProcedure,
  projectProtectedMutation,
  publicProcedure,
} from "../trpc.ts";
import * as schema from "../../db/schema.ts";
import { env, type CloudflareEnv } from "../../../env.ts";
import { decrypt } from "../../utils/encryption.ts";
import type { DB } from "../../db/client.ts";
import { createMachineProvider, type MachineProvider } from "../../providers/index.ts";
import { logger } from "../../tag-logger.ts";
import { DAEMON_DEFINITIONS, getDaemonsWithWebUI } from "../../daemons.ts";
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

/** Get daemon base URL for a machine */
function getDaemonBaseUrl(
  machineType: schema.MachineType,
  externalId: string,
  metadata: Record<string, unknown>,
): string {
  if (machineType === "daytona") {
    return `https://3000-${externalId}.proxy.daytona.works`;
  }
  if (machineType === "local-docker") {
    const ports = metadata.ports as Record<string, number> | undefined;
    const port = ports?.["iterate-daemon"] ?? (metadata.port as number | undefined) ?? 3000;
    return `http://localhost:${port}`;
  }
  if (machineType === "local" || machineType === "local-vanilla") {
    const host = (metadata.host as string) ?? "localhost";
    const ports = metadata.ports as Record<string, number> | undefined;
    const port = ports?.["iterate-daemon"] ?? (metadata.port as number | undefined) ?? 3000;
    return `http://${host}:${port}`;
  }
  throw new Error(`Unknown machine type: ${machineType}`);
}

// Generate a machine API key that includes the machine ID
// Format: mak_<machineId>_<randomHex>
function generateMachineApiKey(machineId: string): string {
  const array = new Uint8Array(24);
  crypto.getRandomValues(array);
  const randomHex = Array.from(array)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `mak_${machineId}_${randomHex}`;
}

// Hash a machine API key using SHA-256
async function hashMachineApiKey(apiKey: string): Promise<string> {
  const encoded = new TextEncoder().encode(apiKey);
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Parse machine ID from API key
export function parseMachineIdFromApiKey(apiKey: string): string | null {
  const match = apiKey.match(/^mak_(mach_[a-z0-9]+)_[a-f0-9]+$/);
  return match ? match[1] : null;
}

// Verify a machine API key against its hash
export async function verifyMachineApiKey(apiKey: string, hash: string): Promise<boolean> {
  const computedHash = await hashMachineApiKey(apiKey);
  return computedHash === hash;
}

// Schema for local machine metadata: host + per-daemon ports
const localMetadataSchema = z
  .object({
    host: z.string().min(1),
    ports: z.record(z.string(), z.coerce.number().int().min(1).max(65535)),
    // Legacy field - kept for backward compatibility
    port: z.coerce.number().int().min(1).max(65535).optional(),
  })
  .passthrough();

/**
 * Create a local machine (DB-only, no provider).
 * Extracted for consistency with provider-based machine types.
 */
async function createLocalMachine(
  db: DB,
  projectId: string,
  machineId: string,
  name: string,
  metadata: Record<string, unknown>,
): Promise<typeof schema.machine.$inferSelect> {
  const localMetadata = localMetadataSchema.parse(metadata);
  const [newMachine] = await db
    .insert(schema.machine)
    .values({
      id: machineId,
      name,
      type: "local",
      projectId,
      state: "started",
      metadata: localMetadata,
      externalId: machineId,
    })
    .returning();

  if (!newMachine) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Failed to create machine",
    });
  }

  return newMachine;
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

  const provider = await createMachineProvider(machine.type, cloudflareEnv);

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

      const machines = await ctx.db.query.machine.findMany({
        where: includeArchived
          ? eq(schema.machine.projectId, ctx.project.id)
          : and(eq(schema.machine.projectId, ctx.project.id), eq(schema.machine.state, "started")),
        orderBy: (m, { desc }) => [desc(m.createdAt)],
      });

      return machines;
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

      return m;
    }),

  // Create a new machine
  create: projectProtectedMutation
    .input(
      z.object({
        name: z.string().min(1).max(100),
        type: z.enum(schema.MachineType).default("daytona"),
        metadata: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const machineId = typeid("mach").toString();

      // Local machines are DB-only (no provider)
      if (input.type === "local") {
        return createLocalMachine(
          ctx.db,
          ctx.project.id,
          machineId,
          input.name,
          input.metadata ?? {},
        );
      }

      // Generate API key for machine authentication
      const machineApiKey = generateMachineApiKey(machineId);
      const apiKeyHash = await hashMachineApiKey(machineApiKey);

      // Create provider for the specified type
      const provider = await createMachineProvider(input.type, ctx.env);

      const globalEnvVars = await ctx.db.query.projectEnvVar.findMany({
        where: and(
          eq(schema.projectEnvVar.projectId, ctx.project.id),
          isNull(schema.projectEnvVar.machineId),
        ),
      });

      const envVars = Object.fromEntries(
        await Promise.all(
          globalEnvVars.map(
            async (envVar) => [envVar.key, await decrypt(envVar.encryptedValue)] as const,
          ),
        ),
      );

      // If there is no defined key, use the default one for now
      // TODO: very dangerous, remove this as soon as we have things setup
      if (!envVars["OPENAI_API_KEY"]) {
        envVars["OPENAI_API_KEY"] = env.OPENAI_API_KEY;
      }
      if (!envVars["ANTHROPIC_API_KEY"]) {
        envVars["ANTHROPIC_API_KEY"] = env.ANTHROPIC_API_KEY;
      }

      // Note: GitHub env vars are now injected via the bootstrap flow instead of at creation time
      // This allows the daemon to receive fresh GitHub tokens when it reports ready
      const result = await provider
        .create({
          machineId,
          name: input.name,
          envVars: {
            ...envVars,
            // Platform bootstrap env vars - we use the tunnel host if it is set to handle remote sandbox and local control plane use cases
            ITERATE_OS_BASE_URL: ctx.env.VITE_PUBLIC_URL,
            ITERATE_OS_API_KEY: machineApiKey,
            // In dev, use the current git branch for Daytona sandboxes
            ...(input.type === "daytona" && ctx.env.ITERATE_DEV_GIT_REF
              ? { ITERATE_GIT_REF: ctx.env.ITERATE_DEV_GIT_REF }
              : {}),
          },
        })
        .catch((err) => {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: `Failed to create machine: ${err instanceof Error ? err.message : String(err)}`,
          });
        });

      const newMachine = await ctx.db
        .transaction(async (tx) => {
          const [newMachine] = await tx
            .insert(schema.machine)
            .values({
              id: machineId,
              name: input.name,
              type: input.type,
              projectId: ctx.project.id,
              state: "started",
              metadata: { ...(input.metadata ?? {}), ...(result.metadata ?? {}) },
              externalId: result.externalId,
              apiKeyHash,
            })
            .returning();

          return newMachine;
        })
        .catch(async (err) => {
          // Cleanup: delete the created machine if DB transaction fails
          try {
            await provider.delete(result.externalId);
          } catch {
            // Ignore cleanup errors
          }
          throw err;
        });

      if (!newMachine) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create machine",
        });
      }

      return newMachine;
    }),

  // Archive a machine
  archive: projectProtectedMutation
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

      await provider.archive(machine.externalId).catch((err) => {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to archive machine: ${err instanceof Error ? err.message : String(err)}`,
        });
      });

      return updated;
    }),

  // Unarchive a machine (restore)
  unarchive: projectProtectedMutation
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

      const [updated] = await ctx.db
        .update(schema.machine)
        .set({ state: "started" })
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

      await provider.start(machine.externalId).catch((err) => {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to unarchive machine: ${err instanceof Error ? err.message : String(err)}`,
        });
      });

      return updated;
    }),

  // Restart a machine
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

      await provider.restart(machine.externalId).catch((err) => {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to restart machine: ${err instanceof Error ? err.message : String(err)}`,
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
      const { provider, machine } = await getProviderForMachine(
        ctx.db,
        ctx.project.id,
        input.machineId,
        ctx.env,
      );

      const result = await ctx.db
        .delete(schema.machine)
        .where(
          and(eq(schema.machine.id, input.machineId), eq(schema.machine.projectId, ctx.project.id)),
        )
        .returning();

      if (result.length === 0) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Machine not found",
        });
      }

      await provider.delete(machine.externalId).catch((err) => {
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

      // Build native URLs based on machine type
      const buildNativeUrl = (daemonId: string, internalPort: number) => {
        if (machineRecord.type === "daytona" && machineRecord.externalId) {
          return `https://${internalPort}-${machineRecord.externalId}.proxy.daytona.works`;
        }
        if (machineRecord.type === "local-docker") {
          // New format: use ports map
          if (metadata.ports?.[daemonId]) {
            return `http://localhost:${metadata.ports[daemonId]}`;
          }
          // Legacy fallback
          if (metadata.port) {
            const hostPort = internalPort === 3000 ? metadata.port : metadata.port + 1;
            return `http://localhost:${hostPort}`;
          }
        }
        if (machineRecord.type === "local") {
          const host = metadata.host ?? "localhost";
          // New format: use ports map
          if (metadata.ports?.[daemonId]) {
            return `http://${host}:${metadata.ports[daemonId]}`;
          }
          // Legacy fallback
          if (metadata.port) {
            return `http://${host}:${metadata.port}`;
          }
        }
        if (machineRecord.type === "local-vanilla") {
          return `http://localhost:3000`;
        }
        return null;
      };

      // Build per-daemon URLs
      const daemons = getDaemonsWithWebUI().map((daemon) => ({
        id: daemon.id,
        name: daemon.name,
        internalPort: daemon.internalPort,
        proxyUrl: buildProxyUrl(daemon.internalPort),
        nativeUrl: buildNativeUrl(daemon.id, daemon.internalPort),
      }));

      // Terminal URL
      const terminalInternalPort = 22222;
      const terminalNativeUrl = (() => {
        if (machineRecord.type === "daytona" && machineRecord.externalId) {
          return `https://${terminalInternalPort}-${machineRecord.externalId}.proxy.daytona.works`;
        }
        if (machineRecord.type === "local-docker" && metadata.ports?.["terminal"]) {
          return `http://localhost:${metadata.ports["terminal"]}`;
        }
        // Legacy local-docker fallback
        if (machineRecord.type === "local-docker" && metadata.port) {
          return `http://localhost:${metadata.port + 1}`;
        }
        return null;
      })();

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
        nativeDaemonUrl: buildNativeUrl("iterate-daemon", iterateDaemon?.internalPort ?? 3000),
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

      try {
        const daemonBaseUrl = getDaemonBaseUrl(
          machineRecord.type,
          machineRecord.externalId,
          (machineRecord.metadata as Record<string, unknown>) ?? {},
        );
        const daemonClient = createDaemonTrpcClient(daemonBaseUrl);
        const agents = await daemonClient.listAgents.query();
        return { agents };
      } catch (err) {
        logger.error("Failed to fetch agents from daemon", err);
        // Return empty list on error (daemon might not be ready)
        return { agents: [] };
      }
    }),
});

// Note: GitHub env vars (GITHUB_ACCESS_TOKEN, GITHUB_REPOS) are now injected
// via the bootstrap flow in machine-status.ts when the daemon reports ready.
