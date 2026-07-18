/**
 * Project directory reads: slug -> project id, and small metadata records by
 * id. The auth worker is the source of truth through the private AUTH service
 * binding; a KV cache in front makes the positive case fast — ingress resolves
 * EVERY project-host request through this, and server-side reads use it for
 * the stale-claims window right after create.
 *
 * Layering per lookup: bounded KV cache first, then the auth worker behind a
 * short in-isolate memo. Auth owns every project row, including principal-less
 * admin fixtures; KV can never determine whether create succeeded, and stale
 * entries age out after at most one minute. Hits are written back, and
 * `projects.create` primes the cache opportunistically.
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
const CACHE_FILL_TIMEOUT_MS = 1_000;
const CACHE_ENTRY_TTL_SECONDS = 60;

const slugMemo = new Map<string, { expiresAt: number; record: ProjectDirectoryRecord | null }>();

function slugKey(slug: string) {
  return `slug:${slug}`;
}

function projectKey(projectId: string) {
  return `project:${projectId}`;
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
  if (memoized && memoized.expiresAt > Date.now()) return memoized.record;

  const cached = await directory
    .get<ProjectDirectoryRecord>(slugKey(slug), "json")
    .catch(() => null);
  if (cached) {
    memoize(slug, cached);
    return cached;
  }

  // RPC failures propagate as dependency failures. Only a successful null
  // response means "no such project" and is eligible for negative caching.
  const project = await itxEnv.AUTH.getProjectBySlug({ projectSlug: slug });
  const record = project ? toDirectoryRecord(project) : null;
  memoize(slug, record);
  if (record) {
    try {
      await writeDirectoryRecord(directory, record, CACHE_FILL_TIMEOUT_MS);
    } catch (error) {
      // Auth is authoritative for this lane. A cache-fill failure is a
      // bounded, observable degradation, not a reason to discard its answer.
      console.warn("[project-directory] cache fill failed; using auth result", {
        reason: errorMessage(error),
      });
    }
  }
  return record;
}

/** Directory record by project id, cache-through to authoritative auth. */
export async function readProjectById(
  directory: KVNamespace,
  projectId: string,
): Promise<ProjectDirectoryRecord | null> {
  const cached = await directory
    .get<ProjectDirectoryRecord>(projectKey(projectId), "json")
    .catch(() => null);
  if (cached) return cached;

  const project = await itxEnv.AUTH.getProjectById({ projectId });
  if (!project) return null;

  const record = toDirectoryRecord(project);
  memoize(record.slug, record);
  try {
    await writeDirectoryRecord(directory, record, CACHE_FILL_TIMEOUT_MS);
  } catch (error) {
    console.warn("[project-directory] cache fill failed; using auth result", {
      reason: errorMessage(error),
    });
  }
  return record;
}

/** Every auth-registered project, bounded for admin deployment listings. */
export async function listProjectDirectory({ limit = 1000 }: { limit?: number } = {}): Promise<
  ProjectDirectoryRecord[]
> {
  const projects = await itxEnv.AUTH.listProjects({ limit });
  return projects.map(toDirectoryRecord);
}

/** Best-effort cache fill after auth has durably registered a project. */
export async function primeProjectDirectory(
  directory: KVNamespace,
  record: ProjectDirectoryRecord,
): Promise<void> {
  memoize(record.slug, record);
  try {
    await writeDirectoryRecord(directory, record, CACHE_FILL_TIMEOUT_MS);
  } catch (error) {
    console.warn("[project-directory] cache prime failed; using auth registration", {
      reason: errorMessage(error),
    });
  }
}

function memoize(slug: string, record: ProjectDirectoryRecord | null) {
  slugMemo.set(slug, { expiresAt: Date.now() + MEMO_TTL_MS, record });
}

function toDirectoryRecord(project: ProjectDirectoryRecord): ProjectDirectoryRecord {
  return {
    id: project.id,
    slug: project.slug,
    organizationId: project.organizationId,
    name: project.name,
  };
}

async function writeDirectoryRecord(
  directory: KVNamespace,
  record: ProjectDirectoryRecord,
  timeoutMs: number,
): Promise<void> {
  const body = JSON.stringify(record);
  const write = Promise.all([
    directory.put(slugKey(record.slug), body, { expirationTtl: CACHE_ENTRY_TTL_SECONDS }),
    directory.put(projectKey(record.id), body, { expirationTtl: CACHE_ENTRY_TTL_SECONDS }),
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
