// src/control-plane/last-known-project.ts — A PROJECT HOST'S ADMISSION, STALE-IF-ERROR: which
// project a request's host names and that project's catalog row, as the control plane answers
// (edge.ts: a project's own hostname is one read, memoized thirty seconds; the row is one read,
// memoized for the isolate's life) and, ONLY when a read fails on the platform's side
// (ControlPlaneUnavailableError), as this data center last knew it. On 2026-09-24 the
// `CONTROL_PLANE` singleton was unreachable for 188 s; a deploy landed inside the outage, its fresh
// isolates had no memo, and every project host failed. A last-known copy outlives isolates and
// deploys, so the next outage serves the hosts this data center has served before.
//
// WHERE THE COPIES LIVE: the Cache API (https://developers.cloudflare.com/workers/runtime-apis/cache/),
// a namespaced cache (`caches.open`, apart from the zone's HTTP cache) keyed by the request's own
// origin and what was read (a hostname, a project's label). It is local to the data center and the
// zone, survives isolates and deploys, costs nothing to write, has no per-key write limit and needs
// no new binding. KV, the one durable store the worker already binds, is the OAuth provider's
// (`OAUTH_KV`, oauth-store.ts) and takes one write per key per second, which every fresh isolate's
// first visit would race. The Cache API's limits, accepted: a data center that never served the
// host has no copy (it answers 503, as before), and an entry may be evicted before its TTL. The
// docs promise working operations on custom domains, which is where prd's project hosts are; a
// preview's workers.dev host is not promised, so the Workers tests prove the path.
//
// WHAT A STALE ANSWER CAN DO: admit a host the control plane no longer routes to that project. No
// project is removed or renamed today (catalog.ts has no such write; edge.ts memoizes a hit for an
// isolate's life for the same reason), so the ways are a deliberate production erase and a project
// removing one of its own hostnames. A copy is never read while the control plane answers, so a new
// project, a new or removed hostname and an unknown label (421) behave exactly as before. During an
// outage, a hostname removed, or a project erased, after its copy was written still reaches that
// project's context until the outage ends or the copy expires (TTL_SECONDS). A host the control
// plane never answered has no copy, so no context is ever created for it.
import { z } from "zod";
import type { ProjectAddress } from "iterate/project-ingress";
import { type AppConfig, projectHostOf } from "../app-config.ts";
import { type ControlPlane, ControlPlaneUnavailableError } from "./edge.ts";

/** How long a copy may stand in: 24 hours. A copy is rewritten by every isolate's first visit to
 *  the host (a deploy starts fresh isolates, prd deploys several times a day), so a visited host's
 *  copy is hours old at most; a day keeps a host that is quiet overnight admissible through a morning
 *  outage, and bounds how long a removed hostname or project can still be admitted during one. */
const TTL_SECONDS = 24 * 3600;

/** The copies this isolate has written: once per isolate and key, as the memos read once. */
const remembered = new Set<string>();

/** The address a project's own hostname names (edge.ts `customHostOf`). */
const Address = z.object({
  project: z.string(),
  app: z.string().nullable(),
  basePath: z.string(),
}) satisfies z.ZodType<ProjectAddress>;
/** A project's catalog row (catalog.ts `ProjectRecord`, without a reader's role). */
const Project = z.object({ id: z.string(), slug: z.string(), orgId: z.string() });

/**
 * The project host `url` is and its project's row, or null when `url` is no project host: the
 * static rules (app-config.ts `projectHostOf`, no read), else a hostname a project added itself,
 * then the row its label names (null: no such project, the 421). Each read's first hit per isolate
 * is kept as this data center's copy, off the response path. When a read fails on the platform's
 * side its copy stands in, and the request's later reads try their copies first (a second bounded
 * wait would double the visitor's); logged once per request as
 * `control-plane.platform-failure-stale-project` (scripts/ci/prd-fault-alarm.ts pages on a burst).
 * With no copy it throws the ControlPlaneUnavailableError, for worker.ts to answer 503.
 */
export async function admitProjectHost(
  controlPlane: ControlPlane,
  input: {
    config: AppConfig;
    url: URL;
    platformOrigin: string;
    ctx: Pick<ExecutionContext, "waitUntil">;
  },
) {
  const { config, url, platformOrigin, ctx } = input;
  /** The read that failed on the platform's side, once one has: the control plane is down for
   *  this request. */
  let down: ControlPlaneUnavailableError | undefined;
  /** The copies that stood in, by what they answer. */
  const stoodIn: { what: string; ageMs: number }[] = [];
  /** `read`'s answer, remembered on a hit; once the control plane is down, its copy. */
  const readOrLastKnown = async <T>(
    what: string,
    read: () => Promise<T | null>,
    Copy: z.ZodType<T>,
  ): Promise<T | null> => {
    const key = `${url.origin}/.iterate/last-known/${what}`;
    const lastKnown = async () => {
      const cached = await (await caches.open("last-known-projects")).match(key);
      // A copy an older version wrote in another shape is no copy.
      const copy =
        cached &&
        z.object({ value: Copy, rememberedAt: z.number() }).safeParse(await cached.json()).data;
      if (copy) stoodIn.push({ what, ageMs: Date.now() - copy.rememberedAt });
      return copy;
    };
    const copy = down && (await lastKnown());
    if (copy) return copy.value;
    try {
      const value = await read();
      if (value && !remembered.has(key)) {
        remembered.add(key);
        ctx.waitUntil(
          caches
            .open("last-known-projects")
            .then((cache) =>
              cache.put(
                key,
                Response.json(
                  { value, rememberedAt: Date.now() },
                  { headers: { "cache-control": `max-age=${TTL_SECONDS}` } },
                ),
              ),
            ),
        );
      }
      return value;
    } catch (error) {
      if (!(error instanceof ControlPlaneUnavailableError)) throw error;
      down = error;
      const standIn = await lastKnown();
      if (!standIn) throw error;
      return standIn.value;
    }
  };

  const address =
    projectHostOf(config, url, platformOrigin) ??
    (await readOrLastKnown(
      `hostname/${url.hostname}`,
      () => controlPlane.customHostOf(config, url, platformOrigin),
      Address,
    ));
  if (!address) return null;
  const project = await readOrLastKnown(
    `project/${encodeURIComponent(address.project)}`,
    () => controlPlane.getProject(address.project),
    Project,
  );
  if (down)
    console.warn({
      event: "control-plane.platform-failure-stale-project",
      name: url.hostname,
      project: address.project,
      method: down.method,
      waitedMs: down.waitedMs,
      message: down.message,
      copies: stoodIn,
    });
  return { address, project };
}
