import { logger } from "./backend/tag-logger.ts";
import type { worker } from "./alchemy.run.ts";

let _env: any;
let _waitUntil: any;

try {
  const cloudflareWorkers = await import("cloudflare:workers");
  _env = cloudflareWorkers.env;
  _waitUntil = cloudflareWorkers.waitUntil;
} catch {
  _env = {};
  _waitUntil = (promise: Promise<unknown>) => {
    promise.catch(() => {});
  };
}

export type CloudflareEnv = typeof worker.Env;
export const env = _env as CloudflareEnv;

export const isProduction = ["prd", "production", "prod"].includes(import.meta.env.VITE_APP_STAGE);
export const isNonProd = !isProduction;

export function waitUntil(promise: Promise<unknown>): void {
  _waitUntil(promise.catch((error) => logger.error(error)));
}
