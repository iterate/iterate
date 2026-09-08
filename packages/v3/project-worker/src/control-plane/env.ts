import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { AppConfigEnv } from "../app-config.ts";

/** The control plane's bindings — a slice of the one worker's env (src/worker.ts intersects it with the
 *  DO's `Env`). Its configuration (the login mode, the session secret) is the worker's, through
 *  `appConfigOf(env)` (src/app-config.ts). `OAUTH_PROVIDER` is injected by the OAuthProvider wrapper at
 *  request time. */
export interface Env extends AppConfigEnv {
  /** Provider-owned store: grants, tokens, DCR clients. Required by @cloudflare/workers-oauth-provider. */
  OAUTH_KV: KVNamespace;
  /** The directory: users, orgs, org_members, projects (definitions.sql). Strongly consistent (D1). */
  DB: D1Database;
  /** Injected by the provider — the OAuth helper surface (parseAuthRequest / completeAuthorization / …). */
  OAUTH_PROVIDER: OAuthHelpers;
}

/** A worker handler with a REQUIRED fetch — what OAuthProvider expects for defaultHandler/apiHandler. */
export interface Handler {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response>;
}
