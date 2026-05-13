import type { worker } from "../../alchemy.run.ts";

// Alchemy's `Ai()` binding defaults its model-list generic to `Record<string, any>`, which
// strips per-model typing off `env.AI.run(...)`. Cloudflare's own docs show the canonical
// shape as `AI: Ai`, which defaults to the workerd-generated `AiModels` map (with full typed
// overloads for every supported model, including `@cf/moonshotai/kimi-k2.6`).
// See https://developers.cloudflare.com/workers-ai/configuration/bindings/.
export type CloudflareEnv = Omit<typeof worker.Env, "AI"> & {
  LOADER: WorkerLoader;
  CODEMODE_OUTBOUND_FETCH: Fetcher;
  APP_CONFIG: string;
  AI: Ai;
};

declare global {
  type Env = CloudflareEnv;
}

declare module "cloudflare:workers" {
  namespace Cloudflare {
    export interface Env extends CloudflareEnv {}
  }
}
