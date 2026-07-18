// search-index.ts — the write side of `itx.search`: R2 corpus writers plus
// the per-project AI Search instance lifecycle.
//
// Everything a project accumulates — stream events, `itx.files` bytes, repo
// file contents, arbitrary `itx.search.index()` documents — is mirrored into
// one R2 bucket per deployment (`SEARCH_BUCKET`). Each PROJECT gets its own
// AI Search instance (created on first use in the deployment's
// `SEARCH_INSTANCES` namespace) indexing only that project's `{projectId}/**`
// slice of the bucket — Cloudflare's documented instance-per-tenant pattern
// (https://developers.cloudflare.com/ai-search/how-to/per-tenant-search/), so
// search tenancy is structural rather than a query filter. The pure corpus
// model (key layout, segment math, rendering, filters, instance config) lives
// in search-corpus.ts so Node scripts and unit tests can import it; this
// module owns everything that touches worker bindings.
//
// EVERY stream is indexed, including /integrations/** webhooks (duplicative —
// prd's iterate project holds ~15.5k GitHub webhooks — but full of real
// signal; an accepted embedding cost, bounded per event by payload
// truncation) and /secrets/** (safe: secret material on streams is encrypted
// at rest — events carry ciphertext, never plaintext values). Only EPHEMERAL
// events never reach the index: durable delivery doesn't carry them and the
// segment re-read uses the default `getEvents`, which excludes ephemeral rows.
//
// Automatic write paths enqueue authoritative-state pointers to the durable,
// globally bounded search-index queue: a failed index write never fails the
// append/file put/repo commit that triggered it, and bounded retries plus the
// dead-letter queue preserve an inspectable failure. Explicit index/backfill
// calls remain direct and report their own outcomes.
//
// LOCAL DEV runs against the real cloud service, not a local emulation: the
// AI Search bindings have no local simulator, so they always hit the account,
// and SEARCH_BUCKET is a remote binding in dev exactly like FILES_BUCKET.
// The deployment's namespace must exist (ensure-resources); instances are
// created per project at runtime.

import type { StreamEvent } from "iterate/processors";
import { itxEnv } from "../../env.ts";
import { ItxExpression } from "../../itx/expression.ts";
import {
  MAX_SEARCH_KEY_BYTES,
  fileRef,
  pinnedEventKey,
  renderPinnedEventDocument,
  repoFileRef,
  streamEventsRef,
  SEARCH_MAX_DOCUMENT_BYTES,
  SEARCH_SEGMENT_SIZE,
  fileSearchKey,
  normalizeCustomSearchKind,
  projectSearchInstanceConfig,
  projectSearchInstanceId,
  renderStreamSegmentDocument,
  repoFileSearchKey,
  sanitizeSearchDocumentId,
  searchMetadata,
  segmentForOffset,
  segmentOffsetRange,
  streamSegmentContext,
  streamSegmentKey,
} from "./search-corpus.ts";

/** The search-index corpus bucket name for this deployment (mirrors wrangler config). */
function searchBucketName(): string {
  return `${itxEnv.WORKER_SELF}-search-index`;
}

/**
 * The project's AI Search instance, created on first use. Instances live in
 * the deployment's namespace (the `SEARCH_INSTANCES` binding) and each indexes
 * only its project's `{projectId}/**` slice of the shared corpus bucket —
 * tenancy is structural, not a query filter. Creation is idempotent from the
 * caller's view: an already-exists error resolves to the existing instance.
 * A freshly created instance is EMPTY until its first sync job finishes;
 * callers surface that as a warning rather than an error.
 */
export async function ensureProjectSearchInstance(
  projectId: string,
): Promise<{ created: boolean; instance: AiSearchInstance }> {
  const id = projectSearchInstanceId(projectId);
  try {
    const instance = await itxEnv.SEARCH_INSTANCES.create(
      projectSearchInstanceConfig({ bucketName: searchBucketName(), projectId }),
    );
    return { created: true, instance };
  } catch (error) {
    // Already exists → get() it. Anything else is a real provisioning error.
    if (!/exist|conflict|duplicate/i.test(String(error))) throw error;
    return { created: false, instance: itxEnv.SEARCH_INSTANCES.get(id) };
  }
}

/**
 * Best-effort on-demand sync of a project's instance — called after explicit
 * backfill verbs so freshly written corpus objects become searchable in
 * seconds instead of waiting for the hourly schedule. The API allows one job
 * per 30s per instance; a rejected trigger (rate limit, instance mid-sync) is
 * fine — the hourly schedule is the backstop.
 */
