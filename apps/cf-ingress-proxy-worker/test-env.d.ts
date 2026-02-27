// Required by @cloudflare/vitest-pool-workers — types env bindings in test files (e.g. env.DB)
import type { RawProxyWorkerEnv } from "./env.ts";

declare module "cloudflare:test" {
  interface ProvidedEnv extends RawProxyWorkerEnv {}
}
