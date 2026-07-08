// search-index.ts — the write side of `itx.search` (SPIKE).
//
// Everything a project accumulates — stream events, `itx.files` bytes, repo
// file contents — is mirrored into one R2 bucket (`SEARCH_BUCKET`,
// `${WORKER_SELF}-search-index`) that a Cloudflare AI Search instance
// (`${WORKER_SELF}-search`) indexes on a schedule. Multi-tenancy follows
// Cloudflare's documented shared-instance pattern: every object key starts
// with the owning project id, and queries filter on the built-in `folder`
// attribute with a lexicographic prefix range
// (https://developers.cloudflare.com/ai-search/how-to/per-tenant-search/).
//
// Bucket layout (one folder per source kind, so queries can scope to a kind
// by tightening the prefix):
//
//   {projectId}/streams{streamPath}/events-{segment}.md   rendered event segments
//   {projectId}/files{filePath}                           raw itx.files bytes (AI Search converts pdf/images/…)
//   {projectId}/repos{repoPath}/files{repoFilePath}       repo file contents at HEAD
//
// Stream events are written as fixed 100-offset SEGMENT documents rather than
// one object per event: segment boundaries are deterministic functions of the
// offset, so re-delivery rewrites the same key (idempotent, self-healing) and
// the object count stays eventCount/100 per stream instead of eventCount —
// AI Search instances cap out at ~100k–1M files.
//
// The write paths are best-effort mirrors: a failed index write must never
// fail the user-facing operation that triggered it (append, file put, repo
// commit). Stream delivery gets durability anyway via the stream-owned
// checkpoint (see StreamDurableObject's search-index ProjectWorkerDelivery).

import { itxEnv } from "../../env.ts";
import type { StreamEvent } from "../streams/schemas.ts";
import type { StreamEventBatch } from "../streams/rpc-types.ts";

/** Offsets per stream-event segment document. */
export const SEARCH_SEGMENT_SIZE = 100;

/** AI Search skips files over 4 MB; don't bother writing them. */
export const SEARCH_MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;

// Keep single events from bloating a segment document past the 4 MB indexing
// cap: payloads are for retrieval context, not archival (the stream is the
// source of truth), so large ones are truncated.
const MAX_EVENT_PAYLOAD_CHARS = 8_000;

/**
 * Event types that never reach the search index. Stream housekeeping facts:
 * high-volume, zero retrieval value, and `woken`/presence events would make
 * every idle stream churn its newest segment document forever.
 */
export const SEARCH_EVENT_TYPE_DISALLOW_LIST: ReadonlySet<string> = new Set([
  "events.iterate.com/stream/woken",
  "events.iterate.com/stream/subscriber-connected",
  "events.iterate.com/stream/subscriber-disconnected",
  "events.iterate.com/stream/child-stream-created",
]);

/** The AI Search instance name for this deployment (one instance per env). */
export function searchInstanceName(): string {
  return `${itxEnv.WORKER_SELF}-search`;
}

/** The search-index R2 bucket name for a worker (mirrors wrangler config). */
export function searchIndexBucketName(workerName: string): string {
  return `${workerName}-search-index`;
}

/** The source kinds a project's search corpus is folded from. */
export type SearchSourceKind = "streams" | "files" | "repos";

/** One retrieved chunk: the matched index document plus its scored text. */
export type SearchResultChunk = {
  /** The index object key, e.g. `prj_x/streams/agents/…/events-00000001.md`. */
  filename: string;
  /** Relevance score in [0, 1]. */
  score: number;
  /** The matched text content. */
  content: string;
};

/** What `itx.search.query` returns: the (possibly rewritten) query plus scored chunks. */
export type SearchQueryResult = {
  searchQuery: string;
  results: SearchResultChunk[];
};

/** What `itx.search.answer` returns: a generated answer plus the chunks it cited. */
export type SearchAnswerResult = SearchQueryResult & {
  response: string;
};

/** Root key prefix for one project (the multi-tenancy boundary). */
export function projectSearchPrefix(projectId: string, source?: SearchSourceKind): string {
  return source === undefined ? `${projectId}/` : `${projectId}/${source}`;
}

/** Object key for one stream's segment document. Segment n covers offsets n*100+1 … (n+1)*100. */
export function streamSegmentKey(input: {
  projectId: string;
  streamPath: string;
  segment: number;
}): string {
  const padded = String(input.segment).padStart(8, "0");
  return `${input.projectId}/streams${input.streamPath}/events-${padded}.md`;
}

/** Object key mirroring one itx.files path. */
export function fileSearchKey(input: { projectId: string; path: string }): string {
  return `${input.projectId}/files${input.path}`;
}

/** Object key mirroring one repo file at HEAD. */
export function repoFileSearchKey(input: {
  projectId: string;
  repoPath: string;
  filePath: string;
}): string {
  return `${input.projectId}/repos${input.repoPath}/files/${input.filePath}`;
}

/** The segment (0-based) an offset belongs to. Offset 1 → segment 0. */
export function segmentForOffset(offset: number): number {
  return Math.floor((offset - 1) / SEARCH_SEGMENT_SIZE);
}

/** Inclusive offset bounds of one segment. */
export function segmentOffsetRange(segment: number): { first: number; last: number } {
  return { first: segment * SEARCH_SEGMENT_SIZE + 1, last: (segment + 1) * SEARCH_SEGMENT_SIZE };
}