export async function triggerProjectSearchSync(projectId: string): Promise<void> {
  try {
    await itxEnv.SEARCH_INSTANCES.get(projectSearchInstanceId(projectId)).jobs.create();
  } catch (error) {
    console.warn("search sync trigger skipped", { projectId, error: String(error).slice(0, 200) });
  }
}

/**
 * Debounced flavour for the AUTOMATIC write lanes (per-batch stream indexing,
 * file mirroring, repo commits): at most one trigger per project per interval
 * per isolate, so passive content becomes searchable in minutes instead of
 * waiting for the hourly schedule. Never creates instances — a project nobody
 * has ever searched keeps costing nothing. The namespace is listed before
 * taking an instance handle, so that expected no-instance state is a clean
 * no-op; once a first query/index creates the instance, the passive lanes keep
 * it fresh. Isolate-local state means restarts re-trigger early — harmless,
 * the jobs API itself rate-limits at one per 30s.
 */
const lastPassiveSyncTrigger = new Map<string, number>();
const PASSIVE_SYNC_DEBOUNCE_MS = 120_000;
export async function triggerProjectSearchSyncDebounced(projectId: string): Promise<void> {
  const last = lastPassiveSyncTrigger.get(projectId);
  const now = Date.now();
  if (last !== undefined && now - last < PASSIVE_SYNC_DEBOUNCE_MS) return;
  lastPassiveSyncTrigger.set(projectId, now);
  const id = projectSearchInstanceId(projectId);
  try {
    const { result } = await itxEnv.SEARCH_INSTANCES.list({
      per_page: 100,
      search: id,
    });
    if (!result.some((instance) => instance.id === id)) return;
  } catch (error) {
    // A failed control-plane lookup did not trigger anything, so it must not
    // consume the debounce window. Let the next passive write retry promptly.
    lastPassiveSyncTrigger.delete(projectId);
    console.warn("search sync instance lookup failed", {
      projectId,
      error: String(error).slice(0, 200),
    });
    return;
  }
  await triggerProjectSearchSync(projectId);
}

/**
 * Pin ONE stream event into the corpus as a focused document (the write side
 * of `itx.search.indexEvent`). The event already lives in its 100-offset
 * segment doc; pinning gives it a document of its own — sharper retrieval,
 * plus the caller's note indexed alongside — while the ref still leads back
 * to the real event coordinates. Idempotent per (stream, offset).
 */
export async function indexPinnedStreamEvent(input: {
  projectId: string;
  event: StreamEvent;
  note?: string;
}): Promise<{ key: string }> {
  const key = pinnedEventKey({
    projectId: input.projectId,
    streamPath: input.event.path,
    offset: input.event.offset,
  });
  await itxEnv.SEARCH_BUCKET.put(key, renderPinnedEventDocument(input), {
    httpMetadata: { contentType: "text/markdown" },
    customMetadata: searchMetadata(
      "streams",
      `Pinned event ${input.event.path} @ ${input.event.offset} (${input.event.type})`,
      streamEventsRef({
        path: input.event.path,
        firstOffset: input.event.offset,
        lastOffset: input.event.offset,
      }),
    ),
  });
  return { key };
}

/**
 * Rewrite complete fixed-size stream segments from durable state. Never index
 * only a delivered event batch: retries and arbitrary delivery boundaries
 * mean a later batch in the same segment must not overwrite earlier events.
 * Automatic callers enqueue touched segment numbers; the bounded consumer
 * supplies the authoritative Stream DO read.
 */
export async function indexStreamSegments(input: {
  projectId: string;
  path: string;
  segments: Iterable<number>;
  readEvents: (args: {
    afterOffset: number;
    beforeOffset: number;
    limit: number;
  }) => Promise<StreamEvent[]>;
}): Promise<void> {
  for (const segment of [...new Set(input.segments)].sort((left, right) => left - right)) {
    const { first, last } = segmentOffsetRange(segment);
    const events = await input.readEvents({
      afterOffset: first - 1,
      beforeOffset: last + 1,
      limit: SEARCH_SEGMENT_SIZE,
    });
    const document = renderStreamSegmentDocument({
      events,
      segment,
      streamPath: input.path,
    });
    const key = streamSegmentKey({
      projectId: input.projectId,
      streamPath: input.path,
      segment,
    });
    if (document === null) {
      // Append-only segments containing only housekeeping events never had a
      // document. R2 reports missing head/delete operations as native errors,
      // so the ordinary no-document case is simply a no-op.
      continue;
    }
    const { first: firstOffset, last: lastOffset } = segmentOffsetRange(segment);
    await itxEnv.SEARCH_BUCKET.put(key, document, {
      httpMetadata: { contentType: "text/markdown" },
      customMetadata: searchMetadata(
        "streams",
        streamSegmentContext({ streamPath: input.path, segment }),
        streamEventsRef({ path: input.path, firstOffset, lastOffset }),
      ),
    });
  }
}

