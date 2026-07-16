// search-corpus.ts — the pure model of the itx.search corpus: key layout,
// segment math, document rendering, metadata schema, and query filters.
//
// Runtime-neutral by design (no `cloudflare:workers`, no env): unit tests and
// Node scripts import from here, while the R2 writers and instance lifecycle
// that need the worker env live in search-index.ts — the same split as
// files/file-url-signing.ts vs files/project-files.ts.
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

import type { StreamEvent } from "iterate/stream-events";
import type { ItxExpression } from "../../itx/expression.ts";

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

// The kinds a project's search corpus is folded from: `streams`, `files`,
// `repos`, plus arbitrary custom kinds written by itx.search.index(). The
// first segment of every R2 key IS the kind (`{projectId}/{kind}/…`), so it
// doubles as the folder-scoping token AND the `kind` metadata attribute.
// `docs` is federated at query time from the deployment-level docs index
// (see SearchRpcTarget.query), never stored in any PROJECT corpus, but shares
// the vocabulary so callers filter uniformly. Kinds are plain strings on the
// API surface (custom kinds made a closed union wrong); normalizeSearchSource
// is the validation gate.

/**
 * Kinds `itx.search.index()` must not write: the three platform namespaces
 * (their subtrees are owned by the platform writers — the repo indexer's
 * stale-key sweep would silently DELETE foreign objects under
 * `{prj}/repos/…`), and `docs` (federated at query time, never stored in a
 * project corpus — a stored impostor would bypass `exclude: ["docs"]`).
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
 * - `ref` — the serialized itx expression leading back to the domain object
 *   (see {@link searchMetadata}); what makes every hit resolvable.
 *
 * projectSearchInstanceConfig declares this at instance creation; changing it
 * forces a full re-index, so it is deliberately minimal.
 */
const SEARCH_METADATA_SCHEMA = [
  { field_name: "kind", data_type: "text" },
  { field_name: "context", data_type: "text" },
  { field_name: "ref", data_type: "text" },
] as const;

/**
 * Build the R2 `customMetadata` (→ `x-amz-meta-*` → AI Search attributes) for
 * one document. EVERY corpus document carries a `ref` — the serialized itx
 * expression leading back to the domain object it mirrors — so every search
 * hit is resolvable. A ref that would overflow the 500-char metadata value
 * cap is omitted (hit still returns, just without the shortcut) rather than
 * truncated into corrupt JSON.
 */
export function searchMetadata(
  kind: string,
  context: string,
  ref: ItxExpression,
): Record<string, string> {
  const metadata: Record<string, string> = {
    kind,
    context: context.slice(0, MAX_CONTEXT_METADATA_CHARS),
  };
  const serialized = JSON.stringify(ref);
  if (serialized.length <= MAX_CONTEXT_METADATA_CHARS) metadata.ref = serialized;
  return metadata;
}

