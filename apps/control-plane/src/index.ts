// The control plane worker's entry point. The whole worker is wrapped in an OAuth 2.1 Authorization Server,
// but the AS only owns a thin edge: the /token endpoint, the .well-known metadata, and token-validation on
// /mcp. EVERYTHING ELSE (login, session, console, /authorize consent) falls through to `app`.
//
// This is the boundary that keeps us out of the app/os client-juggling mess:
//   • first-party surfaces  → session cookie via `app`   (0 OAuth clients)
//   • external MCP clients  → OAuth on /mcp, self-describing via CIMD  (0 hand-registered clients)
//   • programs / CI / devices → API keys, resolved below to the SAME props (design §2a)
// See docs/simplification/wayfinder/auth-worker-design.md.

import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { directory } from "./directory.ts";
import type { Env } from "./env.ts";
import { app } from "./app.ts";
import { sha256hex } from "./hash.ts";
import { mcpHandler } from "./mcp.ts";

export default new OAuthProvider<Env>({
  apiRoute: "/mcp", // the ONLY OAuth-protected boundary
  apiHandler: mcpHandler,
  defaultHandler: app, // login + session + /authorize consent + console + CIMD test-client doc
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  scopesSupported: ["project"],
  allowPlainPKCE: false, // OAuth 2.1: S256 only
  clientIdMetadataDocumentEnabled: true, // CIMD — clients register themselves by URL (default, proved on HTTPS)
  clientRegistrationEndpoint: "/register", // DCR — the spec-sanctioned MAY-fallback (used for the local http proof)

  // API keys / PATs: a bearer that isn't a provider-issued OAuth token falls through here. We hash it,
  // look it up in the directory, and return the SAME props shape the OAuth path produces. So an API key
  // works on /mcp (and any future apiRoute) with zero extra plumbing.
  resolveExternalToken: async ({ token, env }) => {
    const resolved = await directory(env.DB).resolveApiKey(await sha256hex(token));
    if (!resolved) return null;
    return {
      props: {
        sub: resolved.userId,
        email: "(api-key)",
        projectId: resolved.grants[0]?.projectId,
        grants: resolved.grants,
      },
    };
  },
});
