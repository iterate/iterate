import { env as workerEnv } from "cloudflare:workers";
import { parseAppConfigFromEnv } from "@iterate-com/shared/apps/config";
import { withEvlog } from "@iterate-com/shared/apps/logging/with-evlog";
import handler from "@tanstack/react-start/server-entry";
import manifest, { AppConfig } from "~/app.ts";
import type { AppContext } from "~/context.ts";
import type { Env } from "~/env.ts";
import { normalizeInboundHost, proxyRequestToRoute } from "~/lib/proxy.ts";
import { resolveRouteByHost } from "~/lib/route-store.ts";

const config = parseAppConfigFromEnv({
  configSchema: AppConfig,
  prefix: "APP_CONFIG_",
  env: workerEnv as Record<string, unknown>,
});

function isManagementHost(host: string | null) {
  if (!host) return true;

  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "ingress.iterate.com" ||
    host === "dev-placeholder.ingress.iterate.com" ||
    host.endsWith(".workers.dev")
  );
}

function routeNotFoundResponse() {
  return Response.json({ error: "route_not_found" }, { status: 404 });
}

export async function handleIngressProxyRequest(
  request: Request,
  env: Env,
  executionCtx: ExecutionContext,
) {
  return withEvlog(
    {
      request,
      manifest,
      config,
      executionCtx,
    },
    async ({ log }) => {
      const context: AppContext = {
        manifest,
        config,
        env,
        rawRequest: request,
        db: env.DB,
        log,
      };

      const normalizedHost = normalizeInboundHost(request.headers.get("host"));
      const resolvedRoute = await resolveRouteByHost(env.DB, request.headers.get("host"));
      if (resolvedRoute && !isManagementHost(normalizedHost)) {
        return proxyRequestToRoute(request, resolvedRoute);
      }

      if (!resolvedRoute && !isManagementHost(normalizedHost)) {
        return routeNotFoundResponse();
      }

      return handler.fetch(request, { context });
    },
  );
}

export default {
  async fetch(request: Request, env: Env, executionCtx: ExecutionContext) {
    return handleIngressProxyRequest(request, env, executionCtx);
  },
};
