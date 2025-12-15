import { logger } from "./backend/tag-logger.ts";
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
    // In tests, just run the promise and ignore errors
    promise.catch(() => {});
  };
}

export type CloudflareEnv = typeof worker.Env;
export const env = _env as CloudflareEnv;

// todo: better way to determine if we're in production
/** 🤷 */
export const isProduction = ["prd", "production", "prod"].includes(import.meta.env.VITE_APP_STAGE);

export const isNonProd = !isProduction;

/**
 * Wrapper around cloudflare:workers waitUntil that catches and logs errors.
 * Use this instead of importing waitUntil directly from "cloudflare:workers".
 *
 * @example
 * import { waitUntil } from "../env.ts";
 *
 * waitUntil((async () => {
 *   await someAsyncTask();
 * })());
 */
export function waitUntil(promise: Promise<unknown>): void {
  // Preemptively create an error to ensure we log with the correct stack trace
  const preemptiveError = new Error("[error message placeholder]");
  const callerStack = String(preemptiveError.stack).split("\n").slice(2).join("\n");
  _waitUntil(
    promise.catch((error) => {
      preemptiveError.cause = error;
      preemptiveError.message = `${error.message} (in waitUntil callback, original error in cause property)`;
      preemptiveError.stack = `${preemptiveError.message}:\n${callerStack}`;
      logger.error(preemptiveError);
    }),
  );
}
