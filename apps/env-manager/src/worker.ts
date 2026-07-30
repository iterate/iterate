import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { withAuthenticationResponseHeaders } from "@iterate-com/auth/server";
import { createEnvManagerIterateAuth, resolveRequestPrincipal } from "./auth.ts";
import { parseConfig } from "./config.ts";
import { EnvironmentDurableObject } from "./environment-durable-object.ts";
import { Env } from "./env.ts";
import { isCompiledEnvironmentStage } from "./environments.ts";
import type { RequestContext } from "./request-context.ts";

export { EnvironmentDurableObject };

const ENVIRONMENT_API = /^\/api\/environments\/([^/]+)$/;

export default createServerEntry({
  async fetch(request) {
    const url = new URL(request.url);
    const match = ENVIRONMENT_API.exec(url.pathname);
    const config = parseConfig(Env);

    if (match !== null) {
      const stage = decodeURIComponent(match[1]);
      if (!isCompiledEnvironmentStage(stage)) {
        return new Response("Unknown environment.", { status: 404 });
      }
      const auth = createEnvManagerIterateAuth(config);
      const resolved = await resolveRequestPrincipal({ auth, headers: request.headers });
      if (resolved.principal?.isAdmin !== true) {
        return withAuthenticationResponseHeaders(
          new Response("Iterate admin authentication required.", { status: 401 }),
          resolved.responseHeaders,
        );
      }
      const headers = new Headers(request.headers);
      // Always overwrite this internal assertion so an external caller cannot
      // promote a bearer token into the browser-only production destroy lane.
      headers.set("x-iterate-env-manager-browser-session", resolved.session === null ? "0" : "1");
      const response = await Env.ENVIRONMENTS.getByName(stage).fetch(
        new Request(request, { headers }),
      );
      return withAuthenticationResponseHeaders(response, resolved.responseHeaders);
    }

    if (url.pathname === "/api/health") {
      return new Response("ok", { headers: { "content-type": "text/plain" } });
    }

    return handler.fetch(request, {
      context: { config, rawRequest: request } satisfies RequestContext,
    });
  },
});
