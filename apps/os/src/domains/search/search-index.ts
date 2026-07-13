// search-index.ts — the R2 write side of `itx.search` (SPIKE).
//
// Everything a project accumulates — stream events, `itx.files` bytes, repo
// file contents, arbitrary `itx.search.index()` documents — is mirrored into
// one R2 bucket (`SEARCH_BUCKET`, `${WORKER_SELF}-search-index`) that a
// Cloudflare AI Search instance (`${WORKER_SELF}-search`) indexes on a
// schedule. The pure corpus model (key layout, segment math, rendering,
// filters, metadata schema) lives in search-corpus.ts so Node scripts and
// unit tests can import it; this module owns everything that touches the
// bucket binding.
//
// Multi-tenancy follows Cloudflare's documented shared-instance pattern:
// every key starts with the owning project id and queries filter on the
// built-in `folder` attribute with a lexicographic prefix range
// (https://developers.cloudflare.com/ai-search/how-to/per-tenant-search/).
//
// EVERY stream is indexed, including /integrations/** webhooks (duplicative —
// prd's iterate project holds ~15.5k GitHub webhooks — but full of real
// signal; an accepted embedding cost, bounded per event by payload
// truncation) and /secrets/** (safe: secret material on streams is encrypted
// at rest — events carry ciphertext, never plaintext values). Only EPHEMERAL
// events never reach the index: durable delivery doesn't carry them and the
// segment re-read uses the default `getEvents`, which excludes ephemeral rows.
//
// The write paths are best-effort mirrors: a failed index write must never
// fail the user-facing operation that triggered it (append, file put, repo
// commit). Failures log at warn — the corpus is derived and self-healing
// (see indexStreamEventBatch), never the system of record.
//
// LOCAL DEV runs against the real cloud service, not a local emulation:
// Workers AI (env.AI, incl. `.autorag()`) has no local simulator, so it
// always hits the account, and SEARCH_BUCKET is a remote binding in dev
// exactly like FILES_BUCKET. Deploying is only needed to create the
// instance; querying works from a dev worker.

import { itxEnv } from "../../env.ts";
import type { StreamEvent } from "../streams/schemas.ts";
import type { StreamPushEventBatch } from "../streams/rpc-types.ts";
import {
  MAX_SEARCH_KEY_BYTES,
  SEARCH_MAX_DOCUMENT_BYTES,
  SEARCH_SEGMENT_SIZE,
  fileSearchKey,
  normalizeCustomSearchKind,
  renderStreamSegmentDocument,
  repoFileSearchKey,
  sanitizeSearchDocumentId,
  searchMetadata,
  segmentForOffset,
  segmentOffsetRange,
  streamSegmentContext,
  streamSegmentKey,
} from "./search-corpus.ts";

/** The AI Search instance name for this deployment (one instance per env). */
export function searchInstanceName(): string {
  return `${itxEnv.WORKER_SELF}-search`;
}

/**
 * Index one delivered stream batch: rewrite every segment document the batch
 * touches. For each affected segment it re-reads the segment's FULL offset
 * range back from the stream (via `readEvents`) rather than indexing only the
 * batch's events, so the document is complete and the write is idempotent
 * regardless of how delivery batched the offsets.
 *
 * That full re-read is also what makes this safe to run as a first-party step
 * on the shared project-worker delivery (root `processEventBatch`) instead of
 * its own checkpointed lane: the delivery cursor advances on the worker's
 * success, not this side effect, so a transient R2 failure here is healed by
 * the NEXT batch in the same segment (which re-reads and rewrites the whole
 * segment). Only a segment that goes permanently quiet right after a failed
 * write stays short until `itx.search.indexStream`/reindex — acceptable for a
 * derived, rebuildable corpus.
 */
