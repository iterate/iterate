// env.ts — the one worker's bindings: the context DO's (iterate-context-durable-object.ts `Env`,
// the control plane's D1 among them) plus the issuer's own — the OAuth provider's KV, the browser
// sessions and the issuer's page files.

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
}

/** A worker handler with a REQUIRED fetch: the issuer's pages behind the platform's OAuth routes
 *  (api.ts `oauthResponse`). */
export interface Handler {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response>;
}
