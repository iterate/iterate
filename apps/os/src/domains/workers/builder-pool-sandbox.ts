import { getSandbox, Sandbox } from "@cloudflare/sandbox";

/** The container class itself consumes only Sandbox SDK configuration vars;
 * it has no product bindings, project identity, or secrets. */
type WorkerBuilderSandboxEnv = Record<string, unknown>;

/**
 * The deployment's worker-builder pool: a FIXED, small fleet of stock
 * Cloudflare sandbox containers that run every dynamic-worker build
 * (cloudflare-sandbox-build-backend.ts), owned by the platform — deliberately
 * NOT project sandboxes.
 *
 * The per-project builder this replaces was an ordinary catalogued sandbox at
 * `/sandboxes/worker-builder`: it journaled lifecycle into project streams,
 * competed with pet sandboxes for the shared basic-instance caps, could be
 * destroyed (tombstoning its name) by the project's own users, and scaled
 * container demand with the number of BUILDING PROJECTS — fixture-heavy flows
 * (e2e) saturated the whole basic fleet with builders and starved every other
 * placement. A pool caps builder demand at WORKER_BUILDER_POOL_SIZE
 * containers per deployment, period (builder-pool.ts; the container app's
 * max_instances is pinned to it).
 *
 * Isolation model, explicit because it is WEAKER per-container than the pet
 * lane and stronger everywhere else:
 * - The recipe never executes project code: pnpm (or npm for an npm-locked
 *   source) installs with `--ignore-scripts`, and wrangler's dry-run bundles
 *   with esbuild, which parses sources but does not run them. Compromising a
 *   pool container requires escaping those parsers.
 * - No project secrets, tokens, or env vars ever enter a pool container; the
 *   only inputs are the build's source files and the pinned toolchain.
 * - Runtime-tier artifacts stay PROJECT-SCOPED in the cache key
 *   (build-key.ts) — a poisoned artifact write can still only serve the
 *   project whose build produced it, never the trusted seeded tier.
 * - Concurrent builds on one member use sessionless commands and separate
 *   `/build/<key>-<nonce>` trees (cloudflare-sandbox-build-backend.ts).
 *
 * Members are addressed by plain pool-slot names on a namespace no project
 * code can reach — there is no catalogue entry, no stream, no processor, no
 * create ceremony (the stock SDK boots the container on first use). The
 * namespace lives on a route-less builder sidecar and deliberately survives
 * preview-slot erase/handover; each build still uses a unique directory and
 * the containers sleep after the bounded warm period.
 */
export class WorkerBuilderDurableObject extends Sandbox<WorkerBuilderSandboxEnv> {
  // Long enough that a burst of builds reuses the warm toolchain (installed
  // in-container once per boot, see cloudflare-sandbox-build-backend.ts),
  // short enough that an idle deployment holds zero builder containers. The
  // pool is capacity-safe
  // at any value — max_instances equals the pool size — so this trades only
  // idle-container cost against toolchain-reinstall latency.
  //
  // No `interceptHttps` and no registered outbound handler: the containers
  // SDK then falls through to direct fetch, giving builders the plain
  // network path npm needs — build egress was never meaningfully
  // project-governed (projects default to allow-all), and with no project
  // identity there is no policy to consult.
  override sleepAfter: string | number = "300s";
  override labels = { app: "iterate-os", component: "worker-builder" };
}

/** One explicitly scheduled pool member as the stock SDK client. Disabling
 * the implicit default session is load-bearing: live preview inspection found
 * orphaned bash sessions and 102 zombie esbuild processes on one member after
 * canceled RPCs. Every operation now gets a fresh bounded process instead. */
export function getBuilderSandbox(
  namespace: DurableObjectNamespace<WorkerBuilderDurableObject>,
  member: string,
): WorkerBuilderDurableObject {
  return getSandbox(namespace, member, { enableDefaultSession: false });
}
