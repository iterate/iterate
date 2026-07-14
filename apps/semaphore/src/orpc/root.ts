import { ORPCError } from "@orpc/server";
import { env } from "cloudflare:workers";
import { getPublicConfig } from "@iterate-com/shared/config";
import { z } from "zod";
import packageJson from "../../package.json" with { type: "json" };
import { AppConfig } from "~/config.ts";
import {
  deleteResourceFromDb,
  findResourceByKey,
  hasInventoryForType,
  insertResource,
  listResourcesFromDb,
  ResourceInputError,
} from "~/lib/resource-store.ts";
import { semaphore } from "~/orpc/orpc.ts";

// Semaphore is behind the same apps/auth relying-party auth as os: the
// request middleware (src/start.ts) resolves the caller from the iterate
// session cookie or a bearer access token, and everything here requires an
// iterate admin identity. Fails closed when iterateAuth is unconfigured.
const requireAuth = semaphore.middleware(async ({ context, next }) => {
  if (!context.principal?.isAdmin) {
    throw new ORPCError("UNAUTHORIZED", {
      message:
        "Authenticate with an iterate admin identity: sign in through /api/iterate-auth/login, or send an admin access token as `Authorization: Bearer <token>`.",
    });
  }

  return next();
});

/**
 * Converts storage and coordinator failures into meaningful HTTP errors.
 * Applied to every `resources.*` procedure; `__internal.*` stays bare.
 */
const mapResourceErrors = semaphore.middleware(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    mapResourceError(error);
  }
});

// Zod errors thrown inside the ResourceCoordinator durable object cross a
// workerd JS RPC boundary that rebuilds them as plain `Error`s, so check for
// the `issues` array structurally instead of relying on `instanceof z.ZodError`.
function isZodErrorLike(error: unknown): error is { issues: Array<{ message?: string }> } {
  if (!(error instanceof z.ZodError) && !(error instanceof Error)) {
    return false;
  }

  if (!("issues" in error)) {
    return false;
  }

  return Array.isArray(error.issues);
}

function mapResourceError(error: unknown): never {
  if (error instanceof ORPCError) {
    throw error;
  }

  if (error instanceof ResourceInputError) {
    throw new ORPCError("BAD_REQUEST", { message: error.message });
  }

  if (isZodErrorLike(error)) {
    throw new ORPCError("BAD_REQUEST", {
      message: error.issues[0]?.message ?? "Invalid request input.",
    });
  }

  if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) {
    throw new ORPCError("CONFLICT", {
      message: "Resource already exists for this type and slug.",
    });
  }

  throw error;
}

function getCoordinator(type: string) {
  return env.RESOURCE_COORDINATOR.getByName(type);
}

async function withAuthoritativeLeaseState<
  T extends {
    type: string;
    slug: string;
    leaseState: "available" | "leased";
    leasedUntil: number | null;
    holder: string | null;
  },
>(resource: T): Promise<T> {
  const lease = await getCoordinator(resource.type).getLease({
    type: resource.type,
    slug: resource.slug,
  });
  return {
    ...resource,
    leaseState: lease ? "leased" : "available",
    leasedUntil: lease?.expiresAt ?? null,
    holder: lease?.holder ?? null,
  };
}

const addResourceProcedure = semaphore.resources.add
  .use(requireAuth)
  .use(mapResourceErrors)
  .handler(async ({ input }) => {
    const { type, slug, data } = input;
    const coordinator = getCoordinator(type);
    const hasActiveLease = await coordinator.hasActiveLease({ type, slug });
    if (hasActiveLease) {
      throw new ORPCError("CONFLICT", {
        message: "Cannot add a resource while an older lease is still active for this slug.",
      });
    }

    const created = await insertResource(env.DB, { type, slug, data });
    await coordinator.inventoryChanged({ type });
    return created;
  });

const deleteResourceProcedure = semaphore.resources.delete
  .use(requireAuth)
  .use(mapResourceErrors)
  .handler(async ({ input }) => {
    const { type, slug } = input;
    const deleted = await deleteResourceFromDb(env.DB, { type, slug });
    return { deleted };
  });

const listResourcesProcedure = semaphore.resources.list
  .use(requireAuth)
  .use(mapResourceErrors)
  .handler(async ({ input }) => {
    const resources = await listResourcesFromDb(env.DB, { type: input.type });
    return await Promise.all(resources.map(withAuthoritativeLeaseState));
  });

const findResourceProcedure = semaphore.resources.find
  .use(requireAuth)
  .use(mapResourceErrors)
  .handler(async ({ input }) => {
    const resource = await findResourceByKey(env.DB, input);
    if (!resource) {
      throw new ORPCError("NOT_FOUND", {
        message: `No resource exists for ${input.type}/${input.slug}.`,
      });
    }

    return await withAuthoritativeLeaseState(resource);
  });

