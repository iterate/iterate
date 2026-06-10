import { ORPCError } from "@orpc/server";
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
import { os } from "~/orpc/orpc.ts";

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

const authProcedure = os.middleware(async ({ context, next }) => {
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

function getCoordinator(env: RequestContext["env"], type: string) {
  return env.RESOURCE_COORDINATOR.getByName(type);
}

const addResourceProcedure = os.resources.add
  .use(authProcedure)
  .handler(async ({ context, input }) => {
    try {
      const { type, slug, data } = input;
      const coordinator = getCoordinator(context.env, type);
      const hasActiveLease = await coordinator.hasActiveLease({ type, slug });
      if (hasActiveLease) {
        throw new ORPCError("CONFLICT", {
          message: "Cannot add a resource while an older lease is still active for this slug.",
        });
      }

      const created = await insertResource(context.env.DB, {
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

const deleteResourceProcedure = os.resources.delete
  .use(authProcedure)
  .handler(async ({ context, input }) => {
    try {
      const { type, slug } = input;
      const deleted = await deleteResourceFromDb(context.env.DB, { type, slug });
      return { deleted };
    } catch (error) {
      return mapResourceError(error);
    }
  });

const listResourcesProcedure = os.resources.list
  .use(authProcedure)
  .handler(async ({ context, input }) => {
    try {
      return await listResourcesFromDb(context.env.DB, { type: input.type });
    } catch (error) {
      return mapResourceError(error);
    }
  });

const findResourceProcedure = os.resources.find
  .use(authProcedure)
  .handler(async ({ context, input }) => {
    try {
      const resource = await findResourceByKey(context.env.DB, input);
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

const acquireResourceProcedure = os.resources.acquire
  .use(authProcedure)
  .handler(async ({ context, input }) => {
    try {
      const { type, leaseMs, waitMs = 0 } = input;
      const hasInventory = await hasInventoryForType(context.env.DB, type);
      if (!hasInventory) {
        throw new ORPCError("NOT_FOUND", {
          message: "No resources are configured for this type.",
        });
      }

      const coordinator = getCoordinator(context.env, type);
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

const acquireSpecificResourceProcedure = os.resources.acquireSpecific
  .use(authProcedure)
  .handler(async ({ context, input }) => {
    try {
      const { type, slug, leaseMs } = input;
      const hasInventory = await hasInventoryForType(context.env.DB, type);
      if (!hasInventory) {
        throw new ORPCError("NOT_FOUND", {
          message: "No resources are configured for this type.",
        });
      }

      const coordinator = getCoordinator(context.env, type);
      return await coordinator.acquireSpecific({
        type,
        slug,
        leaseMs,
      });
    } catch (error) {
      return mapResourceError(error);
    }
  });

const renewResourceLeaseProcedure = os.resources.renew
  .use(authProcedure)
  .handler(async ({ context, input }) => {
    try {
      const { type, slug, leaseId, leaseMs } = input;
      const coordinator = getCoordinator(context.env, type);
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

const releaseResourceProcedure = os.resources.release
  .use(authProcedure)
  .handler(async ({ context, input }) => {
    try {
      const { type, slug, leaseId } = input;
      const coordinator = getCoordinator(context.env, type);
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
const internalRouter = os.__internal.router({
  health: os.__internal.health.handler(() => ({
    ok: true as const,
    app: "semaphore",
    version: packageJson.version,
  })),
  // Strips `redacted(...)` fields, exposing only `publicValue(...)` ones — this
  // is what the browser boots from in routes/__root.tsx.
  publicConfig: os.__internal.publicConfig.handler(({ context }) =>
    getPublicConfig(context.config, AppConfig),
  ),
  // UNAUTHENTICATED route — never return secrets here (see the os incident).
  debug: os.__internal.debug.handler(() => ({ runtime: "workerd" })),
  trpcCliProcedures: os.__internal.trpcCliProcedures.handler(() => ({
    procedures: listCliProcedures(),
  })),
  refreshRegistry: os.__internal.refreshRegistry.handler(() => {
    throw new ORPCError("NOT_IMPLEMENTED", {
      message: "__internal.refreshRegistry is not implemented for semaphore",
    });
  }),
});

export const appRouter = os.router({
  __internal: internalRouter,
  resources: os.resources.router({
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
