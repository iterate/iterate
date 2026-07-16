/**
 * Runtime configuration shared by every host that creates a Dynamic Worker.
 *
 * This is deliberately isolated from worker-loader.ts: the script-executor
 * sidecar only loads already-materialized JavaScript and must not pull the
 * repo resolver, artifact cache, or builder client into its tiny cold-start
 * bundle merely to agree on compatibility settings.
 */
export const DYNAMIC_WORKER_COMPATIBILITY_DATE = "2026-05-01";
export const DYNAMIC_WORKER_COMPATIBILITY_FLAGS = ["nodejs_compat"];
