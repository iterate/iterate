// The CONTROL PLANE — mounted IN-PROCESS as the project worker's front-door catch-all (src/worker.ts
// keeps /api, /expression, /version, /demo and delegates everything else here). The whole handler is
// wrapped in an OAuth 2.1 Authorization Server, but the AS only owns a thin edge: the /token endpoint,
// the .well-known metadata, and token-validation on /mcp. EVERYTHING ELSE (login, session, console,
// /authorize consent, project creation) falls through to `app`.
//
//   • first-party surfaces  → session cookie via `app`   (0 OAuth clients)
//   • external MCP clients  → OAuth on /mcp, self-describing via CIMD  (0 hand-registered clients)

import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { appConfigOf } from "../app-config.ts";
import type { Env } from "./env.ts";
import { app } from "./app.ts";
import { mcpHandler } from "./mcp.ts";
import { ANONYMOUS } from "./session.ts";

const provider = new OAuthProvider<Env>({
  apiRoute: "/mcp", // the ONLY OAuth-protected boundary
  apiHandler: mcpHandler,
  defaultHandler: app, // login + session + /authorize consent + console
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  scopesSupported: ["project"],
  allowPlainPKCE: false, // OAuth 2.1: S256 only
  clientIdMetadataDocumentEnabled: true, // CIMD — clients register themselves by URL (proved on HTTPS)
  clientRegistrationEndpoint: "/register", // DCR — the spec-sanctioned MAY-fallback (the local http proof)
});

// `open` login mode (APP_CONFIG_LOGIN_MODE): no OAuth, so `/mcp` is TOKENLESS — short-circuit before
// the provider's apiRoute would 401, running the MCP server with the single anonymous identity. `email`
// mode goes through the provider unchanged.
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (appConfigOf(env).loginMode === "open" && new URL(request.url).pathname === "/mcp") {
      (ctx as ExecutionContext & { props: unknown }).props = {
        sub: ANONYMOUS.sub,
        email: ANONYMOUS.email,
      };
      return mcpHandler.fetch(request, env, ctx);
    }
    return provider.fetch(request, env, ctx);
  },
};