const acquireResourceProcedure = semaphore.resources.acquire
  .use(requireAuth)
  .use(mapResourceErrors)
  .handler(async ({ input }) => {
    const { type, leaseMs, waitMs = 0, holder } = input;
    const hasInventory = await hasInventoryForType(env.DB, type);
    if (!hasInventory) {
      throw new ORPCError("NOT_FOUND", {
        message: "No resources are configured for this type.",
      });
    }

    const lease = await getCoordinator(type).acquire({ type, leaseMs, waitMs, holder });
    if (!lease) {
      throw new ORPCError("CONFLICT", {
        message:
          waitMs > 0
            ? "No resource became available before waitMs elapsed."
            : "No resource is currently available for this type.",
      });
    }

    return lease;
  });

const acquireResourceExclusiveProcedure = semaphore.resources.acquireExclusive
  .use(requireAuth)
  .use(mapResourceErrors)
  .handler(async ({ input }) => {
    const { type, holder, leaseMs, waitMs = 0 } = input;
    const hasInventory = await hasInventoryForType(env.DB, type);
    if (!hasInventory) {
      throw new ORPCError("NOT_FOUND", {
        message: "No resources are configured for this type.",
      });
    }

    const result = await getCoordinator(type).acquireExclusive({
      type,
      holder,
      leaseMs,
      waitMs,
    });
    if (result.status === "acquired") {
      return result.lease;
    }

    if (result.status === "unavailable") {
      throw new ORPCError("CONFLICT", {
        message:
          waitMs > 0
            ? "No resource became available before waitMs elapsed."
            : "No resource is currently available for this type.",
      });
    }

    throw new ORPCError("CONFLICT", {
      message:
        "The holder already has an active lease. Continue it with the exact slug and leaseId capability, or wait for it to be released or expire.",
    });
  });

const acquireSpecificResourceProcedure = semaphore.resources.acquireSpecific
  .use(requireAuth)
  .use(mapResourceErrors)
  .handler(async ({ input }) => {
    const { type, slug, leaseMs, holder, force } = input;
    const hasInventory = await hasInventoryForType(env.DB, type);
    if (!hasInventory) {
      throw new ORPCError("NOT_FOUND", {
        message: "No resources are configured for this type.",
      });
    }

    return await getCoordinator(type).acquireSpecific({ type, slug, leaseMs, holder, force });
  });

const renewResourceLeaseProcedure = semaphore.resources.renew
  .use(requireAuth)
  .use(mapResourceErrors)
  .handler(async ({ input }) => {
    const { type, slug, leaseId, leaseMs } = input;
    return await getCoordinator(type).renew({ type, slug, leaseId, leaseMs });
  });

const markResourceLeaseReadyProcedure = semaphore.resources.markReady
  .use(requireAuth)
  .use(mapResourceErrors)
  .handler(async ({ input }) => {
    const { type, slug, leaseId } = input;
    return await getCoordinator(type).markReady({ type, slug, leaseId });
  });

const releaseResourceProcedure = semaphore.resources.release
  .use(requireAuth)
  .use(mapResourceErrors)
  .handler(async ({ input }) => {
    const { type, slug, leaseId, force } = input;
    const released = await getCoordinator(type).release({ type, slug, leaseId, force });
    return { released };
  });

/**
 * The `__internal.*` subtree (served at `/api/__internal/*`) is the operator
 * namespace for deployment probes and browser public-config bootstrap.
 */
const internalRouter = semaphore.__internal.router({
  health: semaphore.__internal.health.handler(() => ({
    ok: true as const,
    app: "semaphore",
    version: packageJson.version,
  })),
  // Strips `redacted(...)` fields, exposing only `publicValue(...)` ones — this
  // is what the browser boots from in routes/__root.tsx.
  publicConfig: semaphore.__internal.publicConfig.handler(({ context }) =>
    getPublicConfig(context.config, AppConfig),
  ),
  // UNAUTHENTICATED route — never return secrets here (see the os incident).
  debug: semaphore.__internal.debug.handler(() => ({ runtime: "workerd" })),
  refreshRegistry: semaphore.__internal.refreshRegistry.handler(() => {
    throw new ORPCError("NOT_IMPLEMENTED", {
      message: "__internal.refreshRegistry is not implemented for semaphore",
    });
  }),
});

export const appRouter = semaphore.router({
  __internal: internalRouter,
  resources: semaphore.resources.router({
    add: addResourceProcedure,
    delete: deleteResourceProcedure,
    list: listResourcesProcedure,
    find: findResourceProcedure,
    acquire: acquireResourceProcedure,
    acquireExclusive: acquireResourceExclusiveProcedure,
    acquireSpecific: acquireSpecificResourceProcedure,
    renew: renewResourceLeaseProcedure,
    markReady: markResourceLeaseReadyProcedure,
    release: releaseResourceProcedure,
  }),
});
