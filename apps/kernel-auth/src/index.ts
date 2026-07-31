// The auth worker's entry point. The whole worker is wrapped in an OAuth 2.1 Authorization Server, but the
// AS only owns a thin edge: the /token endpoint, the .well-known metadata, and token-validation on /mcp.
// EVERYTHING ELSE (login, session, home, /authorize consent) falls through to `app` (the default handler).
//
// This is the boundary that keeps us out of the app/os client-juggling mess:
//   • first-party surfaces  → session cookie via `app`   (0 OAuth clients)
//   • external MCP clients  → OAuth on /mcp, self-describing via CIMD  (0 hand-registered clients)
// See docs/simplification/wayfinder/auth-worker-design.md.

import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import type { Env } from "./env.ts";
import { app } from "./app.ts";
import { mcpHandler } from "./mcp.ts";

export default new OAuthProvider<Env>({
  apiRoute: "/mcp", // the ONLY OAuth-protected boundary
  apiHandler: mcpHandler,
  defaultHandler: app, // login + session + /authorize consent
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  scopesSupported: ["project"],
  allowPlainPKCE: false, // OAuth 2.1: S256 only
  clientIdMetadataDocumentEnabled: true, // CIMD — clients register themselves by URL, no DCR
});