/**
 * Re-index a whole stream from offset 0 — the explicit repair verb for the
 * one gap the best-effort per-batch indexing can leave: a segment that
 * went permanently quiet right after a failed write. Paginates the stream in
 * offset order and rewrites every segment document (grouping by segment
 * boundary, so gaps from ephemeral/disallow-listed offsets don't matter).
 * Idempotent: same events → same segment documents.
 */
function offsetRangeOf(segment: number): { firstOffset: number; lastOffset: number } {
  const { first, last } = segmentOffsetRange(segment);
  return { firstOffset: first, lastOffset: last };
}

export async function indexEntireStream(input: {
  projectId: string;
  path: string;
  readEvents: (args: {
    afterOffset: number;
    beforeOffset: number;
    limit: number;
  }) => Promise<StreamEvent[]>;
}): Promise<{ segments: number }> {
  let afterOffset = 0;
  let currentSegment = 0;
  let buffer: StreamEvent[] = [];
  let segments = 0;

  const flush = async () => {
    const document = renderStreamSegmentDocument({
      events: buffer,
      segment: currentSegment,
      streamPath: input.path,
    });
    buffer = [];
    if (document === null) return;
    await itxEnv.SEARCH_BUCKET.put(
      streamSegmentKey({
        projectId: input.projectId,
        streamPath: input.path,
        segment: currentSegment,
      }),
      document,
      {
        httpMetadata: { contentType: "text/markdown" },
        customMetadata: searchMetadata(
          "streams",
          streamSegmentContext({ streamPath: input.path, segment: currentSegment }),
          streamEventsRef({ path: input.path, ...offsetRangeOf(currentSegment) }),
        ),
      },
    );
    segments += 1;
  };

  while (true) {
    const page = await input.readEvents({
      afterOffset,
      beforeOffset: Number.MAX_SAFE_INTEGER,
      limit: SEARCH_SEGMENT_SIZE,
    });
    if (page.length === 0) break;
    for (const event of page) {
      const segment = segmentForOffset(event.offset);
      if (segment !== currentSegment) {
        await flush();
        currentSegment = segment;
      }
      buffer.push(event);
    }
    afterOffset = page[page.length - 1]!.offset;
  }
  await flush();
  return { segments };
}

/** Outcome of one file mirror, so backfill callers can report honest counts. */
type MirrorFileOutcome = "mirrored" | "skipped" | "failed";

/** Strict file reconciliation used by the durable search-index queue. */
export async function mirrorFileToSearchIndexStrict(input: {
  bytes: Uint8Array;
  contentType: string;
  path: string;
  projectId: string;
}): Promise<Exclude<MirrorFileOutcome, "failed">> {
  const key = fileSearchKey({ projectId: input.projectId, path: input.path });
  if (input.bytes.byteLength > SEARCH_MAX_DOCUMENT_BYTES) {
    await itxEnv.SEARCH_BUCKET.delete(key);
    return "skipped";
  }
  await itxEnv.SEARCH_BUCKET.put(key, input.bytes, {
    httpMetadata: { contentType: input.contentType },
    customMetadata: searchMetadata("files", `File ${input.path}`, fileRef(input.path)),
  });
  return "mirrored";
}

/**
 * Mirror one itx.files write into the search index. Raw bytes with the
 * original content type — AI Search converts rich formats (pdf, images,
 * docx, …) to markdown itself. Oversized files can't be indexed (AI Search
 * skips them too), so on a skip we also DELETE any prior index object for the
 * path — otherwise re-uploading a previously-indexed file above the cap would
 * leave the stale smaller version searchable. Best-effort: never throws — it
 * returns the outcome instead ("failed" on a swallowed error) so
 * `backfillFiles` can count what actually landed rather than assuming success.
 */
export async function mirrorFileToSearchIndex(input: {
  bytes: Uint8Array;
  contentType: string;
  path: string;
  projectId: string;
}): Promise<MirrorFileOutcome> {
  try {
    return await mirrorFileToSearchIndexStrict(input);
  } catch (error) {
    console.warn("search index file mirror failed", { path: input.path, error });
    return "failed";
  }
}

/** Strict removal used by the durable reconciliation queue. */
export async function removeFileFromSearchIndexStrict(input: {
  path: string;
  projectId: string;
}): Promise<void> {
  await itxEnv.SEARCH_BUCKET.delete(
    fileSearchKey({ projectId: input.projectId, path: input.path }),
  );
}

