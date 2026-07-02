/**
 * Project directory reads: slug -> project id, and small metadata records by
 * id. The auth worker is the source of truth (internal.project.bySlug, a
 * trusted service-token lookup); a KV cache in front of it makes the positive
 * case fast — ingress resolves EVERY project-host request through this, and
 * server-side reads use it for the stale-claims window right after create.
 *
 * Layering per lookup: an in-isolate memo (seconds; also the only place
 * negatives are cached — KV's 60s minimum TTL would make a pre-create probe
 * of a fresh slug 404 the create-then-navigate flow), then KV (positive
 * entries only, bounded TTL so a re-created slug can't go stale for long),
 * then the auth worker; hits are written back, and `projects.create` primes
 * the cache eagerly so the post-create navigation never misses.
 */
import { createAuthWorkerServiceClient } from "../auth/auth-worker-service.ts";
import type { AppConfig } from "../config.ts";

export type ProjectDirectoryRecord = {
  id: string;
  slug: string;
  organizationId: string | null;
  name: string;
};

const KV_POSITIVE_TTL_SECONDS = 3_600;
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

  const record = await lookupAuthWorker(config, slug);
  memoize(slug, record);
  if (record) await writeThrough(directory, record);
  return record;
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
  const body = JSON.stringify(record);
  await Promise.all([
    directory.put(slugKey(record.slug), body, { expirationTtl: KV_POSITIVE_TTL_SECONDS }),
    directory.put(projectKey(record.id), body, { expirationTtl: KV_POSITIVE_TTL_SECONDS }),
  ]);
}

async function lookupAuthWorker(
  config: AppConfig,
  slug: string,
): Promise<ProjectDirectoryRecord | null> {
  const record = await createAuthWorkerServiceClient({ config })
    .internal.project.bySlug({ projectSlug: slug })
    .catch(() => null);
  if (!record) return null;
  return {
    id: record.id,
    slug: record.slug,
    organizationId: record.organizationId ?? null,
    name: record.name,
  };
}
