import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

/**
 * How a human proves who they are. The ONE knob of the auth worker (design §3).
 * - `email`  — the login form takes an email; we own the session. (Consumer self-serve.)
 * - `access` — read the verified email from a Cloudflare-Access-injected header; no form of our own.
 * - `open`   — no login; a single anonymous identity. (The Raspberry-Pi floor.)
 */
export type LoginMode = "email" | "access" | "open";

/** The auth worker's bindings. `OAUTH_PROVIDER` is injected by the OAuthProvider wrapper at request time. */
export interface Env {
  /** Provider-owned store: grants, tokens, DCR clients. Required by @cloudflare/workers-oauth-provider. */
  OAUTH_KV: KVNamespace;
  /** The directory: users/projects/memberships/routes/api_keys. Strongly consistent (D1/sqlfu, design §2a). */
  DB: D1Database;
  /** HMAC secret for the session cookie. Doppler-backed in a real deploy; a committed demo value here. */
  SESSION_SECRET: string;
  /** Login backend. Defaults to `email`. */
  LOGIN_MODE?: LoginMode;
  /** Header carrying the verified email when LOGIN_MODE=access (e.g. `cf-access-authenticated-user-email`). */
  ACCESS_EMAIL_HEADER?: string;
  /** The project worker's base URL — where resolved project ingress is dialed (cross-account HTTP dial). */
  PROJECT_WORKER_URL?: string;
  /** Shared secret presented to the project worker on the HTTP dial (must match its RUNNER_DIAL_SECRET). */
  RUNNER_DIAL_SECRET?: string;
  /** Same-account service binding to the project worker's ProjectRunner (the preferred dial when present). */
  RUNNER?: {
    serve(
      request: Request,
      projectId: string,
      app: string,
      callerHeader: string,
    ): Promise<Response>;
  };
  /** This control plane's own origin — handed to the project worker so private apps can redirect to login. */
  CONTROL_PLANE_ORIGIN?: string;
  /** Injected by the provider — the OAuth helper surface (parseAuthRequest / completeAuthorization / …). */
  OAUTH_PROVIDER: OAuthHelpers;
}

/** A worker handler with a REQUIRED fetch — what OAuthProvider expects for defaultHandler/apiHandler. */
export interface Handler {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response>;
}
