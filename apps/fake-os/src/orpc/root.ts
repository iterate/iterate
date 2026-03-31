import { ORPCError } from "@orpc/server";
import { createCommonRouter } from "@iterate-com/shared/apps/common-router";
import { Deployment } from "@iterate-com/shared/jonasland/deployment/deployment.ts";
import {
  createDockerProvider,
  resolveDockerLocator,
} from "@iterate-com/shared/jonasland/deployment/docker-deployment.ts";
import {
  createFlyProvider,
  flyProviderOptsSchema,
} from "@iterate-com/shared/jonasland/deployment/fly-deployment.ts";
import { eq } from "drizzle-orm";
import { z } from "zod";
import manifest, { AppConfig } from "~/app.ts";
import * as schema from "~/db/schema.ts";
import { db } from "~/db/index.ts";
import { os } from "~/orpc/orpc.ts";
import {
  parseDeploymentLocator,
  type AnyDeploymentLocator,
  parseDeploymentConfig,
} from "~/deployments/deployment-provider-factory.ts";
import { deploymentRuntimeRegistry } from "~/deployments/deployment-runtime-registry.ts";

export const appRouter = os.router({
  common: os.common.router(
    createCommonRouter({
      appConfigSchema: AppConfig,
    }),
  ),

  service: {
    health: os.service.health.handler(async () => ({
      ok: true as const,
      service: manifest.slug,
      version: manifest.version ?? "0.0.0",
    })),
    sql: os.service.sql.handler(async () => {
      throw new ORPCError("NOT_IMPLEMENTED", { message: "sql not supported" });
    }),
    debug: os.service.debug.handler(async () => ({
      pid: process.pid,
      ppid: process.ppid,
      uptimeSec: process.uptime(),
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      hostname: "",
      cwd: process.cwd(),
      execPath: process.execPath,
      argv: process.argv,
      env: {},
      memoryUsage: process.memoryUsage(),
    })),
  },

  deployments: {
    list: os.deployments.list.handler(async () => {
      await deploymentRuntimeRegistry.ensureHydrated();
      return db.select().from(schema.deploymentsTable).all().map(serializeDeployment);
    }),

    get: os.deployments.get.handler(async ({ input }) => {
      await deploymentRuntimeRegistry.ensureHydrated();
      const deployment = db
        .select()
        .from(schema.deploymentsTable)
        .where(eq(schema.deploymentsTable.slug, input.slug))
        .get();

      if (!deployment) {
        throw new ORPCError("NOT_FOUND", { message: "Deployment not found" });
      }

      return serializeDeployment(deployment);
    }),

    create: os.deployments.create.handler(async ({ input }) => {
      try {
        parseDeploymentConfig({ provider: input.provider, opts: input.opts });
      } catch (error) {
        throw toOrpcBadRequest(error);
      }

      const created = db
        .insert(schema.deploymentsTable)
        .values({ provider: input.provider, slug: input.slug, opts: input.opts })
        .returning()
        .get();

      try {
        await createRuntimeForRow(created);

        return serializeDeployment(
          db
            .select()
            .from(schema.deploymentsTable)
            .where(eq(schema.deploymentsTable.slug, created.slug))
            .get()!,
        );
      } catch (error) {
        db.delete(schema.deploymentsTable)
          .where(eq(schema.deploymentsTable.slug, created.slug))
          .run();
        deploymentRuntimeRegistry.delete(created.slug);
        throw toOrpcBadRequest(error);
      }
    }),

    recover: os.deployments.recover.handler(async ({ input }) => {
      try {
        const recovered = await recoverExistingDeployment(input);
        const saved = saveRecoveredDeploymentRow(recovered);
        deploymentRuntimeRegistry.set({
          slug: recovered.slug,
          deployment: recovered.deployment,
        });
        return serializeDeployment(saved);
      } catch (error) {
        throw toOrpcBadRequest(error);
      }
    }),

    logs: os.deployments.logs.handler(async function* ({ input, signal }) {
      const deployment = await requireDeploymentRuntime(input.slug);

      for await (const entry of deployment.logs({ signal })) {
        yield entry;
      }
    }),

    pidnap: {
      status: os.deployments.pidnap.status.handler(async ({ input }) => {
        const deployment = await requireDeploymentRuntime(input.slug);
        return await deployment.pidnap.manager.status();
      }),

      processes: os.deployments.pidnap.processes.handler(async ({ input }) => {
        const deployment = await requireDeploymentRuntime(input.slug);
        return await deployment.pidnap.processes.list();
      }),

      restart: os.deployments.pidnap.restart.handler(async ({ input }) => {
        const deployment = await requireDeploymentRuntime(input.slug);
        return await deployment.pidnap.processes.restart({ target: input.processSlug });
      }),

      logs: os.deployments.pidnap.logs.handler(async function* ({ input, signal }) {
        const deployment = await requireDeploymentRuntime(input.slug);
        const stream = await deployment.pidnap.processes.logs(
          { processSlug: input.processSlug },
          { signal },
        );

        for await (const entry of stream) {
          yield entry;
        }
      }),
    },

    services: {
      list: os.deployments.services.list.handler(async ({ input }) => {
        const deployment = await requireDeploymentRuntime(input.slug);
        const { routes } = await deployment.registryService.routes.list({});
        return routes.map(serializeServiceRegistration);
      }),
    },

    delete: os.deployments.delete.handler(async ({ input }) => {
      const deployment = db
        .select()
        .from(schema.deploymentsTable)
        .where(eq(schema.deploymentsTable.slug, input.slug))
        .get();

      if (!deployment) {
        throw new ORPCError("NOT_FOUND", { message: "Deployment not found" });
      }

      const runtime = await deploymentRuntimeRegistry.hydrateFromRow(deployment);
      if (!runtime) {
        throw new ORPCError("FAILED_PRECONDITION", {
          message: "Deployment runtime is not connected",
        });
      }

      await runtime.destroy();
      deploymentRuntimeRegistry.delete(deployment.slug);
      db.delete(schema.deploymentsTable).where(eq(schema.deploymentsTable.slug, input.slug)).run();
      return { ok: true as const };
    }),
  },
});

