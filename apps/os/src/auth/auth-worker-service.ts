import { env as workerEnv } from "cloudflare:workers";
import type { Env } from "../env.ts";

// The auth worker (apps/auth) is reached over the `AUTH` service binding —
// Workers RPC on the auth worker's default entrypoint, wired up in
// apps/os/alchemy.run.ts and bound in EVERY deployed OS worker. Holding the
// binding is the credential (bindings can only be attached by a deploy into
// the same Cloudflare account), which is why there is no token here; the old
// x-iterate-service-token HTTP client this replaced is gone. In fully-local
// dev the binding is a REMOTE binding: the call still looks like
// `env.AUTH.method()`, but wrangler/vite proxy it to the deployed auth worker
// for the stage.
// https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/
// https://developers.cloudflare.com/workers/local-development/#remote-bindings
//
// Only the OAuth/OIDC *protocol* (login redirects, token exchange, JWKS)
// stays on the auth worker's public hostname — browsers and third-party
// clients cannot hold bindings. See src/auth/iterate-auth-client.ts.

/** The AUTH binding. The runtime guard exists for vitest environments, which
 * construct workers without real bindings — deployments always have it. */
export function authWorker(): Env["AUTH"] {
  const auth = (workerEnv as unknown as Env).AUTH;
  if (!auth) {
    throw new Error("The AUTH service binding is missing — this is not a deployed OS worker.");
  }
  return auth;
}
