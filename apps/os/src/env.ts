// env.ts — the one worker's bindings: the context DO's (iterate-context-durable-object.ts `Env`)
// plus what the in-process control plane needs — the OAuth provider's store and helpers, the
// browser sessions, the issuer's page files and the mailbox. The registry itself is the
// `CONTROL_PLANE` singleton Durable Object, reached by binding (src/control-plane/edge.ts).

import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { BrowserSession } from "iterate/next/app-session";
import type { ControlPlaneDurableObject } from "./control-plane/durable-object.ts";
import type { Env as DurableObjectEnv } from "./iterate-context-durable-object.ts";

/** Platform bindings for the issuer, public APIs and project ingress. */
export interface Env extends DurableObjectEnv {
  BROWSER_SESSION: DurableObjectNamespace<BrowserSession>;
  /** The registry: one singleton `ControlPlaneDurableObject` (getByName("global")), the worker's
   *  strongly-consistent index of users, identities, organizations, memberships and projects. */
  CONTROL_PLANE: DurableObjectNamespace<ControlPlaneDurableObject>;
  /** Provider-owned store: grants, tokens, DCR clients. Required by @cloudflare/workers-oauth-provider. */
  OAUTH_KV: KVNamespace;
  /** Injected by the provider — the OAuth helper surface (parseAuthRequest / completeAuthorization / …). */
  OAUTH_PROVIDER: OAuthHelpers;
  /** Static assets for the Start client and the consent page. The Worker handles platform requests
   *  first, then asks this binding for public files (issuer-pages.ts). */
  ASSETS: Fetcher;
  /** Email Sending (wrangler `send_email`) — how the sign-in code reaches the person
   *  (password-and-code-sign-in.ts). Simulated by wrangler dev and the test configs; absent where a
   *  deployment has no mailbox. */
  EMAIL?: SendEmail;
}

/** A worker handler with a REQUIRED fetch — what OAuthProvider expects for defaultHandler/apiHandler. */
export interface Handler {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response>;
}
