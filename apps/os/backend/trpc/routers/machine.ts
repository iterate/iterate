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
import { decrypt, encrypt } from "../../utils/encryption.ts";
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

/** Service URL options for a daemon */
interface ServiceOption {
  label: string;
  url: string;
}

/** Enrich a machine with display info and commands from its provider */
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
    displayInfo: provider.displayInfo,
    commands: provider.commands,
    terminalOptions: provider.terminalOptions,
    services,
  };
}

// Generate a project access token API key
// Format: pak_<tokenId>_<randomHex>
export function generateProjectAccessKey(tokenId: string): string {
  const array = new Uint8Array(24);
  crypto.getRandomValues(array);
  const randomHex = Array.from(array)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `pak_${tokenId}_${randomHex}`;
}

// Hash an API key using SHA-256
export async function hashApiKey(apiKey: string): Promise<string> {
  const encoded = new TextEncoder().encode(apiKey);
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Parse token ID from API key
export function parseTokenIdFromApiKey(apiKey: string): string | null {
  const match = apiKey.match(/^pak_(pat_[a-z0-9]+)_[a-f0-9]+$/);
  return match ? match[1] : null;
}

// Verify an API key against its hash (kept for backward compatibility during migration)
export async function verifyApiKey(apiKey: string, hash: string): Promise<boolean> {
  const computedHash = await hashApiKey(apiKey);
  return computedHash === hash;
}

/**
 * Get or create the project-level access token for machines.
 * Returns the token ID and decrypted API key.
 * If a token doesn't exist, creates one.
 */
async function getOrCreateProjectMachineToken(
  db: DB,
  projectId: string,
): Promise<{ tokenId: string; apiKey: string }> {
  // Look for an existing non-revoked token for the project
  const existingToken = await db.query.projectAccessToken.findFirst({
    where: and(
      eq(schema.projectAccessToken.projectId, projectId),
      isNull(schema.projectAccessToken.revokedAt),
    ),
    orderBy: (token, { asc }) => [asc(token.createdAt)], // Get oldest (first created) token
  });

  if (existingToken) {
    // Decrypt and return the existing token
    const apiKey = await decrypt(existingToken.encryptedToken);
    return { tokenId: existingToken.id, apiKey };
  }

  // No existing token - create a new one
  const tokenId = typeid("pat").toString();
  const apiKey = generateProjectAccessKey(tokenId);
  const encryptedToken = await encrypt(apiKey);

  await db.insert(schema.projectAccessToken).values({
    id: tokenId,
    projectId,
    name: "Machine Access Token",
    encryptedToken,
  });

  return { tokenId, apiKey };
}

// Archive all started machines in a project (both DB and provider)
async function archiveExistingMachines(
  db: DB,
  projectId: string,
  cloudflareEnv: CloudflareEnv,
): Promise<void> {
  // Find all started machines
  const startedMachines = await db.query.machine.findMany({
    where: and(eq(schema.machine.projectId, projectId), eq(schema.machine.state, "started")),
  });

  // Archive each one via provider then DB
  for (const machine of startedMachines) {
    // todo: flip and outboxify this
    const provider = await createMachineProvider({
      type: machine.type,
      env: cloudflareEnv,
      externalId: machine.externalId,
      metadata: (machine.metadata as Record<string, unknown>) ?? {},
      buildProxyUrl: () => "", // Not used for lifecycle operations
    });
    await provider.archive();
    await db
      .update(schema.machine)
      .set({ state: "archived" })
      .where(eq(schema.machine.id, machine.id));
  }
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

      const machines = await ctx.db.query.machine.findMany({
        where: includeArchived
          ? eq(schema.machine.projectId, ctx.project.id)
          : and(eq(schema.machine.projectId, ctx.project.id), eq(schema.machine.state, "started")),
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
      const machineId = typeid("mach").toString();

      // Get or create the project-level access token (shared by all machines)
      const { apiKey } = await getOrCreateProjectMachineToken(ctx.db, ctx.project.id);

      // Create provider for creation - externalId not known yet, will use result
      const provider = await createMachineProvider({
        type: input.type,
        env: ctx.env,
        externalId: "", // Not known until create() returns
        metadata: input.metadata ?? {},
        buildProxyUrl: () => "", // Not used during creation
      });

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

      // If there is no defined key, use the default one for now (only if defined)
      // TODO: very dangerous, remove this as soon as we have things setup
      if (!envVars["OPENAI_API_KEY"] && env.OPENAI_API_KEY) {
        envVars["OPENAI_API_KEY"] = env.OPENAI_API_KEY;
      }
      if (!envVars["ANTHROPIC_API_KEY"] && env.ANTHROPIC_API_KEY) {
        envVars["ANTHROPIC_API_KEY"] = env.ANTHROPIC_API_KEY;
      }

      // Archive any existing started machines before creating a new one
      await archiveExistingMachines(ctx.db, ctx.project.id, ctx.env);

      // Note: GitHub env vars are now injected via the bootstrap flow instead of at creation time
      // This allows the daemon to receive fresh GitHub tokens when it reports ready
      const providerResult = await provider
        .create({
          machineId,
          name: input.name,
          envVars: {
            ...envVars,
            // Platform bootstrap env vars - we use the tunnel host if it is set to handle remote sandbox and local control plane use cases
            ITERATE_OS_BASE_URL: ctx.env.VITE_PUBLIC_URL,
            ITERATE_OS_API_KEY: apiKey,
            ITERATE_MACHINE_ID: machineId,
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

      // Create machine in DB
      const [newMachine] = await ctx.db
        .insert(schema.machine)
        .values({
          id: machineId,
          name: input.name,
          type: input.type,
          projectId: ctx.project.id,
          state: "started",
          metadata: { ...(input.metadata ?? {}), ...(providerResult.metadata ?? {}) },
          externalId: providerResult.externalId,
        })
        .returning()
        .catch(async (err) => {
          // Cleanup: delete the provider resource if DB insert fails
          // Need a new provider instance with the actual externalId for cleanup
          try {
            const cleanupProvider = await createMachineProvider({
              type: input.type,
              env: ctx.env,
              externalId: providerResult.externalId,
              metadata: providerResult.metadata ?? {},
              buildProxyUrl: () => "",
            });
            await cleanupProvider.delete();
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

      // Return apiKey for local machines - user needs this to configure their daemon
      if (input.type === "local" || input.type === "local-vanilla") {
        return { ...newMachine, apiKey };
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

      await provider.restart().catch((err) => {
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

      try {
        const provider = await createMachineProvider({
          type: machineRecord.type,
          env: ctx.env,
          externalId: machineRecord.externalId,
          metadata: (machineRecord.metadata as Record<string, unknown>) ?? {},
          buildProxyUrl: () => "", // Not used here
        });
        const daemonClient = createDaemonTrpcClient(provider.previewUrl);
        const agents = await daemonClient.listAgents.query();
        return { agents };
      } catch (err) {
        logger.error("Failed to fetch agents from daemon", err);
        // Return empty list on error (daemon might not be ready)
        return { agents: [] };
      }
    }),
});
