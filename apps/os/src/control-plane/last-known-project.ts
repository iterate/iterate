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
// a namespaced cache (`caches.open`, apart from the zone's HTTP cache), keyed on the platform's
// origin by what was read: `hostname/<host>` (a project's own hostname, lowercase, no trailing dot)
// or `project/<label>` (the label a host names). One key per label, so every host of a project in a
// zone (its apps, the apex, `docs.` beside `iterate.com`) shares one copy. The cache is local to the
// data center and the zone, survives isolates and deploys, costs nothing to write, has no per-key
// write limit and needs no new binding. KV, the one durable store the worker already binds, is the
// OAuth provider's (`OAUTH_KV`, oauth-store.ts) and takes one write per key per second, which every
// fresh isolate's first visit would race. The Cache API's limits, accepted: a data center that never
// served the host has no copy (it answers 503, as before), and an entry may be evicted before its
// TTL. The docs promise working operations on custom domains, which is where prd's project hosts
// are; a preview's workers.dev host is not promised, so the Workers tests prove the path, and each
// isolate reads its first copy back once and logs whether it was there
// (`control-plane.last-known-copy`).
//
// WHO CAN WRITE ONE: only this worker. A copy is the platform's own signed claims (caller.ts
// `signClaims`, under the session-signing secret) naming its key; one that fails the signature, names
// another key or has another shape is no copy. Project code runs in dynamic workers inside this
// worker's zone, and a copy it could forge would route a victim's host to its own project.
//
// WHAT A STALE ANSWER CAN DO: admit a host the control plane no longer routes to that project. A copy
// is never read while the control plane answers, so a new project, a new, moved or removed hostname
// and an unknown label (421) behave exactly as before. Each answer the control plane gives keeps its
// copy current: a changed answer is written at once, a null one deletes the copy, and an unchanged
// one is written again past half the TTL. What an outage can still get wrong is what changed in the
// window before it that this data center has not asked about since: a hostname moved to another
// project or removed, or a project erased (no project is renamed or removed otherwise; edge.ts
// memoizes a hit for an isolate's life for the same reason). Until the outage ends or the copy expires
// (TTL_SECONDS), that host still reaches its old project's context. A host the control plane never
// answered has no copy, so no context is ever created for it.
import { z } from "zod";
import type { ProjectAddress } from "iterate/project-ingress";
import { type AppConfig, projectHostOf, sessionSigningSecretOf } from "../app-config.ts";
import { signClaims, verifyClaims } from "../caller.ts";
import { type ControlPlane, ControlPlaneUnavailableError } from "./edge.ts";

/** How long a copy may stand in: 24 hours. A copy is written by every isolate's first visit to the
 *  host (a deploy starts fresh isolates, prd deploys several times a day) and again by any isolate
 *  holding it past half this, so a visited host's copy is hours old at most; a day keeps a host that
 *  is quiet overnight admissible through a morning outage, and bounds how long a moved or removed
 *  hostname, or an erased project, can still be admitted during one. */
const TTL_SECONDS = 24 * 3600;

/** The Cache API's namespace for the copies. */
const CACHE_NAME = "last-known-projects";

/** How many keys this isolate tracks: past it the oldest-written is forgotten, and at worst written
 *  again. A key per project label and per own hostname its visitors reach; unknown labels and
 *  wildcard hostnames are anyone's to invent. */
const REMEMBERED_MAX = 1_000;

/** What this isolate last wrote per key, oldest-written first: the answer as JSON (`null`: it
 *  deleted the copy) and when. */
const remembered = new Map<string, { json: string; at: number }>();

/** Whether this isolate has read a copy back after writing it: once per isolate. */
let readBack = false;

/** The address a project's own hostname names (edge.ts `customHostOf`). */
const Address = z.object({
  project: z.string(),
  routingSlug: z.string().nullable(),
  basePath: z.string(),
}) satisfies z.ZodType<ProjectAddress>;
/** A project's catalog row (catalog.ts `ProjectRecord`, without a reader's role). */
const Project = z.object({ id: z.string(), slug: z.string(), orgId: z.string() });

/** The signed claims a copy holds: this module's, for `key`, with `value` in the shape it reads. */
const copyOf = <T>(key: string, value: z.ZodType<T>) =>
  z.object({
    copy: z.literal("last-known-project"),
    key: z.literal(key),
    value,
    rememberedAt: z.number(),
  });

