import type { RawProxyWorkerEnv } from "./env.ts";

declare module "cloudflare:test" {
  interface ProvidedEnv extends RawProxyWorkerEnv {}
}