/** Remove one itx.files path from the search index. Best-effort: never throws. */
export async function removeFileFromSearchIndex(input: {
  path: string;
  projectId: string;
}): Promise<void> {
  try {
    await removeFileFromSearchIndexStrict(input);
  } catch (error) {
    console.warn("search index file removal failed", { path: input.path, error });
  }
}

/**
 * Index a repo's full file snapshot at HEAD: write every text file, then
 * delete index objects for files no longer in the snapshot (so deletions and
 * renames don't leave stale search results). Idempotent per snapshot.
 *
 * Per-file failures are contained: repo file paths come straight from git and
 * are the one unbounded key source (an over-long or hostile path must not
 * abort the remaining files or skip the sweep). A failed put keeps its key in
 * the live set so the sweep RETAINS any previous version — a stale-but-real
 * document beats a hole; the next snapshot retries.
 */
export async function indexRepoSnapshotToSearchIndex(input: {
  files: Record<string, string>;
  projectId: string;
  repoPath: string;
}): Promise<{ deleted: number; indexed: number; skipped: number; failed: number }> {
  const encoder = new TextEncoder();
  const live = new Set<string>();
  let indexed = 0;
  let skipped = 0;
  let failed = 0;

  for (const [filePath, content] of Object.entries(input.files)) {
    const key = repoFileSearchKey({
      projectId: input.projectId,
      repoPath: input.repoPath,
      filePath,
    });
    const bytes = encoder.encode(content);
    // A NUL byte marks content that was binary before the utf8 decode mangled
    // it; indexing the mangled text would only add noise.
    if (
      bytes.byteLength > SEARCH_MAX_DOCUMENT_BYTES ||
      content.includes("\u0000") ||
      encoder.encode(key).byteLength > MAX_SEARCH_KEY_BYTES
    ) {
      skipped += 1;
      continue;
    }
    try {
      await itxEnv.SEARCH_BUCKET.put(key, bytes, {
        httpMetadata: { contentType: "text/plain" },
        customMetadata: searchMetadata(
          "repos",
          `Repo ${input.repoPath} · ${filePath}`,
          repoFileRef({ repoPath: input.repoPath, filePath }),
        ),
      });
      indexed += 1;
    } catch (error) {
      console.warn("search index repo file failed", { key, error });
      failed += 1;
    }
    live.add(key);
  }

  // Sweep stale objects under this repo's prefix.
  let deleted = 0;
  const prefix = `${input.projectId}/repos${input.repoPath}/files/`;
  let cursor: string | undefined;
  do {
    const page = await itxEnv.SEARCH_BUCKET.list({ prefix, cursor, limit: 1000 });
    const stale = page.objects.map((object) => object.key).filter((key) => !live.has(key));
    if (stale.length > 0) {
      await itxEnv.SEARCH_BUCKET.delete(stale);
      deleted += stale.length;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);

  return { deleted, indexed, skipped, failed };
}

/**
 * Upsert one arbitrary document into the corpus — the primitive behind
 * `itx.search.index`. Any code that has content worth finding later writes it
 * here with a `kind` (for filtering), a `context` (shown in results and to
 * the answer model), and a REQUIRED `ref` — the itx expression leading back
 * to the domain object the text derives from, so a hit on this document is
 * never a dead end. Idempotent per `(projectId, kind, id)`: re-indexing the
 * same id overwrites. Returns the R2 key. Throws on reserved/invalid kinds
 * (see normalizeCustomSearchKind) and malformed refs.
 */
export async function indexDocument(input: {
  projectId: string;
  kind: string;
  id: string;
  text: string;
  ref: ItxExpression;
  title?: string;
  context?: string;
}): Promise<{ key: string }> {
  const kind = normalizeCustomSearchKind(input.kind);
  const id = sanitizeSearchDocumentId(input.id);
  const ref = ItxExpression.parse(input.ref);
  if (JSON.stringify(ref).length > 500) {
    throw new Error("ref expression too large (serialized cap: 500 chars)");
  }
  // AI Search decides indexability by file EXTENSION and silently skips
  // extension-less keys (live-verified: an extension-less notes doc never
  // became searchable), so the key must end in .md.
  const key = `${input.projectId}/${kind}/${id}${/\.[a-z0-9]{1,8}$/i.test(id) ? "" : ".md"}`;
  const body =
    input.title !== undefined && input.title.length > 0
      ? `# ${input.title}\n\n${input.text}`
      : input.text;
  const context = input.context ?? input.title ?? `${kind} ${id}`;
  await itxEnv.SEARCH_BUCKET.put(key, body, {
    httpMetadata: { contentType: "text/markdown" },
    customMetadata: searchMetadata(kind, context, ref),
  });
  return { key };
}
