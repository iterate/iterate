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
// LOCAL DEV runs against the real cloud service, not a local emulation — no
// special-casing needed. Workers AI (env.AI, incl. `.autorag()`) has no local
// simulator, so it always hits the account
// (https://developers.cloudflare.com/workers-ai/ — "no local simulator"), and
// SEARCH_BUCKET is a remote binding in dev exactly like FILES_BUCKET, so `pnpm
// dev` writes the corpus to (and queries) the real `os-search-index` bucket /
// `os-search` instance on the preview+dev account. Deploying is only needed to
// create that instance; querying works from a dev worker.
//
// Bucket layout — the first key segment is always the owning project, the
// second is the KIND (which doubles as the `kind` metadata attribute and the
// folder-scoping token), so one prefix range scopes a query to a project and
// tightening it scopes to a kind:
//
//   {projectId}/streams{streamPath}/events-{segment}.md   rendered event segments
//   {projectId}/files{filePath}                           raw itx.files bytes (AI Search converts pdf/images/…)
//   {projectId}/repos{repoPath}/files{repoFilePath}       repo file contents at HEAD
//   {projectId}/{kind}/{id}                               anything else, via itx.search.index()
//
// Every object carries two custom metadata attributes (see SEARCH_METADATA_SCHEMA):
// `kind` (for include/exclude filtering) and `context` (a one-line source
// descriptor returned on every hit and shown to the answer model). `docs` is a
// federated kind — served from the in-worker itx.docs index at query time, not
// stored here.
//
// NOT everything is indexed: `/secrets/**` (leak) and `/integrations/**` (the
// provider webhook firehoses — ~15.5k near-duplicate GitHub webhooks in one prd
// stream) are excluded at the door (see shouldIndexStreamPath). Their signal
// still reaches the index derived — a repo sync reindexes the repo's files.
//
// Stream events are written as fixed 100-offset SEGMENT documents rather than
// one object per event: segment boundaries are deterministic functions of the
// offset, so re-delivery rewrites the same key (idempotent, self-healing) and
// the object count stays eventCount/100 per stream instead of eventCount —
// AI Search instances cap out at ~100k–1M files.
//
// The write paths are best-effort mirrors: a failed index write must never
// fail the user-facing operation that triggered it (append, file put, repo
// commit). Stream events are indexed as a first-party step on the project
// worker's ordered, checkpointed delivery (root `processEventBatch` →
// `#indexStreamSearch` in rpc-targets.ts), re-reading each touched segment so
// a transient failure self-heals on the next batch (see indexStreamEventBatch).

import { itxEnv } from "../../env.ts";
import type { StreamEvent } from "../streams/schemas.ts";
import type { StreamPushEventBatch } from "../streams/rpc-types.ts";

/** Offsets per stream-event segment document. */
export const SEARCH_SEGMENT_SIZE = 100;

/** AI Search skips files over 4 MB; don't bother writing them. */
const SEARCH_MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;

// Keep single events from bloating a segment document past the 4 MB indexing
// cap: payloads are for retrieval context, not archival (the stream is the
// source of truth), so large ones are truncated.
const MAX_EVENT_PAYLOAD_CHARS = 8_000;

/**
 * Event types that never reach the search index. Stream housekeeping facts:
 * high-volume, zero retrieval value, and `woken`/presence events would make
 * every idle stream churn its newest segment document forever.
 */
const SEARCH_EVENT_TYPE_DISALLOW_LIST: ReadonlySet<string> = new Set([
  "events.iterate.com/stream/woken",
  "events.iterate.com/stream/subscriber-connected",
  "events.iterate.com/stream/subscriber-disconnected",
  "events.iterate.com/stream/child-stream-created",
]);

/** The AI Search instance name for this deployment (one instance per env). */
export function searchInstanceName(): string {
  return `${itxEnv.WORKER_SELF}-search`;
}

/**
 * The kinds a project's search corpus is folded from. The first segment of
 * every R2 key IS the kind (`{projectId}/{kind}/…`), so it doubles as the
 * folder-scoping token AND the `kind` metadata attribute. `docs` is federated
 * from the in-worker itx.docs index rather than stored in R2 (see query()),
 * but shares the vocabulary so callers filter uniformly.
 */
export type SearchSourceKind = "streams" | "files" | "repos";
export type SearchKind = SearchSourceKind | "docs";

/**
 * Stream path prefixes that are NEVER indexed as documents:
 *
 * - `/secrets/**` — indexing secret values into a searchable corpus would be a
 *   data leak. Non-negotiable.
 * - `/integrations/**` — the raw provider webhook firehoses. In prd the
 *   `iterate` project's `/integrations/github/install-…` stream alone holds
 *   ~15.5k `github/webhook-received` events (a third over 20 KB, some 200 KB+),
 *   overwhelmingly near-duplicate CI/PR churn: the worst case for a vector
 *   index (embedding cost + retrieval pollution) for ~zero retrieval value.
 *   The SIGNAL in those webhooks reaches the index by another door — a repo
 *   sync reindexes the repo's files — so the firehose itself stays out.
 *
 * These streams still flow through the project worker and drive derived
 * indexing; they're just not themselves turned into searchable documents.
 */
const NON_INDEXED_STREAM_PREFIXES = ["/secrets", "/integrations"];

