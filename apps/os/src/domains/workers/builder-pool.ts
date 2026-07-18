/**
 * Pool addressing for the deployment's worker builders — the PURE half
 * (importable from node-side scripts and tests). The container class and the
 * stub getter live in builder-pool-sandbox.ts, which pulls the sandbox SDK
 * and therefore only loads inside workerd.
 */
export const WORKER_BUILDER_POOL_SIZE = 4;

/** The pool member that owns a build key — stable so retries of one key land
 * on the member whose npm cache they already warmed, spread so unrelated
 * builds use the whole pool. `attempt` shifts to the next member in ring
 * order: affinity is a warmth optimization, but a member whose container is
 * sick (hung toolchain install, dead placement) would otherwise own its
 * keyspace's failures for as long as it stays sick — observed live as five
 * e2e specs dying on one wedged member while the healthy members' keys all
 * passed. Failover attempts must therefore break affinity, deterministically.
 */
export function builderPoolMember(buildKey: string, attempt = 0): string {
  // FNV-1a: tiny, deterministic, and plenty uniform for a handful of slots.
  let hash = 0x811c9dc5;
  for (let i = 0; i < buildKey.length; i++) {
    hash ^= buildKey.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `worker-builder-${((hash >>> 0) + attempt) % WORKER_BUILDER_POOL_SIZE}`;
}
