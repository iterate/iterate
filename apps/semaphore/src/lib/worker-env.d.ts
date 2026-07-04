import type { Env as SemaphoreEnv } from "../env.ts";

/**
 * Semaphore deploys as ONE worker (src/worker.ts); `src/env.ts` is its
 * binding contract, matching the bindings wrangler.jsonc declares (generated
 * from the root envs.ts by scripts/generate-wrangler-config.ts). The ambient
 * global `Env` and the `cloudflare:workers` module env are both that
 * contract.
 */
export interface CloudflareEnv extends SemaphoreEnv {}

declare global {
  type Env = CloudflareEnv;
}

declare module "cloudflare:workers" {
  namespace Cloudflare {
    export interface Env extends CloudflareEnv {}
  }
}
