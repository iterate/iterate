import { createAppRouterWithCommon } from "@iterate-com/shared/apps/common-router";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { AppConfig } from "~/app.ts";
import type { AppContext } from "~/context.ts";
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

function hasValidBearerToken(context: AppContext): boolean {
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

function getCoordinator(env: AppContext["env"], type: string) {
  return env.RESOURCE_COORDINATOR.getByName(type);
}

export const appRouter = createAppRouterWithCommon({
  appConfigSchema: AppConfig,
  createRouter: (commonRouter) =>
    os.router({
      common: os.common.router(commonRouter),
      resources: os.resources.router({
        add: addResourceProcedure,
        delete: deleteResourceProcedure,
        list: listResourcesProcedure,
        find: findResourceProcedure,
        acquire: acquireResourceProcedure,
        release: releaseResourceProcedure,
      }),
    }),
});

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