/** Whether a stream's events may be indexed as documents (see {@link NON_INDEXED_STREAM_PREFIXES}). */
export function shouldIndexStreamPath(path: string): boolean {
  return !NON_INDEXED_STREAM_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

/** Longest a `context` metadata value may be (AI Search caps text attributes at 500 chars). */
const MAX_CONTEXT_METADATA_CHARS = 500;

/**
 * The custom-metadata schema the AI Search instance must declare (≤5 fields
 * allowed). `folder`/`filename`/`timestamp` are built-in and cover
 * project+kind+path scoping and recency, so we only add:
 *
 * - `kind` — the document kind, for `$in`/`$ne` include/exclude at query time.
 * - `context` — a one-line human-readable source descriptor. AI Search's
 *   special `context` field is also attached to every chunk and passed to the
 *   generation model, so answers cite where a fact came from.
 *
 * ensure-resources.ts declares this when creating the instance; changing it
 * forces a full re-index, so it is deliberately minimal.
 */
export const SEARCH_METADATA_SCHEMA = [
  { field_name: "kind", data_type: "text" },
  { field_name: "context", data_type: "text" },
] as const;

/** Build the R2 `customMetadata` (→ `x-amz-meta-*` → AI Search attributes) for one document. */
function searchMetadata(kind: string, context: string): Record<string, string> {
  return { kind, context: context.slice(0, MAX_CONTEXT_METADATA_CHARS) };
}

/** One retrieved chunk: the matched index document plus its scored text and provenance. */
export type SearchResultChunk = {
  /** The index object key, e.g. `prj_x/streams/agents/…/events-00000001.md`. */
  filename: string;
  /** Relevance score in [0, 1]. */
  score: number;
  /** The matched text content (the specific matching chunk). */
  content: string;
  /** Which corpus this came from (`streams` | `files` | `repos` | `docs`). */
  kind?: string;
  /** One-line human-readable source descriptor, e.g. "Stream /agents/… events 101–200". */
  context?: string;
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

/** One-line source descriptor for a stream segment document (rides on every result). */
export function streamSegmentContext(input: { streamPath: string; segment: number }): string {
  const { first, last } = segmentOffsetRange(input.segment);
  return `Stream ${input.streamPath} — events ${first}–${last}`;
}

/** One-line source descriptor for an itx.files document. */
function fileContext(path: string): string {
  return `File ${path}`;
}

/** One-line source descriptor for a repo file document. */
function repoFileContext(input: { repoPath: string; filePath: string }): string {
  return `Repo ${input.repoPath} · ${input.filePath}`;
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
  if (!shouldIndexStreamPath(batch.path)) return;
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
    if (document === null) continue;
    const key = streamSegmentKey({
      projectId: batch.projectId,
      streamPath: batch.path,
      segment,
    });
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
  if (!shouldIndexStreamPath(input.path)) return { segments: 0 };
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
      // Can't index it; drop any stale prior entry so search never returns the
      // old version as if it were current.
      await itxEnv.SEARCH_BUCKET.delete(key);
      return "skipped";
    }
    await itxEnv.SEARCH_BUCKET.put(key, input.bytes, {
      httpMetadata: { contentType: input.contentType },
      customMetadata: searchMetadata("files", fileContext(input.path)),
    });
    return "mirrored";
  } catch (error) {
    console.error("search index file mirror failed", { path: input.path, error });
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
      customMetadata: searchMetadata(
        "repos",
        repoFileContext({ repoPath: input.repoPath, filePath }),
      ),
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
 * The AutoRAG metadata filter for a query. Always scopes to the calling
 * project via the documented lexicographic prefix range on the built-in
 * `folder` attribute (`folder >= "<prefix>" AND folder < "<prefix>￿"`), so no
 * query can ever see another project's data. Optionally tightens the prefix to
 * one `source` kind, and/or excludes kinds with `kind != …` — the query-time
 * escape hatch for noisy corpora. All conditions are a flat `and` (the legacy
 * binding's filter grammar is one level deep).
 */
export function searchFilters(input: {
  projectId: string;
  source?: SearchSourceKind;
  excludeKinds?: readonly SearchKind[];
}): { type: "and"; filters: { type: "gte" | "lt" | "ne"; key: string; value: string }[] } {
  const prefix = projectSearchPrefix(input.projectId, input.source);
  return {
    type: "and",
    filters: [
      { type: "gte", key: "folder", value: prefix },
      { type: "lt", key: "folder", value: `${prefix}￿` },
      ...(input.excludeKinds ?? []).map(
        (kind) => ({ type: "ne", key: "kind", value: kind }) as const,
      ),
    ],
  };
}

/** Sanitize a caller-supplied kind/id segment so it stays within the project prefix. */
function sanitizeKeySegment(segment: string): string {
  return segment
    .replace(/[^a-zA-Z0-9._/-]/g, "-")
    .replace(/\.\.+/g, ".")
    .replace(/^\/+/, "")
    .slice(0, 400);
}

/**
 * Upsert one arbitrary document into the corpus — the primitive behind
 * `itx.search.index`. Any code that has content worth finding later writes it
 * here with a `kind` (for filtering) and a `context` (shown in results and to
 * the answer model). Idempotent per `(projectId, kind, id)`: re-indexing the
 * same id overwrites. Returns the R2 key.
 */
export async function indexDocument(input: {
  projectId: string;
  kind: string;
  id: string;
  text: string;
  title?: string;
  context?: string;
}): Promise<{ key: string }> {
  const kind = sanitizeKeySegment(input.kind).toLowerCase() || "custom";
  const id = sanitizeKeySegment(input.id) || "untitled";
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