export type Router = typeof appRouter;

type RecoverDeploymentInput = z.infer<typeof schema.recoverDeploymentSchema>;

type RecoveredDeploymentRecord = {
  provider: "docker" | "fly";
  slug: string;
  deployment: Deployment;
  opts: unknown;
  deploymentLocator: AnyDeploymentLocator;
};

function updateDeploymentLocator(slug: string, locator: unknown) {
  return db
    .update(schema.deploymentsTable)
    .set({ deploymentLocator: locator })
    .where(eq(schema.deploymentsTable.slug, slug))
    .returning()
    .get();
}

async function createRuntimeForRow(row: typeof schema.deploymentsTable.$inferSelect) {
  if (row.provider === "docker") {
    const config = parseDeploymentConfig({ provider: "docker", opts: row.opts });
    const deployment = await Deployment.create({
      provider: config.provider,
      opts: {
        ...config.opts,
        slug: row.slug,
      },
    });
    deploymentRuntimeRegistry.set({ slug: row.slug, deployment });
    updateDeploymentLocator(row.slug, deployment.locator);
    return;
  }

  const config = parseDeploymentConfig({ provider: "fly", opts: row.opts });
  const deployment = await Deployment.create({
    provider: config.provider,
    opts: {
      ...config.opts,
      slug: row.slug,
    },
  });
  deploymentRuntimeRegistry.set({ slug: row.slug, deployment });
  updateDeploymentLocator(row.slug, deployment.locator);
}

async function recoverExistingDeployment(
  input: RecoverDeploymentInput,
): Promise<RecoveredDeploymentRecord> {
  if (input.provider === "docker") {
    const provider = createDockerProvider();
    const locator = await resolveDockerLocator({ reference: input.reference });
    await ensureRecoveredRuntimeIsConnectable({ provider, locator });
    const deployment = await Deployment.connect({ provider, locator });

    return {
      provider: "docker",
      slug: deployment.slug,
      deployment,
      opts: {
        providerOpts: {},
        opts: omitDeploymentSlug(deployment.opts),
      },
      deploymentLocator: parseDeploymentLocator({
        provider: "docker",
        locator: deployment.locator,
      }),
    };
  }

  const providerOpts = flyProviderOptsSchema.parse(input.providerOpts);
  const provider = createFlyProvider(providerOpts);
  const locator = parseDeploymentLocator({
    provider: "fly",
    locator: {
      provider: "fly",
      appName: input.appName,
      ...(input.machineId ? { machineId: input.machineId } : {}),
    },
  });
  await ensureRecoveredRuntimeIsConnectable({ provider, locator });
  const deployment = await Deployment.connect({ provider, locator });

  return {
    provider: "fly",
    slug: deployment.slug,
    deployment,
    opts: {
      providerOpts,
      opts: omitDeploymentSlug(deployment.opts),
    },
    deploymentLocator: parseDeploymentLocator({
      provider: "fly",
      locator: deployment.locator,
    }),
  };
}