/** One retrieved chunk: the matched index document plus its scored text and provenance. */
export type SearchResultChunk = {
  /**
   * The internal corpus key this chunk came from (diagnostic; for federated
   * docs hits it holds the docs.get fetchCall instead). Use `ref` — not this
   * — to fetch the source.
   */
  filename: string;
  /**
   * Relevance in [0, 1] for corpus hits. `kind: "docs"` hits carry synthetic
   * scores in a descending band from 0.5 — not comparable to corpus
   * relevance.
   */
  score: number;
  /**
   * A SHORT snippet around the matching text (~2 sentences). Judge relevance
   * here; evaluate `ref` for the whole thing.
   */
  content: string;
  /** When the source object was last written (ISO), where the index knows. */
  date?: string;
  /** Which corpus this came from (`streams` | `files` | `repos` | `docs` | a custom kind). */
  kind?: string;
  /** One-line human-readable source descriptor, e.g. "Stream /agents/… events 101–200". */
  context?: string;
  /**
   * The itx expression that leads back to the DOMAIN OBJECT this hit mirrors
   * — evaluate it against the project itx to fetch the real thing instead of
   * trusting chunk text. E.g. `["streams", ["get", "/agents/x"],
   * ["getEvents", { afterOffset: 100, beforeOffset: 201 }]]` for a stream
   * segment, `["files", ["get", "/reports/q3.pdf"]]` for a file, `["repos",
   * ["get", "/repos/config"], ["readFile", { path: "worker.ts" }]]` for a
   * repo file, `["docs", ["get", { name }]]` for a docs entry.
   */
  ref?: ItxExpression;
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
export function projectSearchPrefix(projectId: string, source?: string): string {
  // The trailing slash matters both times: without it, `prj/files` would also
  // match a custom kind like `prj/filesystem/…` in the folder range.
  return source === undefined ? `${projectId}/` : `${projectId}/${source}/`;
}

/**
 * Validate a caller-supplied `source` for query scoping: case-insensitive — a
 * platform corpus kind passes through normalized, a custom kind is normalized
 * by the same rules `index()` applied when writing it. `docs` gets its own
 * error — it is federated, never stored, so it cannot be a folder scope.
 */
export function normalizeSearchSource(source: string): string {
  const normalized = source.trim().toLowerCase();
  if (normalized === "docs") {
    throw new Error(
      'source "docs" cannot be pinned: docs are federated at query time, not stored in the ' +
        "corpus. Query without `source` (docs merge in automatically) or use itx.docs.search.",
    );
  }
  if ((["streams", "files", "repos"] as const).some((kind) => kind === normalized)) {
    return normalized;
  }
  return normalizeCustomSearchKind(normalized);
}

/**
 * Normalize `exclude` entries the same way kinds are stored (trim/lowercase),
 * so `["Docs", " Decisions"]` excludes what `docs` and `decisions` would.
 * No reserved-kind validation: excluding a platform kind is legitimate, and a
 * nonexistent kind in a `$nin` list just matches nothing.
 */
export function normalizeSearchExcludeKinds(kinds: readonly string[]): string[] {
  return kinds.map((kind) => kind.trim().toLowerCase());
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

/**
 * Object key for one PINNED stream event (`itx.search.indexEvent`): a focused
 * single-event document, distinct from the bulk `events-` segment docs so a
 * pinned event isn't buried among 99 neighbors. Lives under the `streams`
 * kind so source scoping and refs treat it as stream content.
 */
export function pinnedEventKey(input: {
  projectId: string;
  streamPath: string;
  offset: number;
}): string {
  return `${input.projectId}/streams${input.streamPath}/event-${String(input.offset).padStart(8, "0")}.md`;
}

/** The ref expression for a stream offset window — evaluates to the events themselves. */
export function streamEventsRef(input: {
  path: string;
  firstOffset: number;
  lastOffset: number;
}): ItxExpression {
  return [
    "streams",
    ["get", input.path],
    ["getEvents", { afterOffset: input.firstOffset - 1, beforeOffset: input.lastOffset + 1 }],
  ];
}

/**
 * Narrow a stream hit's ref to the EXACT events present in the retrieved
 * chunk. Segment documents batch 100 offsets for storage economics, but the
 * renderer stamps every event with a `## <type> (offset N)` header, so the
 * chunk that comes back names its own events — a hit on "the secret is
 * bananas" refs THAT message (and its chunk-mates), never "somewhere within
 * 100 events". Falls back to the stored document-level ref when a chunk
 * carries no headers (a rare mid-payload split).
 */
export function narrowStreamRefToChunk(storedRef: ItxExpression, chunkText: string): ItxExpression {
  // Shape check: ["streams", ["get", path], ...] — anything else passes through.
  const getStep = storedRef[1];
  if (
    storedRef[0] !== "streams" ||
    !Array.isArray(getStep) ||
    getStep[0] !== "get" ||
    typeof getStep[1] !== "string"
  ) {
    return storedRef;
  }
  const offsets = [...chunkText.matchAll(/^## \S+ \(offset (\d+)\)$/gm)].map((m) => Number(m[1]));
  if (offsets.length === 0) return storedRef;
  return streamEventsRef({
    path: getStep[1],
    firstOffset: Math.min(...offsets),
    lastOffset: Math.max(...offsets),
  });
}

/**
 * A short window of `text` centered on the most DISTINCTIVE query-term match
 * — the "matching couple of sentences" a result row shows. Distinctive =
 * rarest in this text (frequent terms like "slack"/"message" appear in every
 * stream header and would drag the window to boilerplate; the term that
 * appears once is the one the searcher meant), ties broken by term length.
 * No term found = the head of the text. Boundaries snap to whitespace,
 * ellipses mark the cuts.
 */
export function extractMatchSnippet(text: string, query: string, maxChars: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= maxChars) return flat;
  const terms = [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9_-]+/)
        .filter((term) => term.length >= 3),
    ),
  ];
  const lower = flat.toLowerCase();
  // Whole-token matches only ("app" must not center the window on "happy" or
  // "offset"); a term that never appears as a whole token falls back to a
  // substring hit — better an approximate center than the document head.
  let at = -1;
  let bestRarity = Infinity;
  let bestLength = 0;
  let substringFallback = -1;
  for (const term of terms) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const wordPattern = new RegExp(`(?<![a-z0-9_-])${escaped}(?![a-z0-9_-])`, "g");
    let first = -1;
    let count = 0;
    for (const match of lower.matchAll(wordPattern)) {
      if (first === -1) first = match.index;
      if (++count >= 50) break;
    }
    if (first === -1) {
      const loose = lower.indexOf(term);
      if (loose !== -1 && substringFallback === -1) substringFallback = loose;
      continue;
    }
    if (count < bestRarity || (count === bestRarity && term.length > bestLength)) {
      bestRarity = count;
      bestLength = term.length;
      at = first;
    }
  }
  if (at === -1) at = substringFallback;
  if (at === -1) return `${flat.slice(0, maxChars)}…`;
  let start = Math.max(0, at - Math.floor(maxChars / 2));
  // Snap forward to a word start ONLY when mid-word: at position 0 or just
  // after a space there is nothing to trim, and advancing would drop a whole
  // word (and stamp a phantom leading ellipsis on head-of-document matches).
  if (start > 0 && flat[start - 1] !== " ") {
    const spaceBefore = flat.indexOf(" ", start);
    if (spaceBefore !== -1 && spaceBefore < at) start = spaceBefore + 1;
  }
  const end = Math.min(flat.length, start + maxChars);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

