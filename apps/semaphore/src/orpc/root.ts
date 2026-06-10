import { ORPCError } from "@orpc/server";
import { env } from "cloudflare:workers";
import { getPublicConfig } from "@iterate-com/shared/config";
import { parseRouter, type AnyRouter } from "trpc-cli";
import { z } from "zod";
import packageJson from "../../package.json" with { type: "json" };
import { AppConfig } from "~/config.ts";
import type { RequestContext } from "~/request-context.ts";
import {
  deleteResourceFromDb,
  findResourceByKey,
  hasInventoryForType,
  insertResource,
  listResourcesFromDb,
  ResourceInputError,
} from "~/lib/resource-store.ts";
import { semaphore } from "~/orpc/orpc.ts";

function readBearerToken(headerValue: string | null): string | null {
  if (!headerValue) return null;
  const match = /^bearer\s+(.+)$/i.exec(headerValue);
  if (!match) return null;
  const token = match[1]?.trim() ?? "";
  return token.length > 0 ? token : null;
}

function hasValidBearerToken(context: RequestContext): boolean {
  const expectedToken = context.config.sharedApiSecret.exposeSecret();
  const providedToken = readBearerToken(context.rawRequest?.headers.get("authorization") ?? null);
  return Boolean(providedToken && providedToken === expectedToken);
}

const authProcedure = semaphore.middleware(async ({ context, next }) => {
  if (!hasValidBearerToken(context)) {
    throw new ORPCError("UNAUTHORIZED", {
      message: "Missing or invalid Authorization header",
    });
  }

  return next();
});

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

const addResourceProcedure = semaphore.resources.add
  .use(authProcedure)
  .handler(async ({ input }) => {
    try {
      const { type, slug, data } = input;
      const coordinator = getCoordinator(type);
      const hasActiveLease = await coordinator.hasActiveLease({ type, slug });
      if (hasActiveLease) {
        throw new ORPCError("CONFLICT", {
          message: "Cannot add a resource while an older lease is still active for this slug.",
        });
      }

      const created = await insertResource(env.DB, {
        type,
        slug,
        data,
      });
      await coordinator.inventoryChanged({ type });
      return created;
    } catch (error) {
      return mapResourceError(error);
    }
  });

const deleteResourceProcedure = semaphore.resources.delete
  .use(authProcedure)
  .handler(async ({ input }) => {
    try {
      const { type, slug } = input;
      const deleted = await deleteResourceFromDb(env.DB, { type, slug });
      return { deleted };
    } catch (error) {
      return mapResourceError(error);
    }
  });

const listResourcesProcedure = semaphore.resources.list
  .use(authProcedure)
  .handler(async ({ input }) => {
    try {
      return await listResourcesFromDb(env.DB, { type: input.type });
    } catch (error) {
      return mapResourceError(error);
    }
  });

const findResourceProcedure = semaphore.resources.find
  .use(authProcedure)
  .handler(async ({ input }) => {
    try {
      const resource = await findResourceByKey(env.DB, input);
      if (!resource) {
        throw new ORPCError("NOT_FOUND", {
          message: `No resource exists for ${input.type}/${input.slug}.`,
        });
      }

      return resource;
    } catch (error) {
      return mapResourceError(error);
    }
  });

const acquireResourceProcedure = semaphore.resources.acquire
  .use(authProcedure)
  .handler(async ({ input }) => {
    try {
      const { type, leaseMs, waitMs = 0 } = input;
      const hasInventory = await hasInventoryForType(env.DB, type);
      if (!hasInventory) {
        throw new ORPCError("NOT_FOUND", {
          message: "No resources are configured for this type.",
        });
      }

      const coordinator = getCoordinator(type);
      const lease = await coordinator.acquire({
        type,
        leaseMs,
        waitMs,
      });

      if (!lease) {
        throw new ORPCError("CONFLICT", {
          message:
            waitMs > 0
              ? "No resource became available before waitMs elapsed."
              : "No resource is currently available for this type.",
        });
      }

      return lease;
    } catch (error) {
      return mapResourceError(error);
    }
  });

const acquireSpecificResourceProcedure = semaphore.resources.acquireSpecific
  .use(authProcedure)
  .handler(async ({ input }) => {
    try {
      const { type, slug, leaseMs } = input;
      const hasInventory = await hasInventoryForType(env.DB, type);
      if (!hasInventory) {
        throw new ORPCError("NOT_FOUND", {
          message: "No resources are configured for this type.",
        });
      }

      const coordinator = getCoordinator(type);
      return await coordinator.acquireSpecific({
        type,
        slug,
        leaseMs,
      });
    } catch (error) {
      return mapResourceError(error);
    }
  });

const renewResourceLeaseProcedure = semaphore.resources.renew
  .use(authProcedure)
  .handler(async ({ input }) => {
    try {
      const { type, slug, leaseId, leaseMs } = input;
      const coordinator = getCoordinator(type);
      return await coordinator.renew({
        type,
        slug,
        leaseId,
        leaseMs,
      });
    } catch (error) {
      return mapResourceError(error);
    }
  });

const releaseResourceProcedure = semaphore.resources.release
  .use(authProcedure)
  .handler(async ({ input }) => {
    try {
      const { type, slug, leaseId } = input;
      const coordinator = getCoordinator(type);
      const released = await coordinator.release({
        type,
        slug,
        leaseId,
      });
      return { released };
    } catch (error) {
      return mapResourceError(error);
    }
  });

/**
 * The `__internal.*` subtree (served at `/api/__internal/*`) is the operator
 * namespace the `iterate` CLI relies on: `pnpm cli rpc` discovers procedures
 * through `trpcCliProcedures`, and deploy tooling probes `health`.
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
  trpcCliProcedures: semaphore.__internal.trpcCliProcedures.handler(() => ({
    procedures: listCliProcedures(),
  })),
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
    acquireSpecific: acquireSpecificResourceProcedure,
    renew: renewResourceLeaseProcedure,
    release: releaseResourceProcedure,
  }),
});

// Hoisted + cast so the handler above can list the finished router without a
// circular type inference on `appRouter`.
function listCliProcedures(): unknown[] {
  return parseRouter({ router: appRouter as AnyRouter }).filter(
    (entry) => entry[0] !== "__internal.trpcCliProcedures",
  );
}
