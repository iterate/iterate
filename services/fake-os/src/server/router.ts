import { ORPCError, implement } from "@orpc/server";
import { fakeOsContract } from "@iterate-com/fake-os-contract";
import { Deployment } from "@iterate-com/shared/jonasland/deployment/deployment.ts";
import { eq } from "drizzle-orm";
import * as schema from "./db/schema.ts";
import { db } from "./db/index.ts";
import { deploymentRuntimeRegistry } from "./deployments/deployment-runtime-registry.ts";
import { parseDeploymentConfig } from "./deployments/deployment-provider-factory.ts";

const os = implement(fakeOsContract).$context<{}>();

void deploymentRuntimeRegistry.ensureHydrated();

export const router = os.router({
  service: {
    health: os.service.health.handler(async () => ({
      ok: true as const,
      service: "fake-os",
      version: "0.0.1",
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

export type Router = typeof router;

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
    const locator = deployment.locator;
    updateDeploymentLocator(row.slug, locator);
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
  const locator = deployment.locator;
  updateDeploymentLocator(row.slug, locator);
}

function serializeDeployment(row: typeof schema.deploymentsTable.$inferSelect) {
  const runtime = deploymentRuntimeRegistry.get(row.slug)?.snapshot() ?? null;
  return {
    ...row,
    runtime: runtime
      ? {
          state: toContractRuntimeState(runtime.state),
          baseUrl: runtime.baseUrl,
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

  // The deployment object is the runtime source of truth; sqlite only tells us
  // how to reconnect if the process restarts.
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