async function ensureRecoveredRuntimeIsConnectable(params: {
  provider: {
    status(args: { signal?: AbortSignal; locator: AnyDeploymentLocator }): Promise<{
      state: "unknown" | "running" | "starting" | "stopped" | "destroyed" | "error";
      detail: string;
    }>;
    start(args: { signal?: AbortSignal; locator: AnyDeploymentLocator }): Promise<void>;
  };
  locator: AnyDeploymentLocator;
}) {
  const status = await params.provider.status({ locator: params.locator });

  if (status.state === "destroyed") {
    throw new Error(`Cannot recover destroyed deployment: ${status.detail}`);
  }

  if (status.state === "error") {
    throw new Error(`Cannot recover deployment in error state: ${status.detail}`);
  }

  if (status.state === "stopped") {
    await params.provider.start({ locator: params.locator });
  }
}

function saveRecoveredDeploymentRow(params: RecoveredDeploymentRecord) {
  const existing = db
    .select()
    .from(schema.deploymentsTable)
    .where(eq(schema.deploymentsTable.slug, params.slug))
    .get();

  if (!existing) {
    return db
      .insert(schema.deploymentsTable)
      .values({
        provider: params.provider,
        slug: params.slug,
        opts: params.opts,
        deploymentLocator: params.deploymentLocator,
      })
      .returning()
      .get();
  }

  if (!isSameRecoveredRuntime(existing, params)) {
    throw new Error(
      `Deployment slug ${JSON.stringify(params.slug)} already exists in fake-os for a different runtime`,
    );
  }

  return db
    .update(schema.deploymentsTable)
    .set({
      provider: params.provider,
      opts: params.opts,
      deploymentLocator: params.deploymentLocator,
    })
    .where(eq(schema.deploymentsTable.slug, params.slug))
    .returning()
    .get();
}

function serializeDeployment(row: typeof schema.deploymentsTable.$inferSelect) {
  const runtime = deploymentRuntimeRegistry.get(row.slug)?.snapshot() ?? null;

  return {
    ...row,
    runtime: runtime
      ? {
          state: toContractRuntimeState(runtime.state),
          providerStatus: runtime.providerStatus,
        }
      : null,
  };
}

function serializeServiceRegistration(route: {
  host: string;
  target: string;
  metadata: Record<string, string>;
  tags: string[];
  updatedAt: string;
}) {
  const [targetHost, targetPortRaw] = route.target.split(":");
  const parsedTargetPort = targetPortRaw ? Number(targetPortRaw) : Number.NaN;

  return {
    host: route.host,
    target: route.target,
    targetHost: targetHost ?? route.target,
    targetPort: Number.isFinite(parsedTargetPort) ? parsedTargetPort : null,
    metadata: route.metadata,
    tags: route.tags,
    updatedAt: route.updatedAt,
  };
}

async function requireDeploymentRuntime(slug: string) {
  const row = db
    .select()
    .from(schema.deploymentsTable)
    .where(eq(schema.deploymentsTable.slug, slug))
    .get();

  if (!row) {
    throw new ORPCError("NOT_FOUND", { message: "Deployment not found" });
  }

  const deployment = await deploymentRuntimeRegistry.hydrateFromRow(row);
  if (!deployment) {
    throw new ORPCError("FAILED_PRECONDITION", {
      message: "Deployment runtime is not connected",
    });
  }

  return deployment;
}

export function toContractRuntimeState(
  state: "new" | "connecting" | "connected" | "destroying" | "destroyed" | "disconnected",
) {
  if (state === "new") return "pending" as const;
  return state;
}

function toOrpcBadRequest(error: unknown) {
  return new ORPCError("BAD_REQUEST", {
    message: error instanceof Error ? error.message : String(error),
  });
}

function isSameRecoveredRuntime(
  row: typeof schema.deploymentsTable.$inferSelect,
  recovered: RecoveredDeploymentRecord,
) {
  if (row.provider !== recovered.provider) {
    return false;
  }

  if (!row.deploymentLocator) {
    return true;
  }

  if (recovered.provider === "docker") {
    const current = parseDeploymentLocator({
      provider: "docker",
      locator: row.deploymentLocator,
    });
    const next = parseDeploymentLocator({
      provider: "docker",
      locator: recovered.deploymentLocator,
    });

    return (
      current.containerId === next.containerId ||
      (Boolean(current.containerName) &&
        Boolean(next.containerName) &&
        current.containerName === next.containerName)
    );
  }

  const current = parseDeploymentLocator({
    provider: "fly",
    locator: row.deploymentLocator,
  });
  const next = parseDeploymentLocator({
    provider: "fly",
    locator: recovered.deploymentLocator,
  });

  return current.appName === next.appName;
}

function omitDeploymentSlug<TValue extends { slug: string }>(value: TValue): Omit<TValue, "slug"> {
  const { slug: _slug, ...rest } = value;
  return rest;
}
