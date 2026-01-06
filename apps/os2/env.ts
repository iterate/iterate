import type { worker } from "./alchemy.run.ts";

// Conditionally import cloudflare:workers - it's not available in test environment
let _env: any;
let _waitUntil: any;

try {
  const cloudflareWorkers = await import("cloudflare:workers");
  _env = cloudflareWorkers.env;
  _waitUntil = cloudflareWorkers.waitUntil;
} catch {
  // In test environment or when cloudflare:workers is not available, provide mocks
  _env = {};
  _waitUntil = (promise: Promise<unknown>) => {
    promise.catch(() => {});
  };
}

export type CloudflareEnv = typeof worker.Env;
export const env = _env as CloudflareEnv;

export const isProduction = ["prd", "production", "prod"].includes(import.meta.env.VITE_APP_STAGE);
export const isNonProd = !isProduction;

/**
 * Wrapper around cloudflare:workers waitUntil that catches and logs errors.
 */
export function waitUntil(promise: Promise<unknown>): void {
  _waitUntil(
    promise.catch((error) => {
      console.error("waitUntil error:", error);
    }),
  );
}