function renderEvent(event: StreamEvent): string {
  const payload = event.payload === undefined ? null : JSON.stringify(event.payload, null, 2);
  const truncated =
    payload !== null && payload.length > MAX_EVENT_PAYLOAD_CHARS
      ? `${payload.slice(0, MAX_EVENT_PAYLOAD_CHARS)}\n… (truncated)`
      : payload;
  const lines = [
    `## ${event.type} (offset ${event.offset})`,
    ``,
    `- stream: ${event.path}`,
    `- createdAt: ${event.createdAt}`,
  ];
  if (truncated !== null) lines.push(``, "```json", truncated, "```");
  return lines.join("\n");
}

/**
 * One stream segment rendered as a markdown document, or null when every
 * event in the segment is disallow-listed (nothing worth indexing).
 */
export function renderStreamSegmentDocument(input: {
  events: StreamEvent[];
  segment: number;
  streamPath: string;
}): string | null {
  const indexable = input.events.filter(
    (event) => !SEARCH_EVENT_TYPE_DISALLOW_LIST.has(event.type),
  );
  if (indexable.length === 0) return null;
  const { first, last } = segmentOffsetRange(input.segment);
  return [
    `# Stream ${input.streamPath} — events ${first}–${last}`,
    ``,
    ...indexable.map(renderEvent),
    ``,
  ].join("\n\n");
}

/**
 * Index one delivered stream batch: rewrite every segment document the batch
 * touches. Reads each affected segment's full offset range back from stream
 * storage (via the hook) so the document is complete and the write is
 * idempotent regardless of how delivery batched the offsets.
 */
export async function indexStreamEventBatch(input: {
  batch: StreamEventBatch;
  /** Committed-event range read from stream storage (bounds are exclusive/exclusive like getEvents). */
  readEvents: (args: { afterOffset: number; beforeOffset: number; limit: number }) => StreamEvent[];
}): Promise<void> {
  const { batch } = input;
  if (batch.projectId === null) return;
  const offsets = batch.events.map((event) => event.offset);
  if (offsets.length === 0) return;

  const segments = new Set(offsets.map(segmentForOffset));
  for (const segment of segments) {
    const { first, last } = segmentOffsetRange(segment);
    const events = input.readEvents({
      afterOffset: first - 1,
      beforeOffset: last + 1,
      limit: SEARCH_SEGMENT_SIZE,
    });
    const document = renderStreamSegmentDocument({
      events,
      segment,
      streamPath: batch.path,
    });
    if (document === null) continue;
    const key = streamSegmentKey({
      projectId: batch.projectId,
      streamPath: batch.path,
      segment,
    });
    await itxEnv.SEARCH_BUCKET.put(key, document, {
      httpMetadata: { contentType: "text/markdown" },
    });
  }
}

/**
 * Mirror one itx.files write into the search index. Raw bytes with the
 * original content type — AI Search converts rich formats (pdf, images,
 * docx, …) to markdown itself. Oversized files are skipped (AI Search would
 * skip them anyway). Best-effort: never throws.
 */
export async function mirrorFileToSearchIndex(input: {
  bytes: Uint8Array;
  contentType: string;
  path: string;
  projectId: string;
}): Promise<void> {
  try {
    if (input.bytes.byteLength > SEARCH_MAX_DOCUMENT_BYTES) return;
    await itxEnv.SEARCH_BUCKET.put(
      fileSearchKey({ projectId: input.projectId, path: input.path }),
      input.bytes,
      { httpMetadata: { contentType: input.contentType } },
    );
  } catch (error) {
    console.error("search index file mirror failed", { path: input.path, error });
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
    console.error("search index file removal failed", { path: input.path, error });
  }
}

/**
 * Index a repo's full file snapshot at HEAD: write every text file, then
 * delete index objects for files no longer in the snapshot (so deletions and
 * renames don't leave stale search results). Idempotent per snapshot.
 */
export async function indexRepoSnapshotToSearchIndex(input: {
  files: Record<string, string>;
  projectId: string;
  repoPath: string;
}): Promise<{ deleted: number; indexed: number; skipped: number }> {
  const encoder = new TextEncoder();
  const live = new Set<string>();
  let indexed = 0;
  let skipped = 0;

  for (const [filePath, content] of Object.entries(input.files)) {
    const key = repoFileSearchKey({
      projectId: input.projectId,
      repoPath: input.repoPath,
      filePath,
    });
    const bytes = encoder.encode(content);
    // A NUL byte marks content that was binary before the utf8 decode mangled
    // it; indexing the mangled text would only add noise.
    if (bytes.byteLength > SEARCH_MAX_DOCUMENT_BYTES || content.includes("\u0000")) {
      skipped += 1;
      continue;
    }
    live.add(key);
    await itxEnv.SEARCH_BUCKET.put(key, bytes, {
      httpMetadata: { contentType: "text/plain" },
    });
    indexed += 1;
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

  return { deleted, indexed, skipped };
}

/**
 * The AutoRAG metadata filter scoping a query to one project (optionally one
 * source kind), via the documented lexicographic prefix range on the built-in
 * `folder` attribute: `folder >= "<prefix>" AND folder < "<prefix>￿"`.
 */
export function projectSearchFilter(input: { projectId: string; source?: SearchSourceKind }): {
  type: "and";
  filters: { type: "gte" | "lt"; key: string; value: string }[];
} {
  const prefix = projectSearchPrefix(input.projectId, input.source);
  return {
    type: "and",
    filters: [
      { type: "gte", key: "folder", value: prefix },
      { type: "lt", key: "folder", value: `${prefix}￿` },
    ],
  };
}
