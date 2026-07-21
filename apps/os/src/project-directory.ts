/**
 * Project directory reads: slug -> project id, and small metadata records by
 * id. The auth worker is the source of truth through the private AUTH service
 * binding; a KV cache in front makes the positive case fast — ingress resolves
 * EVERY project-host request through this, and server-side reads use it for
 * the stale-claims window right after create.
 *
 * Layering per lookup: KV first (global, no expiry — slugs are immutable,
 * create overwrites its keys, and admin-lane projects have no auth-side row
 * so the cache is their only directory), then the auth worker behind a
 * short in-isolate negative memo plus a bounded shared negative marker. The
 * positive KV key is ALWAYS checked first, and every authoritative positive
 * write also deletes an older miss marker. That shared marker matters for
 * canonical `<app>--<project>` hosts: the whole label is a legitimate
 * project-slug candidate, but its expected miss must not make each fresh
 * ingress isolate round-trip through the auth worker. Hits are written back,
 * and `projects.get(slug).create` primes the cache eagerly so post-create navigation
 * never misses.
 */
import { itxEnv } from "./env.ts";

export type ProjectDirectoryRecord = {
  id: string;
  slug: string;
  organizationId: string | null;
  name: string;
};

/**
 * What `itx.identity()` returns: the directory's canonical project record,
 * with the itx surface's `projectId` field name (the surface always says
 * `projectId`; `id` is the directory/list convention).
 */
export type ProjectIdentity = {
  projectId: string;
  slug: string;
  organizationId: string | null;
  name: string;
};

const MEMO_TTL_MS = 15_000;
// Cloudflare KV requires expirationTtl >= 60s. Reads check the separate
// positive `slug:` key first, and every positive cache write invalidates this
// marker; it exists only to suppress repeated authoritative misses.
const SHARED_NEGATIVE_TTL_SECONDS = 60;
const SHARED_NEGATIVE_MARKER = "missing";
// These writes are exact and idempotent. One retry absorbs a transient KV
// stall while two short windows keep this required create step bounded.
const REQUIRED_WRITE_ATTEMPT_TIMEOUT_MS = 10_000;
const REQUIRED_WRITE_MAX_ATTEMPTS = 2;
const CACHE_FILL_TIMEOUT_MS = 1_000;

const slugMemo = new Map<string, { expiresAt: number; record: ProjectDirectoryRecord | null }>();

function slugKey(slug: string) {
  return `slug:${slug}`;
}

function projectKey(projectId: string) {
  return `project:${projectId}`;
}

function missingSlugKey(slug: string) {
  return `missing-slug:${slug}`;
}

/** Resolve a slug (or a `prj_` id, passed through) to a project id. */
export async function resolveProjectIdBySlug(input: {
  directory: KVNamespace;
  identifier: string;
}): Promise<string | null> {
  if (input.identifier.startsWith("prj_")) return input.identifier;
  const record = await readProjectBySlug(input.directory, input.identifier);
  return record?.id ?? null;
}

