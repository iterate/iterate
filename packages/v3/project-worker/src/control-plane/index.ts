// The CONTROL PLANE — mounted IN-PROCESS as the project worker's front-door catch-all (src/worker.ts
// keeps /api, /expression, /version, /demo and delegates everything else here). The whole handler is
// wrapped in an OAuth 2.1 Authorization Server, but the AS only owns a thin edge: the /token endpoint,
// the .well-known metadata, and token-validation on /mcp. EVERYTHING ELSE (login, session, console,
// /authorize consent, project creation) falls through to `app`.
//
// This is the boundary that keeps us out of the app/os client-juggling mess:
//   • first-party surfaces  → session cookie via `app`   (0 OAuth clients)
//   • external MCP clients  → OAuth on /mcp, self-describing via CIMD  (0 hand-registered clients)
// See apps/os/docs/simplification/wayfinder/auth-worker-design.md.

import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import type { Env } from "./env.ts";
import { ANONYMOUS, app } from "./app.ts";
import { mcpHandler } from "./mcp.ts";

const provider = new OAuthProvider<Env>({
  apiRoute: "/mcp", // the ONLY OAuth-protected boundary
  apiHandler: mcpHandler,
  defaultHandler: app, // login + session + /authorize consent + console + CIMD test-client doc
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  scopesSupported: ["project"],
  allowPlainPKCE: false, // OAuth 2.1: S256 only
  clientIdMetadataDocumentEnabled: true, // CIMD — clients register themselves by URL (default, proved on HTTPS)
  clientRegistrationEndpoint: "/register", // DCR — the spec-sanctioned MAY-fallback (used for the local http proof)
});

// WIDE-OPEN topology (LOGIN_MODE=open, the Raspberry-Pi floor): the box has no OAuth, so `/mcp` must be
// TOKENLESS — we short-circuit before the provider's apiRoute would 401, running the MCP server with the
// single anonymous identity. Every other mode goes through the provider unchanged.
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if ((env.LOGIN_MODE ?? "email") === "open" && new URL(request.url).pathname === "/mcp") {
      (ctx as ExecutionContext & { props: unknown }).props = {
        sub: ANONYMOUS.sub,
        email: ANONYMOUS.email,
      };
      return mcpHandler.fetch(request, env, ctx);
    }
    return provider.fetch(request, env, ctx);
  },
};
