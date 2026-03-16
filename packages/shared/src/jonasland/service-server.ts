import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { ROOT_CONTEXT, context as otelContext, propagation } from "@opentelemetry/api";
import type { HttpBindings } from "@hono/node-server";
import { Hono } from "hono";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { oc } from "@orpc/contract";
import { implement, ORPCError } from "@orpc/server";
import type { AnyRouter, Context as ORPCContext } from "@orpc/server";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import {
  createOrpcErrorInterceptor,
  createServiceRequestLogger,
  createServiceSubRouterContract,
  extractIncomingTraceContext,
  getRequestIdHeader,
  transformSqlResultSet,
  type ServiceRequestLogger,
  type SqlResultSet,
} from "./index.ts";

export type ServiceAppVariables = {
  requestId: string;
  requestLog: ServiceRequestLogger;
};

export type ServiceAppEnv = { Bindings: HttpBindings; Variables: ServiceAppVariables };

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function createServiceOpenAPIHandler(params: {
  router: AnyRouter;
  title: string;
  version: string;
}) {
  return new OpenAPIHandler(params.router, {
    plugins: [
      new OpenAPIReferencePlugin({
        docsProvider: "scalar",
        docsPath: "/docs",
        specPath: "/openapi.json",
        schemaConverters: [new ZodToJsonSchemaConverter()],
        specGenerateOptions: {
          info: { title: params.title, version: params.version },
          servers: [{ url: "/api" }],
        },
      }),
    ],
    interceptors: [createOrpcErrorInterceptor()],
  });
}

export function applyServiceMiddleware(app: Hono<ServiceAppEnv>) {
  app.use("*", async (c, next) => {
    const incomingContext = extractIncomingTraceContext(c.req.raw.headers, (carrier) =>
      propagation.extract(ROOT_CONTEXT, carrier),
    );
    return otelContext.with(incomingContext, next);
  });

  app.use("*", async (c, next) => {
    const requestId = getRequestIdHeader(c.req.header("x-request-id")) ?? randomUUID();
    const requestLog = createServiceRequestLogger({
      requestId,
      method: c.req.method,
      path: c.req.path,
    });
    const startedAt = Date.now();

    c.set("requestId", requestId);
    c.set("requestLog", requestLog);

    let status = 500;
    try {
      await next();
      status = c.res.status;
    } catch (error) {
      requestLog.error(toError(error));
      status = 500;
      throw error;
    } finally {
      const outgoingStatus = c.env.outgoing?.statusCode;
      if (typeof outgoingStatus === "number" && outgoingStatus > 0) {
        status = outgoingStatus;
      }
      requestLog.emit({
        status,
        durationMs: Date.now() - startedAt,
      });
    }
  });
}

/**
 * Creates a minimal oRPC router with only the standard service sub-routes
 * (health, sql, debug). Use for services that don't have their own oRPC contract.
 */
export function createSimpleServiceRouter(params: {
  serviceName: string;
  version: string;
  executeSql?: (statement: string) => Promise<SqlResultSet>;
}) {
  const contract = oc.router(createServiceSubRouterContract());
  const os = implement(contract).$context<{
    requestId: string;
    serviceName: string;
    log: ServiceRequestLogger;
  }>();

  return os.router({
    service: {
      health: os.service.health.handler(async ({ context }) => ({
        ok: true as const,
        service: context.serviceName,
        version: params.version,
      })),
      sql: os.service.sql.handler(async ({ input }) => {
        if (!params.executeSql) {
          throw new ORPCError("NOT_IMPLEMENTED", { message: "sql not supported" });
        }
        return transformSqlResultSet(await params.executeSql(input.statement));
      }),
      debug: os.service.debug.handler(async () => {
        const env: Record<string, string | null> = {};
        for (const [key, value] of Object.entries(process.env)) {
          env[key] = value ?? null;
        }
        const mem = process.memoryUsage();
        return {
          pid: process.pid,
          ppid: process.ppid,
          uptimeSec: process.uptime(),
          nodeVersion: process.version,
          platform: process.platform,
          arch: process.arch,
          hostname: hostname(),
          cwd: process.cwd(),
          execPath: process.execPath,
          argv: process.argv,
          env,
          memoryUsage: {
            rss: mem.rss,
            heapTotal: mem.heapTotal,
            heapUsed: mem.heapUsed,
            external: mem.external,
            arrayBuffers: mem.arrayBuffers,
          },
        };
      }),
    },
  });
}

export function applyOpenAPIRoute(
  app: Hono<ServiceAppEnv>,
  handler: OpenAPIHandler<ORPCContext>,
  serviceName: string,
  options?: {
    extraContext?: () => Record<string, unknown>;
  },
) {
  const extra = options?.extraContext;

  app.all("/api/*", async (c) => {
    const context = {
      requestId: c.get("requestId"),
      serviceName,
      log: c.get("requestLog"),
      ...(extra ? extra() : {}),
    };
    const { matched, response } = await handler.handle(c.req.raw, {
      prefix: "/api",
      context,
    });
    if (matched) return c.newResponse(response.body, response);
    return c.json({ error: "not_found" }, 404);
  });
}
