/**
 * Project directory reads: slug -> project id, and small metadata records by
 * id. The auth worker is the source of truth (internal.project.bySlug, a
 * trusted service-token lookup); a KV cache in front of it makes the positive
 * case fast — ingress resolves EVERY project-host request through this, and
 * server-side reads use it for the stale-claims window right after create.
 *
 * Layering per lookup: KV first (global, no expiry — slugs are immutable,
 * create overwrites its keys, and admin-lane projects have no auth-side row
 * so the cache is their only directory), then the auth worker behind a
 * short in-isolate negative memo (the only place negatives are cached; it
 * shields the auth worker from lookup storms without ever hiding a KV
 * prime from another isolate). Hits are written back, and `projects.create`
 * primes the cache eagerly so the post-create navigation never misses.
 */
import { createAuthWorkerServiceClient } from "./auth/auth-worker-service.ts";
import type { AppConfig } from "./config.ts";

export type ProjectDirectoryRecord = {
  id: string;
  slug: string;
  organizationId: string | null;
  name: string;
};

const MEMO_TTL_MS = 15_000;

const slugMemo = new Map<string, { expiresAt: number; record: ProjectDirectoryRecord | null }>();

function slugKey(slug: string) {
  return `slug:${slug}`;
}

function projectKey(projectId: string) {
  return `project:${projectId}`;
}

/** Resolve a slug (or a `prj_` id, passed through) to a project id. */
export async function resolveProjectIdBySlug(input: {
  config: AppConfig;
  directory: KVNamespace;
  identifier: string;
}): Promise<string | null> {
  if (input.identifier.startsWith("prj_")) return input.identifier;
  const record = await readProjectBySlug(input.config, input.directory, input.identifier);
  return record?.id ?? null;
}

/** Directory record for a slug, cache-through. Null when no project has it. */
export async function readProjectBySlug(
  config: AppConfig,
  directory: KVNamespace,
  slug: string,
): Promise<ProjectDirectoryRecord | null> {
  const memoized = slugMemo.get(slug);
  if (memoized && memoized.expiresAt > Date.now()) return memoized.record;

  const cached = await directory
    .get<ProjectDirectoryRecord>(slugKey(slug), "json")
    .catch(() => null);
  if (cached) {
    memoize(slug, cached);
    return cached;
  }

  const lookup = await lookupAuthWorker(config, slug);
  if (!lookup.ok) {
    // Auth worker unreachable is NOT "no such project": don't memoize the
    // failure, so the next request retries instead of 404ing for 15s.
    return null;
  }
  memoize(slug, lookup.record);
  if (lookup.record) await writeThrough(directory, lookup.record);
  return lookup.record;
}

/** Fast existence/metadata check by project id (KV only — no auth fallback:
 * ids are primed at create and re-primed by every slug read). */
export async function readProjectById(
  directory: KVNamespace,
  projectId: string,
): Promise<ProjectDirectoryRecord | null> {
  return await directory
    .get<ProjectDirectoryRecord>(projectKey(projectId), "json")
    .catch(() => null);
}

/** Eagerly cache a project the caller just created or resolved. */
export async function primeProjectDirectory(
  directory: KVNamespace,
  record: ProjectDirectoryRecord,
): Promise<void> {
  memoize(record.slug, record);
  await writeThrough(directory, record).catch(() => {});
}

function memoize(slug: string, record: ProjectDirectoryRecord | null) {
  slugMemo.set(slug, { expiresAt: Date.now() + MEMO_TTL_MS, record });
}

async function writeThrough(directory: KVNamespace, record: ProjectDirectoryRecord) {
  // No expiration: slugs are immutable and `projects.create` overwrites the
  // keys it primes, so entries never go stale — and admin-lane projects
  // (auth mints only an id, no directory row) have NO auth fallback, so an
  // expiring cache would break their slug ingress after the TTL.
  const body = JSON.stringify(record);
  await Promise.all([
    directory.put(slugKey(record.slug), body),
    directory.put(projectKey(record.id), body),
  ]);
}

async function lookupAuthWorker(
  config: AppConfig,
  slug: string,
): Promise<{ ok: true; record: ProjectDirectoryRecord | null } | { ok: false }> {
  try {
    const record = await createAuthWorkerServiceClient({ config }).internal.project.bySlug({
      projectSlug: slug,
    });
    if (!record) return { ok: true, record: null };
    return {
      ok: true,
      record: {
        id: record.id,
        slug: record.slug,
        organizationId: record.organizationId ?? null,
        name: record.name,
      },
    };
  } catch {
    return { ok: false };
  }
}

/**
 * Custom-hostname resolution: `bla.com` set as a project's custom hostname
 * serves the project worker; `someapp.bla.com` serves it with that app
 * selected. Registrations live under `hostname:<host>` KV keys — written by
 * custom-hostname provisioning (task #13; until it lands the lane is wired
 * but nothing populates it). No auth-worker fallback yet: the directory has
 * no byHostname endpoint (also task #13).
 */
export async function readProjectByHostname(
  directory: KVNamespace,
  host: string,
): Promise<{ record: ProjectDirectoryRecord; appSlug: string | null } | null> {
  const exact = await directory
    .get<ProjectDirectoryRecord>(`hostname:${host}`, "json")
    .catch(() => null);
  if (exact) return { record: exact, appSlug: null };

  const dotIndex = host.indexOf(".");
  if (dotIndex <= 0) return null;
  const appSlug = host.slice(0, dotIndex);
  const parent = host.slice(dotIndex + 1);
  const parentRecord = await directory
    .get<ProjectDirectoryRecord>(`hostname:${parent}`, "json")
    .catch(() => null);
  if (parentRecord) return { record: parentRecord, appSlug };

  return null;
}