/** The ref expression for an itx.files path — evaluates to the file handle. */
export function fileRef(path: string): ItxExpression {
  return ["files", ["get", path]];
}

/** The ref expression for a repo file at HEAD — evaluates to `{ commitOid, content, path }`. */
export function repoFileRef(input: { repoPath: string; filePath: string }): ItxExpression {
  return ["repos", ["get", input.repoPath], ["readFile", { path: input.filePath }]];
}

/**
 * One pinned event rendered as a focused markdown document: the event body
 * plus the caller's note, so the annotation is searchable alongside the
 * content it annotates.
 */
export function renderPinnedEventDocument(input: { event: StreamEvent; note?: string }): string {
  const lines = [
    `# Pinned event: ${input.event.type} — ${input.event.path} @ ${input.event.offset}`,
    ``,
  ];
  if (input.note !== undefined && input.note.length > 0) lines.push(`> ${input.note}`, ``);
  lines.push(renderEvent(input.event), ``);
  return lines.join("\n");
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
 * The metadata filter for a query (the new AI Search binding's Mongo-style
 * grammar; keys are implicit AND). Tenancy is STRUCTURAL — each project has
 * its own instance whose R2 source is glob-scoped to `{projectId}/**` — so
 * query filters only ever scope KINDS within one project's corpus.
 *
 * Everything filters on the `kind` metadata field with term operators
 * ($eq/$nin), never lexicographic ranges: live-proven on engine v3
 * (2026-07-13) that hybrid search applies range filters ($gte/$lt on
 * `folder`) only to the VECTOR lane — the keyword lane ignores them, so
 * filtered-out documents leak back through rrf fusion at ~0.5× score. Term
 * filters on `kind` bind both lanes. `source` (one kind) wins over
 * `excludeKinds` — a query pinned to one kind excludes the rest by
 * construction.
 */
export function searchFilters(input: {
  projectId: string;
  /** A platform corpus kind or a normalized custom kind (see normalizeSearchSource). */
  source?: string;
  excludeKinds?: readonly string[];
}): Record<string, { $eq?: string; $nin?: string[] }> {
  if (input.source !== undefined) return { kind: { $eq: input.source } };
  if (input.excludeKinds !== undefined && input.excludeKinds.length > 0) {
    return { kind: { $nin: [...input.excludeKinds] } };
  }
  return {};
}

/**
 * The AI Search instance id for one project. Instance ids are capped at 32
 * chars (`^[a-z0-9_]+(?:-[a-z0-9_]+)*$`), so the `prj_` prefix is dropped:
 * the remaining 32-hex identity fits exactly and stays collision-free within
 * the per-deployment namespace.
 */
export function projectSearchInstanceId(projectId: string): string {
  const id = projectId.replace(/^prj_/, "");
  if (!/^[a-z0-9_]{1,32}$/.test(id)) {
    throw new Error(
      `cannot derive a search instance id from project id ${JSON.stringify(projectId)}`,
    );
  }
  return id;
}

/**
 * The create-time configuration for one project's search instance: indexes
 * only the project's slice of the shared corpus bucket (structural tenancy),
 * hybrid vector+keyword with the trigram tokenizer (code + ids corpus —
 * dogfooding showed vector-only misses exact tokens), the kind/context
 * metadata schema, and hourly background sync (writes also trigger jobs on
 * demand).
 */
export function projectSearchInstanceConfig(input: { bucketName: string; projectId: string }): {
  id: string;
  type: "r2";
  source: string;
  source_params: { include_items: string[] };
  index_method: { vector: boolean; keyword: boolean };
  indexing_options: { keyword_tokenizer: "porter" | "trigram" };
  custom_metadata: { field_name: string; data_type: "text" }[];
  sync_interval: 3600;
  score_threshold: number;
  max_num_results: number;
} {
  return {
    id: projectSearchInstanceId(input.projectId),
    type: "r2",
    source: input.bucketName,
    source_params: { include_items: [`${input.projectId}/**`] },
    index_method: { vector: true, keyword: true },
    indexing_options: { keyword_tokenizer: "trigram" },
    custom_metadata: [...SEARCH_METADATA_SCHEMA],
    sync_interval: 3600,
    // Generous inclusion at birth (query-time options still override): recall
    // over precision — downstream consumers can filter with a fast LLM, but a
    // hit below the threshold never surfaces at all. Platform defaults are
    // 0.4 / 10.
    score_threshold: 0.2,
    max_num_results: 20,
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
