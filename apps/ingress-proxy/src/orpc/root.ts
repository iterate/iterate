import { createInternalRouter } from "@iterate-com/shared/apps/internal-router";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { AppConfig } from "~/app.ts";
import { getRouteByRootHost, listRoutes, removeRoute, upsertRoute } from "~/lib/route-store.ts";
import { RouteInputError } from "~/lib/proxy.ts";
import { os } from "~/orpc/orpc.ts";

function readBearerToken(headerValue: string | null): string | null {
  if (!headerValue) return null;
  const match = /^bearer\s+(.+)$/i.exec(headerValue);
  if (!match) return null;
  const token = match[1]?.trim() ?? "";
  return token.length > 0 ? token : null;
}

const authMiddleware = os.middleware(async ({ context, next }) => {
  const expectedToken = context.config.sharedApiSecret.exposeSecret();
  const providedToken = readBearerToken(context.rawRequest?.headers.get("authorization") ?? null);

  if (!providedToken || providedToken !== expectedToken) {
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

function mapRouteError(error: unknown): never {
  if (error instanceof ORPCError) {
    throw error;
  }

  if (error instanceof RouteInputError) {
    throw new ORPCError("BAD_REQUEST", {
      message: error.message,
    });
  }

  if (isZodErrorLike(error)) {
    throw new ORPCError("BAD_REQUEST", {
      message: error.issues[0]?.message ?? "Invalid request input.",
    });
  }

  if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) {
    throw new ORPCError("CONFLICT", {
      message: "A route already exists for this root host.",
    });
  }

  throw error;
}

const routesUpsert = os.routes.upsert.use(authMiddleware).handler(async ({ context, input }) => {
  try {
    return await upsertRoute(context.env.DB, input, {
      typeIdPrefix: context.config.typeIdPrefix.exposeSecret(),
    });
  } catch (error) {
    return mapRouteError(error);
  }
});

const routesGet = os.routes.get.handler(async ({ context, input }) => {
  try {
    const route = await getRouteByRootHost(context.env.DB, input);
    if (!route) {
      throw new ORPCError("NOT_FOUND", {
        message: `No ingress route exists for ${input.rootHost}.`,
      });
    }

    return route;
  } catch (error) {
    return mapRouteError(error);
  }
});

const routesList = os.routes.list.handler(async ({ context, input }) => {
  try {
    return await listRoutes(context.env.DB, input);
  } catch (error) {
    return mapRouteError(error);
  }
});

const routesRemove = os.routes.remove.use(authMiddleware).handler(async ({ context, input }) => {
  try {
    return {
      deleted: await removeRoute(context.env.DB, input),
    };
  } catch (error) {
    return mapRouteError(error);
  }
});

export const appRouter = os.router({
  __internal: os.__internal.router(
    createInternalRouter({
      appConfigSchema: AppConfig,
    }),
  ),
  routes: os.routes.router({
    upsert: routesUpsert,
    get: routesGet,
    list: routesList,
    remove: routesRemove,
  }),
});
