import type { worker } from "./alchemy.run.ts";
import type { AnalyticsEngineDataset } from "./backend/egress-proxy/usage-writer.ts";

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

// Extend the base env with Analytics Engine binding (added via wrangler transform)
export type CloudflareEnv = typeof worker.Env & {
  /** Analytics Engine dataset for usage metering */
  USAGE_ANALYTICS?: AnalyticsEngineDataset;
};
export const env = _env as CloudflareEnv;

export { isProduction, isNonProd } from "./env-client.ts";

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
