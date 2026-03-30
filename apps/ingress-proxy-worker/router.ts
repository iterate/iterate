import { ingressProxyContract, type IngressProxyRoute } from "@iterate-com/ingress-proxy-contract";
import { ORPCError, implement } from "@orpc/server";
import { z } from "zod";
import { Env } from "./env.ts";
import { getRouteByRootHost, listRoutes, removeRoute, upsertRoute } from "./route-store.ts";
import { RouteInputError } from "./proxy.ts";

type ORPCContext = {
  request: Request;
};

const os = implement(ingressProxyContract).$context<ORPCContext>();

function readBearerToken(headerValue: string | null): string | null {
  if (!headerValue) return null;
  const match = /^bearer\s+(.+)$/i.exec(headerValue);
  if (!match) return null;
  const token = match[1]?.trim() ?? "";
  return token.length > 0 ? token : null;
}

/**
 * Route management stays behind a single bearer token for now. That keeps the
 * worker intentionally small while we are manually operating deploys and D1.
 */
const authMiddleware = os.middleware(async ({ context, next }) => {
  const expectedToken = Env.INGRESS_PROXY_API_TOKEN;
  const providedToken = readBearerToken(context.request.headers.get("authorization"));

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

/**
 * The contract package describes the public API shape. The implementation layer
 * is mainly responsible for auth and translating storage/runtime failures into
 * explicit oRPC errors.
 */
const routesUpsert = os.routes.upsert.use(authMiddleware).handler(async ({ input }) => {
  try {
    return await upsertRoute(Env.DB, input);
  } catch (error) {
    return mapRouteError(error);
  }
});

const routesGet = os.routes.get.use(authMiddleware).handler(async ({ input }) => {
  try {
    const route = await getRouteByRootHost(Env.DB, input);
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

const routesList = os.routes.list.use(authMiddleware).handler(async ({ input }) => {
  try {
    return await listRoutes(Env.DB, input);
  } catch (error) {
    return mapRouteError(error);
  }
});

const routesRemove = os.routes.remove.use(authMiddleware).handler(async ({ input }) => {
  try {
    return {
      deleted: await removeRoute(Env.DB, input),
    };
  } catch (error) {
    return mapRouteError(error);
  }
});

export const ingressProxyRouter = os.router({
  routes: {
    upsert: routesUpsert,
    get: routesGet,
    list: routesList,
    remove: routesRemove,
  },
});

export type IngressProxyRouter = typeof ingressProxyRouter;
export type ResolvedIngressProxyRoute = IngressProxyRoute;
