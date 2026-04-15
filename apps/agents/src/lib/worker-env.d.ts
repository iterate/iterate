import type { worker } from "../../alchemy.run.ts";

export type CloudflareEnv = typeof worker.Env & {
  LOADER: WorkerLoader;
};

declare global {
  type Env = CloudflareEnv;
}

declare module "cloudflare:workers" {
  namespace Cloudflare {
    export interface Env extends CloudflareEnv {}
  }
}