export async function indexStreamEventBatch(input: {
  batch: StreamPushEventBatch;
  /** Committed-event range read from the stream (bounds exclusive/exclusive, like the DO's getEvents). */
  readEvents: (args: {
    afterOffset: number;
    beforeOffset: number;
    limit: number;
  }) => Promise<StreamEvent[]>;
}): Promise<void> {
  const { batch } = input;
  if (batch.projectId === null) return;
  const offsets = batch.events.map((event) => event.offset);
  if (offsets.length === 0) return;

  const segments = new Set(offsets.map(segmentForOffset));
  for (const segment of segments) {
    const { first, last } = segmentOffsetRange(segment);
    const events = await input.readEvents({
      afterOffset: first - 1,
      beforeOffset: last + 1,
      limit: SEARCH_SEGMENT_SIZE,
    });
    const document = renderStreamSegmentDocument({
      events,
      segment,
      streamPath: batch.path,
    });
    const key = streamSegmentKey({
      projectId: batch.projectId,
      streamPath: batch.path,
      segment,
    });
    if (document === null) {
      // Nothing indexable in the segment (all housekeeping/ephemeral). Delete
      // rather than skip so a segment that RENDERED before but no longer does
      // (e.g. after a disallow-list change) self-heals instead of serving a
      // stale document forever.
      await itxEnv.SEARCH_BUCKET.delete(key);
      continue;
    }
    await itxEnv.SEARCH_BUCKET.put(key, document, {
      httpMetadata: { contentType: "text/markdown" },
      customMetadata: searchMetadata(
        "streams",
        streamSegmentContext({ streamPath: batch.path, segment }),
      ),
    });
  }
}

/**
 * Re-index a whole stream from offset 0 — the explicit repair verb for the
 * one gap the fire-and-forget per-batch indexing can leave: a segment that
 * went permanently quiet right after a failed write. Paginates the stream in
 * offset order and rewrites every segment document (grouping by segment
 * boundary, so gaps from ephemeral/disallow-listed offsets don't matter).
 * Idempotent: same events → same segment documents.
 */
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
  const key = fileSearchKey({ projectId: input.projectId, path: input.path });
  try {
    if (input.bytes.byteLength > SEARCH_MAX_DOCUMENT_BYTES) {
      await itxEnv.SEARCH_BUCKET.delete(key);
      return "skipped";
    }
    await itxEnv.SEARCH_BUCKET.put(key, input.bytes, {
      httpMetadata: { contentType: input.contentType },
      customMetadata: searchMetadata("files", `File ${input.path}`),
    });
    return "mirrored";
  } catch (error) {
    console.warn("search index file mirror failed", { path: input.path, error });
    return "failed";
  }
}

/** Remove one itx.files path from the search index. Best-effort: never throws. */
export async function removeFileFromSearchIndex(input: {
  path: string;
  projectId: string;
}): Promise<void> {
  try {
    await itxEnv.SEARCH_BUCKET.delete(
      fileSearchKey({ projectId: input.projectId, path: input.path }),
    );
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
        customMetadata: searchMetadata("repos", `Repo ${input.repoPath} · ${filePath}`),
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
 * here with a `kind` (for filtering) and a `context` (shown in results and to
 * the answer model). Idempotent per `(projectId, kind, id)`: re-indexing the
 * same id overwrites. Returns the R2 key. Throws on reserved/invalid kinds
 * (see normalizeCustomSearchKind).
 */
export async function indexDocument(input: {
  projectId: string;
  kind: string;
  id: string;
  text: string;
  title?: string;
  context?: string;
}): Promise<{ key: string }> {
  const kind = normalizeCustomSearchKind(input.kind);
  const id = sanitizeSearchDocumentId(input.id);
  const key = `${input.projectId}/${kind}/${id}`;
  const body =
    input.title !== undefined && input.title.length > 0
      ? `# ${input.title}\n\n${input.text}`
      : input.text;
  const context = input.context ?? input.title ?? `${kind} ${id}`;
  await itxEnv.SEARCH_BUCKET.put(key, body, {
    httpMetadata: { contentType: "text/markdown" },
    customMetadata: searchMetadata(kind, context),
  });
  return { key };
}