/** Directory record for a slug, cache-through. Null when no project has it. */
export async function readProjectBySlug(
  directory: KVNamespace,
  slug: string,
): Promise<ProjectDirectoryRecord | null> {
  const memoized = slugMemo.get(slug);
  if (memoized && memoized.expiresAt > Date.now() && memoized.record !== null) {
    return memoized.record;
  }

  const cached = await directory
    .get<ProjectDirectoryRecord>(slugKey(slug), "json")
    .catch(() => null);
  if (cached) {
    memoize(slug, cached);
    return cached;
  }

  // Unlike a positive memo, an isolate-local negative never outranks KV: a
  // create in another isolate may have primed this slug since the miss.
  if (memoized && memoized.expiresAt > Date.now()) return null;

  // A positive record always outranks this marker. In particular, a project
  // created after an earlier miss becomes routable as soon as its ordinary KV
  // prime is visible; no stale negative entry can mask it.
  const sharedMiss = await directory.get(missingSlugKey(slug)).catch(() => null);
  if (sharedMiss === SHARED_NEGATIVE_MARKER) {
    memoize(slug, null);
    return null;
  }

  // RPC failures propagate as dependency failures. Only a successful null
  // response means "no such project" and is eligible for negative caching.
  const project = await itxEnv.AUTH.getProjectBySlug({ projectSlug: slug });
  const record = project
    ? {
        id: project.id,
        slug: project.slug,
        organizationId: project.organizationId,
        name: project.name,
      }
    : null;
  memoize(slug, record);
  if (record) {
    try {
      await writeThrough(directory, record, {
        attemptTimeoutMs: CACHE_FILL_TIMEOUT_MS,
        maxAttempts: 1,
      });
    } catch (error) {
      // Auth is authoritative for this lane. A cache-fill failure is a
      // bounded, observable degradation, not a reason to discard its answer.
      console.warn("[project-directory] cache fill failed; using auth result", {
        reason: errorMessage(error),
      });
    }
  } else {
    try {
      await directory.put(missingSlugKey(slug), SHARED_NEGATIVE_MARKER, {
        expirationTtl: SHARED_NEGATIVE_TTL_SECONDS,
      });
    } catch (error) {
      // Auth already supplied the authoritative answer. A failed optional
      // marker only means later isolates may repeat that lookup.
      console.warn("[project-directory] negative cache fill failed; using auth result", {
        reason: errorMessage(error),
      });
    }
  }
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

/**
 * Every deployment-known project record (`project:` keys), for admin listings.
 * KV `list` pages through cursors; values are fetched per page in parallel.
 * Capped — a deployment with more projects than the cap gets a truncated
 * admin list, not an unbounded KV scan.
 */
export async function listProjectDirectory(
  directory: KVNamespace,
  { limit = 1000 }: { limit?: number } = {},
): Promise<ProjectDirectoryRecord[]> {
  const records: ProjectDirectoryRecord[] = [];
  let cursor: string | undefined;
  while (records.length < limit) {
    const page = await directory.list({ prefix: "project:", cursor });
    const values = await Promise.all(
      page.keys
        .slice(0, limit - records.length)
        .map((key) => directory.get<ProjectDirectoryRecord>(key.name, "json").catch(() => null)),
    );
    for (const record of values) {
      if (record) records.push(record);
    }
    if (page.list_complete) break;
    cursor = page.cursor;
  }
  return records;
}

/** Eagerly cache a project the caller just created or resolved, invalidating
 * any shared miss that predates the authoritative positive record. */
export async function primeProjectDirectory(
  directory: KVNamespace,
  record: ProjectDirectoryRecord,
): Promise<void> {
  await writeThrough(directory, record, {
    attemptTimeoutMs: REQUIRED_WRITE_ATTEMPT_TIMEOUT_MS,
    maxAttempts: REQUIRED_WRITE_MAX_ATTEMPTS,
  });
  memoize(record.slug, record);
}

function memoize(slug: string, record: ProjectDirectoryRecord | null) {
  slugMemo.set(slug, { expiresAt: Date.now() + MEMO_TTL_MS, record });
}

async function writeThrough(
  directory: KVNamespace,
  record: ProjectDirectoryRecord,
  policy: { attemptTimeoutMs: number; maxAttempts: number },
) {
  // No expiration: slugs are immutable and `projects.get(slug).create` overwrites the
  // keys it primes, so entries never go stale — and admin-lane projects
  // (auth mints only an id, no directory row) have NO auth fallback, so an
  // expiring cache would break their slug ingress after the TTL. Clearing the
  // negative marker is part of the same required write attempt: a positive
  // prime must not leave a stale shared miss behind.
  const body = JSON.stringify(record);
  let lastError: unknown;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    try {
      await writeDirectoryRecord(directory, record, body, policy.attemptTimeoutMs);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < policy.maxAttempts) {
        console.warn("[project-directory] write failed; retrying", {
          attempt,
          maxAttempts: policy.maxAttempts,
          reason: errorMessage(error),
        });
      }
    }
  }

  throw new Error(
    `Project directory write failed after ${policy.maxAttempts} attempts: ${errorMessage(lastError)}`,
    { cause: lastError },
  );
}

async function writeDirectoryRecord(
  directory: KVNamespace,
  record: ProjectDirectoryRecord,
  body: string,
  timeoutMs: number,
): Promise<void> {
  const write = Promise.all([
    directory.put(slugKey(record.slug), body),
    directory.put(projectKey(record.id), body),
    directory.delete(missingSlugKey(record.slug)),
  ]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      write,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Project directory KV write timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    // Promise.race keeps rejection handlers attached to the write after a
    // timeout, so a late platform rejection remains observed.
    clearTimeout(timer);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
