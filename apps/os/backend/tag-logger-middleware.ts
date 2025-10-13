import type { MiddlewareHandler } from "hono";
import type { TagLogger } from "./tag-logger.ts";

/**
 * Creates a Hono middleware that wraps each request with logger context.
 *
 * Example:
 * ```typescript
 * import { createLoggerMiddleware } from "./tag-logger-middleware.ts";
 *
 * app.use("*", createLoggerMiddleware(logger, (c) => ({
 *   userId: c.var.session?.user?.id || undefined,
 *   path: c.req.path,
 *   httpMethod: c.req.method,
 *   url: c.req.url,
 *   traceId: typeid("req").toString(),
 * })));
 * ```
 */
export function createLoggerMiddleware<
  E extends Record<string, any> = any,
  V extends Record<string, any> = any,
>(
  loggerInstance: TagLogger,
  getMetadata: (context: any) => TagLogger.Context["metadata"],
): MiddlewareHandler<{ Bindings: E; Variables: V }> {
  return async (c, next) => {
    const metadata = getMetadata(c);
    // Always create a new context for each request to ensure isolation
    await loggerInstance.runInContext(metadata, next);
  };
}