/**
 * The project host `url` is and its project's row, or null when `url` is no project host: the
 * static rules (app-config.ts `projectHostOf`, no read), else a hostname a project added itself,
 * then the row its label names (null: no such project, the 421). Each answer the control plane
 * gives keeps this data center's copy current, off the response path. When a read fails on the
 * platform's side its copy stands in, and the request's later reads try their copies first (a
 * second bounded wait would double the visitor's): `stale` names the failure and the copies, for
 * worker.ts to log once. With no copy it throws the ControlPlaneUnavailableError, for worker.ts to
 * answer 503.
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
  const secret = await sessionSigningSecretOf(config);
  /** The read that failed on the platform's side, once one has: the control plane is down for
   *  this request. */
  let down: ControlPlaneUnavailableError | undefined;
  /** The copies that stood in, by what they answer. */
  const copies: { what: string; ageMs: number }[] = [];

  /** `key`'s copy, verified and in `Value`'s shape, or null. A cache that fails to answer is no
   *  copy: the caller's 503 stays a 503. */
  const lastKnown = async <T>(what: string, key: string, Value: z.ZodType<T>) => {
    try {
      const cached = await (await caches.open(CACHE_NAME)).match(key);
      const claims = cached && (await verifyClaims(await cached.text(), secret));
      const copy = copyOf(key, Value).safeParse(claims).data;
      if (!copy) return null;
      copies.push({ what, ageMs: Date.now() - copy.rememberedAt });
      return copy;
    } catch (error) {
      console.warn({
        event: "control-plane.last-known-copy-unread",
        name: url.hostname,
        key,
        message: String(error),
      });
      return null;
    }
  };

  /** The control plane's answer for `key`, as this data center's copy (a null answer deletes it),
   *  off the response path: when it differs from what this isolate last wrote, or that is past half
   *  the TTL. A write that fails is logged and forgotten, so the next answer tries again. */
  const remember = (key: string, value: unknown) => {
    const json = JSON.stringify(value);
    const last = remembered.get(key);
    if (last?.json === json && Date.now() - last.at < (TTL_SECONDS * 1000) / 2) return;
    remembered.delete(key); // set again below: the Map's order is oldest-written first
    remembered.set(key, { json, at: Date.now() });
    if (remembered.size > REMEMBERED_MAX) {
      const [oldest] = remembered.keys();
      if (oldest) remembered.delete(oldest);
    }
    const write = async () => {
      const cache = await caches.open(CACHE_NAME);
      if (value === null) {
        await cache.delete(key);
        return;
      }
      const claims = { copy: "last-known-project", key, value, rememberedAt: Date.now() };
      await cache.put(
        key,
        new Response(await signClaims(claims, secret), {
          headers: { "cache-control": `max-age=${TTL_SECONDS}` },
        }),
      );
      if (readBack) return;
      readBack = true;
      // `put` resolves whether or not the cache stored anything (the docs above): this isolate's
      // first copy, read back, is the evidence the path works on this zone
      console.log({
        event: "control-plane.last-known-copy",
        name: url.hostname,
        key,
        readBack: Boolean(await cache.match(key)),
      });
    };
    ctx.waitUntil(
      write().catch((error: unknown) => {
        remembered.delete(key);
        console.warn({
          event: "control-plane.last-known-copy-unwritten",
          name: url.hostname,
          key,
          message: String(error),
        });
      }),
    );
  };

  /** `read`'s answer, remembered; once the control plane is down, its copy. */
  const readOrLastKnown = async <T>(
    what: string,
    read: () => Promise<T | null>,
    Value: z.ZodType<T>,
  ): Promise<T | null> => {
    const key = `${platformOrigin}/.iterate/last-known/${what}`;
    const copy = down && (await lastKnown(what, key, Value));
    if (copy) return copy.value;
    try {
      const value = await read();
      remember(key, value);
      return value;
    } catch (error) {
      if (!(error instanceof ControlPlaneUnavailableError)) throw error;
      down = error;
      const standIn = await lastKnown(what, key, Value);
      if (!standIn) throw error;
      return standIn.value;
    }
  };

  const address =
    projectHostOf(config, url, platformOrigin) ??
    (await readOrLastKnown(
      `hostname/${url.hostname.replace(/\.$/, "")}`,
      () => controlPlane.customHostOf(config, url, platformOrigin),
      Address,
    ));
  if (!address) return null;
  const project = await readOrLastKnown(
    `project/${encodeURIComponent(address.project)}`,
    () => controlPlane.getProject(address.project),
    Project,
  );
  return { address, project, stale: down && { error: down, copies } };
}
