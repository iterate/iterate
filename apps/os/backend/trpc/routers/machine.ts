import { z } from "zod/v4";
import { eq, and, isNull } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { typeid } from "typeid-js";
import { router, projectProtectedProcedure, projectProtectedMutation } from "../trpc.ts";
import * as schema from "../../db/schema.ts";
import { env, type CloudflareEnv } from "../../../env.ts";
import { decrypt } from "../../utils/encryption.ts";
import type { DB } from "../../db/client.ts";
import { getGitHubInstallationToken, getRepositoryById } from "../../integrations/github/github.ts";
import { createMachineProvider, type MachineProvider } from "../../providers/index.ts";
import { dockerApi } from "../../providers/local-docker.ts";

interface DockerContainer {
  Ports?: Array<{ PublicPort?: number }>;
}

// Helper to find an available port for local-docker machines by querying Docker directly
async function findAvailablePort(): Promise<number> {
  const containers = await dockerApi<DockerContainer[]>("GET", "/containers/json?all=true");

  const usedPorts = new Set<number>();
  for (const container of containers) {
    for (const port of container.Ports ?? []) {
      if (port.PublicPort) {
        usedPorts.add(port.PublicPort);
      }
    }
  }

  for (let port = 10000; port <= 11000; port++) {
    if (!usedPorts.has(port)) return port;
  }
  throw new Error("No available ports in range 10000-11000");
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

  const provider = createMachineProvider(machine.type, cloudflareEnv, {
    findAvailablePort,
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

      // Create provider for the specified type
      const provider = createMachineProvider(input.type, ctx.env, {
        findAvailablePort,
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

      // If there is no defined key, use the default one for now
      // TODO: very dangerous, remove this as soon as we have things setup
      if (!envVars["OPENAI_API_KEY"]) {
        envVars["OPENAI_API_KEY"] = env.OPENAI_API_KEY;
      }

      const githubEnvVars = await getGitHubEnvVars(ctx.db, ctx.project.id, ctx.env);

      const result = await provider
        .create({
          machineId,
          name: input.name,
          envVars: {
            ...envVars,
            ...githubEnvVars,
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

      const metadata = machineRecord.metadata as { containerId?: string; port?: number };

      // Build native URLs based on machine type
      const buildNativeUrl = (port: number) => {
        if (machineRecord.type === "daytona" && machineRecord.externalId) {
          return `https://${port}-${machineRecord.externalId}.proxy.daytona.works`;
        }
        if (machineRecord.type === "local-docker" && metadata.port) {
          // For local-docker, map internal port to host port offset
          // Internal 3000 -> host metadata.port, internal 22222 -> metadata.port + 1
          const hostPort = port === 3000 ? metadata.port : metadata.port + 1;
          return `http://localhost:${hostPort}`;
        }
        return null;
      };

      return {
        url: buildProxyUrl(3000),
        daemonUrl: buildProxyUrl(3000),
        terminalUrl: buildProxyUrl(22222),
        // Native URLs (bypassing our proxy)
        nativeDaemonUrl: buildNativeUrl(3000),
        nativeTerminalUrl: machineRecord.type === "daytona" ? buildNativeUrl(22222) : null,
        machineType: machineRecord.type,
        containerId: metadata.containerId,
        hostPort: metadata.port,
      };
    }),
});

async function getGitHubEnvVars(
  db: DB,
  projectId: string,
  cloudflareEnv: CloudflareEnv,
): Promise<Record<string, string>> {
  const githubConnection = await db.query.projectConnection.findFirst({
    where: and(
      eq(schema.projectConnection.projectId, projectId),
      eq(schema.projectConnection.provider, "github-app"),
    ),
  });

  if (!githubConnection) {
    return {};
  }

  const providerData = githubConnection.providerData as {
    installationId?: number;
  };

  if (!providerData.installationId) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "GitHub connection exists but has no installation ID",
    });
  }

  const projectRepos = await db.query.projectRepo.findMany({
    where: eq(schema.projectRepo.projectId, projectId),
  });

  if (projectRepos.length === 0) {
    return {};
  }

  const installationToken = await getGitHubInstallationToken(
    cloudflareEnv,
    providerData.installationId,
  );

  if (!installationToken) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Failed to get GitHub installation token",
    });
  }

  const repos = await Promise.all(
    projectRepos.map(async (repo) => {
      const repoInfo = await getRepositoryById(installationToken, repo.externalId);
      if (!repoInfo) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to fetch repository ${repo.owner}/${repo.name} from GitHub - it may have been deleted`,
        });
      }
      return {
        owner: repoInfo.owner,
        name: repoInfo.name,
        defaultBranch: repoInfo.defaultBranch,
      };
    }),
  );

  return {
    GITHUB_ACCESS_TOKEN: installationToken,
    GITHUB_REPOS: JSON.stringify(repos),
  };
}
