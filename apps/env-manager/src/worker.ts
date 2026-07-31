import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { EnvironmentDurableObject } from "./environment-durable-object.ts";
import { Env } from "./env.ts";
import { isCompiledEnvironmentStage } from "./environments.ts";

export { EnvironmentDurableObject };

const ENVIRONMENT_API = /^\/api\/environments\/([^/]+)$/;

export default createServerEntry({
  async fetch(request) {
    const url = new URL(request.url);
    const match = ENVIRONMENT_API.exec(url.pathname);

    if (match !== null) {
      const stage = decodeURIComponent(match[1]);
      if (!isCompiledEnvironmentStage(stage)) {
        return new Response("Unknown environment.", { status: 404 });
      }
      const headers = new Headers(request.headers);
      // Access is the public authorization boundary. This assertion only
      // distinguishes a human Access session from a service token for the
      // browser-only production-destroy guard.
      headers.set(
        "x-iterate-env-manager-browser-session",
        request.headers.has("cf-access-authenticated-user-email") ? "1" : "0",
      );
      return await Env.ENVIRONMENTS.getByName(stage).fetch(new Request(request, { headers }));
    }

    if (url.pathname === "/api/health") {
      return new Response("ok", { headers: { "content-type": "text/plain" } });
    }

    return handler.fetch(request);
  },
});
