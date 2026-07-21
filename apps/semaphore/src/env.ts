import { env as workerEnv } from "cloudflare:workers";
import type { ResourceCoordinator } from "~/durable-objects/resource-coordinator.ts";

/**
 * The semaphore worker's binding contract — the binding names wrangler.jsonc
 * (generated from the root envs.ts by scripts/generate-wrangler-config.ts)
 * declares on the worker (src/worker.ts). The repo-wide ambient `Env`
 * (src/lib/worker-env.d.ts) is this same interface.
 */
export interface Env {
  /** Immutable id of the Worker version serving this request. */
  CF_VERSION_METADATA: { id: string };
  /** D1: lease inventory mirror (`<worker>-resources`). */
  DB: D1Database;
  /** One coordinator DO per resource type: active leases, waiters, expiry alarms. */
  RESOURCE_COORDINATOR: DurableObjectNamespace<ResourceCoordinator>;
}

export const Env = workerEnv as unknown as Env;
