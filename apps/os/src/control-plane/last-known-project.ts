// src/control-plane/last-known-project.ts — A PROJECT HOST'S ADMISSION, STALE-IF-ERROR: which
// project a request's host names and that project's catalog row, as the control plane answers
// (edge.ts: a project's own hostname is one read, memoized thirty seconds; the row is one read,
// memoized for the isolate's life) and, ONLY when a read fails on the platform's side
// (ControlPlaneUnavailableError) or has not answered in 3 s, as the control plane last wrote it
// down. On 2026-09-24 the `CONTROL_PLANE` singleton was unreachable for 188 s; a deploy landed
// inside the outage, its fresh isolates had no memo, and every project host failed.
//
// THE COPIES are `OAUTH_KV` entries the control plane's Durable Object writes when what they copy
// changes (durable-object.ts): a project's row under `last-known:project:<slug>` and `…:<id>` when
// it is created (a row never changes after), a hostname's `last-known:hostname:<hostname>` after it
// is claimed, deleted BEFORE it is released. So a removed or moved hostname keeps no copy its claim
// lost, and an erase empties the namespace with the rest (scripts/erase-data.ts). KV is global: a
// data center that never served a host has its copy too. A change reaches every reader within about
// 60 s (https://developers.cloudflare.com/kv/concepts/how-kv-works/), the window in which an outage
// right after a hostname moves can still serve its old project. Only the worker binds KV — a
// project's loaded code gets `ITX` alone (context/worker-loader.ts) — so a copy needs no signature.
import { z } from "zod";
import { customHostnameCandidatesOf } from "iterate/project-ingress";
import { type AppConfig, projectHostOf } from "../app-config.ts";
import { type ControlPlane, ControlPlaneUnavailableError } from "./edge.ts";

/** A copy's key in `OAUTH_KV`: a project's by its slug or id, a hostname's by the name claimed. */
export const lastKnownKey = (kind: "project" | "hostname", name: string) =>
  `last-known:${kind}:${name}`;

/** A project's catalog row, as the control plane wrote it (catalog.ts `ProjectRecord`). */
const ProjectRow = z.object({ id: z.string(), slug: z.string(), orgId: z.string() });

/**
 * The project host `url` is and its project's row, or null when `url` is no project host: the
 * static rules (app-config.ts `projectHostOf`, no read), else a hostname a project added itself,
 * then the row its label names (null: no such project, the 421). A copy stands in for a read that
 * fails on the platform's side or has not answered in 3 s — in prd the singleton answers in 23–30
 * ms at the median, 266 ms at p99, and its slowest of 14,622 calls on 2026-09-23/24 took 1.25 s.
 * With no copy the read is waited for: a slow answer is still the answer, and a failure is the
 * platform's own (12–15 s in that outage), thrown for worker.ts to answer 503. Once a read has
 * stood a copy in, the request's later reads try their copies first. `stale` says why and which
 * copies stood in, for worker.ts to log once; `stale.failure` is set when a read failed.
 */
export async function admitProjectHost(
  controlPlane: ControlPlane,
  input: { config: AppConfig; url: URL; platformOrigin: string; kv: KVNamespace },
) {
  const { config, url, platformOrigin, kv } = input;
  let stale:
    | { method: string; waitedMs: number; message: string; failure?: ControlPlaneUnavailableError }
    | undefined;
  /** The copies that stood in. */
  const copies: string[] = [];

  /** `read`'s answer, or `copy`'s stand-in (read at most once) when the control plane is down or slow. */
  const readOrCopy = async <T>(
    method: string,
    read: () => Promise<T | null>,
    copy: () => Promise<T | null>,
  ): Promise<T | null> => {
    let copied: Promise<T | null> | undefined;
    const standIn = () => (copied ||= copy());
    if (stale) {
      const value = await standIn();
      if (value) return value;
    }
    const started = Date.now();
    const reading = read();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const slow = new Promise<boolean>((resolve) => {
      timer = setTimeout(resolve, 3_000, true);
    });
    try {
      if (await Promise.race([reading.then(() => false), slow])) {
        const value = await standIn();
        if (value) {
          stale = {
            method,
            waitedMs: Date.now() - started,
            message: `The control plane did not answer ${method} within 3000 ms`,
          };
          return value;
        }
      }
      return await reading;
    } catch (error) {
      if (!(error instanceof ControlPlaneUnavailableError)) throw error;
      stale = { method, waitedMs: error.waitedMs, message: error.message, failure: error };
      const value = await standIn();
      if (!value) throw error;
      return value;
    } finally {
      clearTimeout(timer);
    }
  };

  /** The first of `keys` that holds a copy, in `ProjectRow`'s shape, and its index; null when none
   *  does. KV failing to answer for any of them is no copy (the caller's 503 stays a 503): a more
   *  specific key it could not read may hold the answer. */
  const firstCopy = async (keys: string[]) => {
    try {
      const rows = await Promise.all(
        keys.map(async (key) => ProjectRow.safeParse(await kv.get(key, "json")).data),
      );
      const index = rows.findIndex(Boolean);
      if (index < 0) return null;
      copies.push(keys[index]!);
      return { index, row: rows[index]! };
    } catch (error) {
      console.warn({
        event: "control-plane.last-known-copy-unread",
        name: url.hostname,
        keys,
        message: String(error),
      });
      return null;
    }
  };

  const address =
    projectHostOf(config, url, platformOrigin) ??
    (await readOrCopy(
      "projectByHostname",
      () => controlPlane.customHostOf(config, url, platformOrigin),
      async () => {
        // as the catalog reads it (catalog.ts `projectByHostname`): the first candidate held
        const candidates = customHostnameCandidatesOf(url.hostname);
        const found = await firstCopy(
          candidates.map((candidate) => lastKnownKey("hostname", candidate.hostname)),
        );
        if (!found) return null;
        const { routingSlug } = candidates[found.index]!;
        return { routingSlug, project: found.row.id, basePath: "" };
      },
    ));
  if (!address) return null;
  const project = await readOrCopy(
    "project",
    () => controlPlane.getProject(address.project),
    async () => (await firstCopy([lastKnownKey("project", address.project)]))?.row ?? null,
  );
  return { address, project, stale: stale && { ...stale, copies } };
}
