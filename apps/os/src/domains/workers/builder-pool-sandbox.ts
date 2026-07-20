import { getSandbox, Sandbox } from "@cloudflare/sandbox";
import type { Env } from "../../env.ts";
import { builderPoolMember } from "./builder-pool.ts";

/**
 * The deployment's worker-builder pool: a FIXED, small fleet of stock
 * Cloudflare sandbox containers that run every dynamic-worker build
 * (build-backend.ts), owned by the platform — deliberately NOT project
 * sandboxes.
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
 * - The recipe never executes project code: `npm install --ignore-scripts`
 *   installs without running package scripts, and wrangler's dry-run bundles
 *   with esbuild, which parses sources but does not run them. Compromising a
 *   pool container requires escaping those parsers.
 * - No project secrets, tokens, or env vars ever enter a pool container; the
 *   only inputs are the build's source files and the pinned toolchain.
 * - Runtime-tier artifacts stay PROJECT-SCOPED in the cache key
 *   (build-key.ts) — a poisoned artifact write can still only serve the
 *   project whose build produced it, never the trusted seeded tier.
 * - Concurrent builds on one member run in separate exec sessions and
 *   separate `/build/<key>-<nonce>` trees (build-backend.ts).
 *
 * Members are addressed by plain pool-slot names on a namespace no project
 * code can reach — there is no catalogue entry, no stream, no processor, no
 * create ceremony (the stock SDK boots the container on first use), and
 * `erase-data` destroying the Durable Objects just means the next build
 * boots a fresh member.
 */
export class WorkerBuilderDurableObject extends Sandbox<Env> {
  // Long enough that a burst of builds reuses the warm toolchain (installed
  // in-container once per boot, see build-backend.ts), short enough that an
  // idle deployment holds zero builder containers. The pool is capacity-safe
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

/** The builder for a build key, as the stock SDK client. `attempt` > 0
 * addresses the failover member (next slot in ring order) when the key's own
 * member is sick — see builderPoolMember. */
export function getBuilderSandbox(
  namespace: DurableObjectNamespace<WorkerBuilderDurableObject>,
  buildKey: string,
  attempt = 0,
): WorkerBuilderDurableObject {
  return getSandbox(namespace, builderPoolMember(buildKey, attempt));
}
