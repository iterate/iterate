// env.ts — the one worker's bindings: the context DO's (iterate-context-durable-object.ts `Env`,
// the control plane's D1 among them) plus the issuer's own — the OAuth provider's KV, the browser
// sessions, the issuer's page files and the mailbox.

import type { BrowserSession } from "iterate/app-session";
import type { Env as DurableObjectEnv } from "./iterate-context-durable-object.ts";

/** Platform bindings for the issuer, public APIs and project ingress. */
export interface Env extends DurableObjectEnv {
  BROWSER_SESSION: DurableObjectNamespace<BrowserSession>;
  /** The OAuth provider's tokens and DCR clients, the sign-in challenges and the personal access
   *  tokens' index. The provider's grants live in the control plane's D1 instead: it reads this
   *  binding through oauth-store.ts. */
  OAUTH_KV: KVNamespace;
  /** Static assets for the Start client and the consent page. The Worker handles platform requests
   *  first, then asks this binding for public files (issuer-pages.ts). */
  ASSETS: Fetcher;
  /** Email Sending (wrangler `send_email`) — how the sign-in code reaches the person
   *  (password-and-code-sign-in.ts). Simulated by wrangler dev and the test configs; absent where a
   *  deployment has no mailbox. */
  EMAIL?: SendEmail;
  /** PostHog's project key (envs.ts, prd only): the issuer's pages start posthog-js with it. */
  POSTHOG_PROJECT_KEY?: string;
}

/** A worker handler with a REQUIRED fetch: the issuer's pages behind the platform's OAuth routes
 *  (api.ts `oauthResponse`). */
export interface Handler {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response>;
}
