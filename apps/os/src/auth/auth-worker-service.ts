import { env as workerEnv } from "cloudflare:workers";
import type { Env } from "../env.ts";

// The auth worker (apps/auth) is reached over the `AUTH` service binding —
// Workers RPC on the auth worker's default entrypoint, wired up in
// apps/os/alchemy.run.ts. Holding the binding is the credential (bindings can
// only be attached by a deploy into the same Cloudflare account), which is
// why there is no token here; the old x-iterate-service-token HTTP client
// this replaced is gone. In fully-local dev the binding is a REMOTE binding:
// the call still looks like `env.AUTH.method()` but wrangler/vite proxy it to
// the deployed auth worker for the stage.
// https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/
// https://developers.cloudflare.com/workers/local-development/#remote-bindings
//
// Only the OAuth/OIDC *protocol* (login redirects, token exchange, JWKS)
// stays on the auth worker's public hostname — browsers and third-party
// clients cannot hold bindings. See src/auth/iterate-auth-client.ts.

/** The AUTH binding, or undefined when this deployment has no auth worker
 * (alchemy omits the binding rather than failing the deploy). */
export function maybeAuthWorker(): NonNullable<Env["AUTH"]> | undefined {
  return (workerEnv as unknown as Env).AUTH;
}

/** The AUTH binding, for callers that cannot proceed without it. */
export function authWorker(): NonNullable<Env["AUTH"]> {
  const auth = maybeAuthWorker();
  if (!auth) {
    throw new Error(
      "The AUTH service binding is not configured — the auth worker for this stage " +
        "was not deployed when this worker was. Deploy the auth worker, then redeploy OS.",
    );
  }
  return auth;
}
