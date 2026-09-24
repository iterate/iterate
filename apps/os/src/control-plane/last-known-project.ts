// src/control-plane/last-known-project.ts — A PROJECT HOST'S ADMISSION, STALE-IF-ERROR: the
// project a host's label names, as the control plane answers it (edge.ts `getProject`, memoized per
// isolate) and, ONLY when that read fails on the platform's side (ControlPlaneUnavailableError), as
// this data center last knew it. On 2026-09-24 the `CONTROL_PLANE` singleton was unreachable for
// 188 s; a deploy landed inside the outage, its fresh isolates had no memo, and every project host
// failed. The last-known copy outlives isolates and deploys, so the next outage serves the hosts
// this data center has served before.
//
// WHERE THE COPY LIVES: the Cache API (https://developers.cloudflare.com/workers/runtime-apis/cache/),
// a namespaced cache (`caches.open`, apart from the zone's HTTP cache) keyed by the request's own
// origin and the label. It is local to the data center and the zone, survives isolates and deploys,
// costs nothing to write, has no per-key write limit and needs no new binding. KV, the one durable
// store the worker already binds, is the OAuth provider's (`OAUTH_KV`, oauth-store.ts) and takes one
// write per key per second, which every fresh isolate's first visit would race. The Cache API's
// limits, accepted: a data center that never served the host has no copy (it answers 503, as
// before), and an entry may be evicted before its TTL. The docs promise working operations on custom
// domains, which is where prd's project hosts are; a preview's workers.dev host is not promised, so
// the Workers tests prove the path.
//
// WHAT A STALE ANSWER CAN DO: admit a host whose project the control plane no longer holds. Today
// nothing removes or renames a project (catalog.ts has no such write; edge.ts memoizes a hit for an
// isolate's life for the same reason), so the one way is a deliberate production erase. A copy is
// never read while the control plane answers, so a new project, a new hostname and an unknown label
// (421) behave exactly as before. During an outage, a project removed after its copy was written
// still reaches its context by its id until the outage ends or the copy expires (TTL_SECONDS). A
// label the control plane never answered has no copy, so no context is ever created for it.
import { z } from "zod";
import { type ControlPlane, ControlPlaneUnavailableError } from "./edge.ts";
import type { ProjectRecord } from "./catalog.ts";

/** How long a copy may stand in: 24 hours. A copy is rewritten by every isolate's first visit to
 *  the host (a deploy starts fresh isolates, prd deploys several times a day), so a visited host's
 *  copy is hours old at most; a day keeps a host that is quiet overnight admissible through a morning
 *  outage, and bounds how long a removed project can still be routed during one. */
const TTL_SECONDS = 24 * 3600;

/** The copies this isolate has written: once per isolate and host, as the project memo reads once. */
const remembered = new Set<string>();

const LastKnownProject = z.object({
  project: z.object({ id: z.string(), slug: z.string(), orgId: z.string() }),
  rememberedAt: z.number(),
});

/** The project `ref` (a host's label) names, for a request on `origin`: the control plane's answer,
 *  whose first hit per isolate is kept as this data center's copy (off the response path); when the
 *  control plane fails the read, the copy, logged as `control-plane.platform-failure-stale-project`
 *  (scripts/ci/prd-fault-alarm.ts pages on a burst). With no copy it throws the
 *  ControlPlaneUnavailableError, for worker.ts to answer 503. */
export async function projectForHost(
  controlPlane: ControlPlane,
  ref: string,
  { origin, ctx }: { origin: string; ctx: Pick<ExecutionContext, "waitUntil"> },
): Promise<ProjectRecord | null> {
  const key = `${origin}/.iterate/last-known-project/${encodeURIComponent(ref)}`;
  try {
    const project = await controlPlane.getProject(ref);
    if (project && !remembered.has(key)) {
      remembered.add(key);
      ctx.waitUntil(
        caches
          .open("last-known-projects")
          .then((cache) =>
            cache.put(
              key,
              Response.json(
                { project, rememberedAt: Date.now() },
                { headers: { "cache-control": `max-age=${TTL_SECONDS}` } },
              ),
            ),
          ),
      );
    }
    return project;
  } catch (error) {
    if (!(error instanceof ControlPlaneUnavailableError)) throw error;
    const cached = await (await caches.open("last-known-projects")).match(key);
    // A copy an older version wrote in another shape is no copy.
    const copy = cached && LastKnownProject.safeParse(await cached.json()).data;
    if (!copy) throw error;
    console.warn({
      event: "control-plane.platform-failure-stale-project",
      name: ref,
      method: error.method,
      waitedMs: error.waitedMs,
      ageMs: Date.now() - copy.rememberedAt,
      message: error.message,
    });
    return copy.project;
  }
}
