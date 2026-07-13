// search-corpus.ts — the pure model of the itx.search corpus: key layout,
// segment math, document rendering, metadata schema, and query filters.
//
// Runtime-neutral by design (no `cloudflare:workers`, no env): Node scripts
// (scripts/ensure-resources.ts declares SEARCH_METADATA_SCHEMA on the AI
// Search instance; scripts/deploy.ts imports ensure-resources) and unit tests
// import from here, while the R2 writers that need the worker env live in
// search-index.ts — the same split as files/file-url-signing.ts vs
// files/project-files.ts.
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

import type { StreamEvent } from "../streams/schemas.ts";

/** Offsets per stream-event segment document. */
export const SEARCH_SEGMENT_SIZE = 100;

/** AI Search skips files over 4 MB; don't bother writing them. */
export const SEARCH_MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;

/** R2 rejects keys over 1024 bytes; repo file paths are the one unbounded source. */
export const MAX_SEARCH_KEY_BYTES = 1024;

// Keep single events from bloating a segment document past the 4 MB indexing
// cap: payloads are for retrieval context, not archival (the stream is the
// source of truth), so large ones are truncated.
const MAX_EVENT_PAYLOAD_CHARS = 8_000;

/**
 * Event types that never reach the search index. Stream housekeeping facts:
 * high-volume, zero retrieval value, and `woken`/presence events would make
 * every idle stream churn its newest segment document forever. (Ephemeral
 * events are excluded upstream: durable delivery doesn't carry them and the
 * segment re-read uses the default `getEvents`, which skips ephemeral rows.)
 */
const SEARCH_EVENT_TYPE_DISALLOW_LIST: ReadonlySet<string> = new Set([
  "events.iterate.com/stream/woken",
  "events.iterate.com/stream/subscriber-connected",
  "events.iterate.com/stream/subscriber-disconnected",
  "events.iterate.com/stream/child-stream-created",
]);

/**
 * The kinds a project's search corpus is folded from. The first segment of
 * every R2 key IS the kind (`{projectId}/{kind}/…`), so it doubles as the
 * folder-scoping token AND the `kind` metadata attribute. `docs` is federated
 * from the in-worker itx.docs index rather than stored in R2 (see
 * SearchRpcTarget.query), but shares the vocabulary so callers filter
 * uniformly.
 */
export type SearchSourceKind = "streams" | "files" | "repos";

/** Every filterable kind: the stored corpus kinds plus the federated `docs`. */
export type SearchKind = SearchSourceKind | "docs";

/**
 * Kinds `itx.search.index()` must not write: the three platform namespaces
 * (their subtrees are owned by the platform writers — the repo indexer's
 * stale-key sweep would silently DELETE foreign objects under
 * `{prj}/repos/…`), and `docs` (a federated kind that never lives in R2, so a
 * stored impostor would bypass `exclude: ["docs"]`).
 */
const RESERVED_SEARCH_KINDS: ReadonlySet<string> = new Set(["streams", "files", "repos", "docs"]);

/** Longest a `context` metadata value may be (AI Search caps text attributes at 500 chars). */
const MAX_CONTEXT_METADATA_CHARS = 500;

/**
 * The custom-metadata schema the AI Search instance must declare (≤5 fields
 * allowed). `folder`/`filename`/`timestamp` are built-in and cover
 * project+kind+path scoping and recency, so we only add:
 *
 * - `kind` — the document kind, for `ne` include/exclude at query time.
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
export function searchMetadata(kind: string, context: string): Record<string, string> {
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
  /** Which corpus this came from (`streams` | `files` | `repos` | `docs` | a custom kind). */
  kind?: string;
  /** One-line human-readable source descriptor, e.g. "Stream /agents/… events 101–200". */
  context?: string;
};

/** What `itx.search.query` returns: the (possibly rewritten) query plus scored chunks. */
export type SearchQueryResult = {
  searchQuery: string;
  results: SearchResultChunk[];
  /**
   * Present when the AI Search corpus was unreachable (e.g. the instance is
   * not created yet) and only federated docs results are returned.
   */
  warning?: string;
};

/** What `itx.search.answer` returns: a generated answer plus the chunks it cited. */
export type SearchAnswerResult = SearchQueryResult & {
  response: string;
};

/** Root key prefix for one project (the multi-tenancy boundary), or one kind within it. */
export function projectSearchPrefix(projectId: string, source?: SearchSourceKind): string {
  // The trailing slash matters both times: without it, `prj/files` would also
  // match a custom kind like `prj/filesystem/…` in the folder range.
  return source === undefined ? `${projectId}/` : `${projectId}/${source}/`;
}

/** Object key for one stream's segment document (segment n covers the n-th SEARCH_SEGMENT_SIZE offsets). */
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
 * The AutoRAG metadata filter for a query. Always scopes to the calling
 * project via the documented lexicographic prefix range on the built-in
 * `folder` attribute — the upper bound is the prefix with its trailing `/`
 * bumped to `0` (the next ASCII character), Cloudflare's documented
 * "starts-with" trick — so no query can ever see another project's data.
 * Optionally tightens the prefix to one `source` kind, and/or excludes kinds
 * with `kind != …` — the query-time escape hatch for noisy corpora. All
 * conditions are a flat `and` (the legacy binding's filter grammar is one
 * level deep).
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
      { type: "lt", key: "folder", value: `${prefix.slice(0, -1)}0` },
      ...(input.excludeKinds ?? []).map(
        (kind) => ({ type: "ne", key: "kind", value: kind }) as const,
      ),
    ],
  };
}

/**
 * Validate + normalize a caller-supplied kind for `itx.search.index()`:
 * lowercase, `[a-z0-9._-]` only (no slashes — a slash would nest the document
 * under another kind's folder subtree), and never one of the reserved
 * platform kinds. Throws an informative error rather than silently rewriting,
 * because a rewritten kind would also silently change the `kind` filter value
 * callers must use to find their documents again.
 */
export function normalizeCustomSearchKind(kind: string): string {
  const normalized = kind.trim().toLowerCase();
  if (!/^[a-z0-9._-]+$/.test(normalized)) {
    throw new Error(
      `search kind ${JSON.stringify(kind)} must match [a-z0-9._-]+ (no slashes or spaces).`,
    );
  }
  if (RESERVED_SEARCH_KINDS.has(normalized)) {
    throw new Error(
      `search kind "${normalized}" is reserved for the platform corpus; pick another name ` +
        `(e.g. "notes", "tickets") — platform content is indexed automatically.`,
    );
  }
  return normalized;
}

/** Sanitize a caller-supplied document id so it stays within its kind's prefix. */
export function sanitizeSearchDocumentId(id: string): string {
  return (
    id
      .replace(/[^a-zA-Z0-9._/-]/g, "-")
      .replace(/\.\.+/g, ".")
      .replace(/^\/+/, "")
      .slice(0, 400) || "untitled"
  );
}
