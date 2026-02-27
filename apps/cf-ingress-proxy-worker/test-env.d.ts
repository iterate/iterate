import type { ProxyWorkerEnv } from "./server.ts";

declare module "cloudflare:test" {
  interface ProvidedEnv extends ProxyWorkerEnv {}
}
