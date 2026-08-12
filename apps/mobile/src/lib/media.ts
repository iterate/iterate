// Media capture pipeline: pure logic only (no Expo imports), so vitest
// covers it in root CI. The screen (app/project/[projectId]/media.tsx) wires
// this to the picker and itx. Flow per item: bytes to itx.files at a
// content-hash path, then ONE cheap durable stream append — a
// media/uploaded event carrying only metadata. Analysis happens SERVER-SIDE:
// the MediaApp processor (iterate/starter-apps/media) reacts to uploaded
// events, runs toMarkdown + a vision model, and settles with a
// media/processed event the list derivation overlays. The phone never holds
// a socket open for analysis, so locking it mid-pass loses nothing, and an
// AI failure never loses the item — the row exists from the uploaded event
// and shows the failure. "Re-analyze" appends media/reanalyze-requested and
// the same server pipeline overlays the newest result. Search is
// client-side over description + transcript + tags.

import type { StreamEvent } from "iterate/sdk/itx/react";

export const MEDIA_STREAM_PATH = "/media";
/** LEGACY birth event (phone-scripted capture+analysis in one) — still
 * rendered, never appended anymore. */
export const MEDIA_CAPTURED_EVENT_TYPE = "events.iterate.com/media/captured";
export const MEDIA_UPLOADED_EVENT_TYPE = "events.iterate.com/media/uploaded";
export const MEDIA_PROCESSED_EVENT_TYPE = "events.iterate.com/media/processed";
export const MEDIA_REANALYZE_REQUESTED_EVENT_TYPE = "events.iterate.com/media/reanalyze-requested";
export const MEDIA_WIPED_EVENT_TYPE = "events.iterate.com/media/wiped";
export const MEDIA_EVENT_TYPES = [
  MEDIA_CAPTURED_EVENT_TYPE,
  MEDIA_UPLOADED_EVENT_TYPE,
  MEDIA_PROCESSED_EVENT_TYPE,
  MEDIA_REANALYZE_REQUESTED_EVENT_TYPE,
  MEDIA_WIPED_EVENT_TYPE,
];

/**
 * Display order for tag filter chips. The analysis-owning taxonomy (tags +
 * model hints + prompt) lives server-side in
 * iterate/starter-apps/media/analysis.ts (MEDIA_TAG_TAXONOMY) — kept in sync
 * by hand, same convention as the search semantics.
 */
export const MEDIA_TAGS = [
  "screenshot",
  "photo",
  "transient",
  "clipping",
  "logistics",
  "receipt",
  "conversation",
  "code",
  "reference",
];

export type MediaProcessingResult = {
  /** One-line description of what the image IS ("Pooya Parsi X post —
   * announcing Rangi"), from the vision call — the row's bold first line.
   * toMarkdown's own headings are generic ("Screenshot Overview"). */
  title: string;
  /** The vision model's natural-language description — half the search corpus. */
  markdown: string;
  /** Verbatim text visible in the image — the other half. */
  transcript: string;
  tags: string[];
  processedBy: string;
};

/** The cheap durable birth fact: file metadata only, no analysis. */
export type MediaUploadedPayload = {
  stableKey: string;
  /** itx.files path holding the bytes. */
  path: string;
  filename: string;
  contentType: string;
  width: number;
  height: number;
  /** Where the item entered: hand-picked or the library sync engine. */
  source: "picker" | "library-sync";
  /** Asset creation time (ISO) when the source knows it; null from the
   * picker, which strips asset metadata on recompression. */
  capturedAt: string | null;
  /** iOS's own screenshot flag (mediaSubtypes) — null when unknowable. */
  isScreenshot: boolean | null;
};

export type MediaCapturedPayload = MediaProcessingResult & MediaUploadedPayload;

export type MediaProcessedPayload = MediaProcessingResult & {
  stableKey: string;
  /** Terminal analysis failure, or null/absent on success (absent on legacy
   * phone-scripted re-analysis events). */
  error?: string | null;
  /** The uploaded/reanalyze event this settles (absent on legacy appends).
   * Lets the derivation ignore a LATE settlement answering a superseded
   * request — e.g. a pre-wipe attempt racing Delete-all + re-upload. */
  requestOffset?: number | null;
};

/**
 * The picker recompresses to JPEG/PNG (quality 0.8) but iOS often keeps the
 * original fileName — e.g. `IMG_1234.HEIC` with image/jpeg bytes. toMarkdown
 * picks its converter from the name's extension and HEIC is unsupported, so
 * the name must match the actual payload type.
 */
export function normalizedImageFilename(
  pickedName: string | null | undefined,
  contentType: string,
  fallbackStem: string,
): string {
  const extension = contentType.split("/")[1] || "jpg";
  const stem = (pickedName || fallbackStem).replace(/\.[^.]+$/, "");
  return `${stem}.${extension}`;
}

/** A media file's path IS `/media/<sha256>-<original-filename>` — one flat
 * content-addressed namespace (the hash keeps dedup; the filename keeps it
 * readable and searchable). The event payload's `path` is authoritative, so
 * items stored under older layouts keep resolving. */
export function mediaFilePath(stableKey: string, filename: string): string {
  const safe = filename.replace(/[^\w.-]+/g, "_").slice(-64);
  return `/media/${stableKey}-${safe}`;
}

/**
 * Capture identity = content hash + wipe generation. Without the
 * generation, re-capturing a screenshot after Delete-all would dedup
 * against the pre-wipe event and silently never come back. The key spelling
 * is shared with the legacy media/captured events ON PURPOSE: an item
 * captured before the uploaded-event split can never re-enter as a
 * duplicate (the phone's getEvent check hits, and the stream itself rejects
 * a same-key append).
 */
export function mediaIdempotencyKey(stableKey: string, wipeGeneration: number): string {
  return wipeGeneration === 0
    ? `media-captured-${stableKey}`
    : `media-captured-${stableKey}-g${wipeGeneration}`;
}

/** The last wiped tombstone's offset (0 when never wiped) — the capture
 * dedup generation. */
export async function readWipeGeneration(stream: {
  getEvents: (args: { afterOffset: number; eventTypes: string[] }) => Promise<StreamEvent[]>;
}): Promise<number> {
  const wipes = await stream.getEvents({ afterOffset: 0, eventTypes: [MEDIA_WIPED_EVENT_TYPE] });
  return wipes.at(-1)?.offset || 0;
}

/**
 * The absolute back-to instant an Update resolves to: the chosen window,
 * except it can only EXTEND an enabled setting backwards — re-confirming
 * with a shorter chip never silently shrinks the window.
 */
export function extendedSinceIso(
  existingSinceIso: string | null,
  windowDays: number,
  nowMs: number,
): string {
  const chosen = nowMs - windowDays * 86_400_000;
  const existing = existingSinceIso === null ? Infinity : new Date(existingSinceIso).getTime();
  return new Date(Math.min(chosen, existing)).toISOString();
}

/**
 * The durable birth append for one captured item — the ENTIRE remote half of
 * capture now that analysis is server-side. Appended right after files.put;
 * idempotency-keyed by content hash + wipe generation.
 */
export function buildUploadedEvent(input: {
  stableKey: string;
  wipeGeneration: number;
  filename: string;
  contentType: string;
  width: number;
  height: number;
  source: "picker" | "library-sync";
  capturedAt: string | null;
  isScreenshot: boolean | null;
}): { type: string; idempotencyKey: string; payload: MediaUploadedPayload } {
  return {
    type: MEDIA_UPLOADED_EVENT_TYPE,
    idempotencyKey: mediaIdempotencyKey(input.stableKey, input.wipeGeneration),
    payload: {
      stableKey: input.stableKey,
      path: mediaFilePath(input.stableKey, input.filename),
      filename: input.filename,
      contentType: input.contentType,
      width: input.width,
      height: input.height,
      source: input.source,
      capturedAt: input.capturedAt,
      isScreenshot: input.isScreenshot,
    },
  };
}

/** Ask the server to re-run analysis; the nonce keys each request separately. */
export function buildReanalyzeEvent(
  stableKey: string,
  nonce: string,
): { type: string; idempotencyKey: string; payload: { stableKey: string } } {
  return {
    type: MEDIA_REANALYZE_REQUESTED_EVENT_TYPE,
    idempotencyKey: `media-reanalyze-${stableKey}-${nonce}`,
    payload: { stableKey },
  };
}

/**
 * Delete-everything, as a product event on the append-only stream: the
 * script deletes every stored file it can find via the birth events
 * (uploaded + legacy captured), then appends media/wiped — the tombstone
 * every derivation (phone list, MediaApp fold) resets on. Idempotency-keyed
 * per invocation, not content: each deliberate wipe is its own fact.
 */
export function buildWipeScript(nonce: string): string {
  const scriptInput = {
    streamPath: MEDIA_STREAM_PATH,
    birthTypes: [MEDIA_CAPTURED_EVENT_TYPE, MEDIA_UPLOADED_EVENT_TYPE],
    wipedType: MEDIA_WIPED_EVENT_TYPE,
    idempotencyKey: `media-wiped-${nonce}`,
  };
  return `async (itx) => {
  const input = ${asJsLiteral(scriptInput)};
  const stream = itx.streams.get(input.streamPath);
  const events = [];
  let cursor = 0;
  while (true) {
    const page = await stream.getEvents({ afterOffset: cursor, eventTypes: input.birthTypes });
    if (page.length === 0) break;
    events.push(...page);
    cursor = page[page.length - 1].offset;
  }
  const paths = [...new Set(events.map((event) => event.payload.path).filter(Boolean))];
  let deleted = 0;
  for (const path of paths) {
    try {
      await itx.files.get(path).delete();
      deleted += 1;
    } catch {}
  }
  const [event] = await stream.append({
    type: input.wipedType,
    idempotencyKey: input.idempotencyKey,
    payload: { deletedFiles: deleted, items: paths.length },
  });
  return event;
}`;
}

/**
 * JSON.stringify is almost a JS literal — U+2028/U+2029 are the exception
 * (legal in JSON strings, line terminators in source). Escape them so a
 * filename can never break out of the script.
 */
function asJsLiteral(value: unknown): string {
  return JSON.stringify(value).replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

/** Where an item is in its analysis lifecycle — drives the row badge. */
export type MediaAnalysisState = {
  status: "pending" | "failed" | "done";
  /** The terminal failure message when status is "failed". */
  error: string | null;
};

export type MediaListItem = {
  /** The birth event's offset (captured or uploaded) — the item's identity
   * in the list. */
  offset: number;
  capturedAt: string;
  payload: MediaCapturedPayload;
  analysis: MediaAnalysisState;
};

/**
 * Birth events (uploaded + legacy captured, deduped per stableKey) → list
 * items, newest first, with the latest successful media/processed result
 * (by offset) overlaid — so a re-analysis updates what you see without
 * rewriting history. A failed settlement keeps the previous fields and
 * surfaces its error; an open request (uploaded or reanalyze newer than the
 * latest settlement) shows as "pending".
 */
export function deriveMediaList(events: StreamEvent[]): MediaListItem[] {
  // A wiped tombstone resets everything before it.
  const wipedThroughOffset = lastWipeOffset(events);
  const liveEvents = events.filter((event) => event.offset > wipedThroughOffset);
  const latestProcessed = new Map<string, { payload: MediaProcessedPayload; offset: number }>();
  const latestSuccessful = new Map<string, MediaProcessedPayload>();
  const latestRequest = new Map<string, number>();
  for (const event of liveEvents) {
    // Events arrive offset-ascending, so later wins by insertion order.
    if (event.type === MEDIA_PROCESSED_EVENT_TYPE) {
      const payload = event.payload as MediaProcessedPayload;
      latestProcessed.set(payload.stableKey, { payload, offset: event.offset });
      if (!payload.error) latestSuccessful.set(payload.stableKey, payload);
    }
    if (event.type === MEDIA_REANALYZE_REQUESTED_EVENT_TYPE) {
      const payload = event.payload as { stableKey: string };
      latestRequest.set(payload.stableKey, event.offset);
    }
  }
  const seen = new Set<string>();
  const items: MediaListItem[] = [];
  for (const event of liveEvents) {
    const isCaptured = event.type === MEDIA_CAPTURED_EVENT_TYPE;
    if (!isCaptured && event.type !== MEDIA_UPLOADED_EVENT_TYPE) continue;
    const born = event.payload as MediaCapturedPayload;
    // One row per stableKey even if both a legacy captured and an uploaded
    // event exist — the first birth wins.
    if (seen.has(born.stableKey)) continue;
    seen.add(born.stableKey);
    // Uploaded births carry no processing fields yet.
    const base: MediaCapturedPayload = isCaptured
      ? born
      : { ...born, title: "", markdown: "", transcript: "", tags: [], processedBy: "" };
    const processed = latestProcessed.get(born.stableKey);
    // Content comes from the latest SUCCESSFUL processing — a terminal
    // failure contributes only its failed state below, never a blank
    // overlay wiping fields an earlier success produced (the server fold
    // keeps them the same way).
    const success = latestSuccessful.get(born.stableKey);
    const payload: MediaCapturedPayload = success
      ? {
          ...base,
          title: success.title,
          markdown: success.markdown,
          transcript: success.transcript,
          tags: success.tags,
          processedBy: success.processedBy,
        }
      : base;
    // An uploaded birth IS an analysis request; reanalyze events are later
    // ones. Settled = a processed event newer than the latest request.
    const requestOffset = Math.max(
      isCaptured ? 0 : event.offset,
      latestRequest.get(born.stableKey) || 0,
    );
    // A settlement only counts when it answers the CURRENT request: a late
    // one for a superseded requestOffset (pre-wipe attempt racing a wipe +
    // re-upload) must not mark the fresh generation settled or failed — the
    // server fold applies the same stale-result guard. Legacy settlements
    // carry no requestOffset and settle whatever was asked.
    const settles =
      processed !== undefined &&
      (!processed.payload.requestOffset || processed.payload.requestOffset >= requestOffset);
    const settledOffset = settles ? processed.offset : 0;
    const analysis: MediaAnalysisState =
      requestOffset > settledOffset
        ? { status: "pending", error: null }
        : processed !== undefined && processed.payload.error
          ? { status: "failed", error: processed.payload.error }
          : { status: "done", error: null };
    items.push({ offset: event.offset, capturedAt: event.createdAt, payload, analysis });
  }
  // Newest first by the ORIGINAL image's date, not append order: parallel
  // uploads commit in arbitrary order, and offset-sorting made rows re-sort
  // under the user's thumb as each landed. capturedAt is the asset's own
  // creation time when the source knew it (library-sync always does); the
  // picker strips it, so those fall back to the event's stream time — which
  // is "just now" for a fresh pick. Offset breaks exact ties
  // deterministically.
  return items.sort((a, b) => captureInstant(b) - captureInstant(a) || b.offset - a.offset);
}

/** The row's sort instant (ms). Unparseable dates collapse to 0 so the
 * offset tiebreak decides — never NaN into the comparator. */
function captureInstant(item: MediaListItem): number {
  const instant = new Date(item.payload.capturedAt || item.capturedAt).getTime();
  return Number.isNaN(instant) ? 0 : instant;
}

/**
 * A not-yet-derived capture in flight on this device: the local preview the
 * screen shows while bytes upload (or after a terminal skip/error). Lives in
 * component state; deriveMediaFeed interleaves these with the real rows.
 */
export type MediaPendingCard = {
  previewUri: string;
  filename: string;
  /** Content hash once computed; null while "waiting" (pre-hash). Ties the
   * card to the row it will become. */
  stableKey: string | null;
  /** The uploaded event's offset once the append succeeded ("done"); null
   * before. A wipe tombstone at or past it supersedes the card — its row is
   * gone for good, so the card must not ghost back. */
  uploadedOffset: number | null;
  /** The asset's own creation time when the source knows it (library sync);
   * null from the picker. The card sorts by it so it sits where its row
   * will land. */
  capturedAt: string | null;
  /** waiting → uploading are in-flight (retryable work this device still
   * owes); "done" means the append committed and the card only bridges the
   * moment until its row arrives over the live stream. */
  status: "waiting" | "uploading" | "done" | "skipped" | "error";
  error?: string;
};

/** The last wiped tombstone's offset in an already-read event list (0 when
 * never wiped) — the client-side twin of readWipeGeneration's server read. */
export function lastWipeOffset(events: StreamEvent[]): number {
  return events.findLast((event) => event.type === MEDIA_WIPED_EVENT_TYPE)?.offset || 0;
}

export type MediaFeedEntry =
  | { kind: "row"; key: string; item: MediaListItem }
  | { kind: "pending"; key: string; card: MediaPendingCard };

/**
 * ONE list for the screen: pending cards interleaved with real rows, all
 * sorted by the same original-image-date key — two separate zones made every
 * upload completion jump the item across the zone boundary and shift both.
 *
 * The no-gap rule: an in-flight or done card renders only while NO derived
 * row exists for its stableKey (checked against ALL rows, not the filtered
 * view) — the row takes over the card's list position AND its React key, so
 * resolution is an in-place morph, never a vanish-reappear. A "done" card is
 * additionally superseded by a wipe tombstone at/past its append offset:
 * its row is gone for good and must not ghost back as an eternal spinner.
 * Terminal skipped/error cards are exempt from suppression: a row for the
 * same content can legitimately coexist (skipped MEANS already captured),
 * so they keep their own key and stay visible until the next capture or
 * pull-to-refresh clears them.
 */
export function deriveMediaFeed(input: {
  /** Rows to display (post-search-filter). */
  rows: MediaListItem[];
  /** EVERY derived row (unfiltered) — the card-suppression authority. */
  allRows: MediaListItem[];
  cards: MediaPendingCard[];
  /** From {@link lastWipeOffset} over the same events the rows derive from. */
  wipedThroughOffset: number;
}): MediaFeedEntry[] {
  const resolvedKeys = new Set(input.allRows.map((row) => row.payload.stableKey));
  const decorated: { entry: MediaFeedEntry; instant: number; tiebreak: number }[] = [];
  for (const item of input.rows) {
    decorated.push({
      entry: { kind: "row", key: item.payload.stableKey, item },
      instant: captureInstant(item),
      tiebreak: item.offset,
    });
  }
  const cardKeys = new Set<string>();
  for (const card of input.cards) {
    const awaitingRow =
      card.status === "waiting" || card.status === "uploading" || card.status === "done";
    if (awaitingRow && card.stableKey !== null && resolvedKeys.has(card.stableKey)) continue;
    if (
      card.status === "done" &&
      card.uploadedOffset !== null &&
      card.uploadedOffset <= input.wipedThroughOffset
    ) {
      // The wipe erased this card's committed event along with every row —
      // nothing will ever arrive for it.
      continue;
    }
    const parsed = card.capturedAt === null ? NaN : Date.parse(card.capturedAt);
    // The stableKey key is what carries the mounted component across the
    // card→row morph; pre-hash and terminal cards key on their preview, as
    // does a duplicate-hash straggler (two concurrent captures of identical
    // bytes must not collide on one FlatList key).
    const key =
      awaitingRow && card.stableKey !== null && !cardKeys.has(card.stableKey)
        ? card.stableKey
        : `pending:${card.previewUri}`;
    cardKeys.add(key);
    decorated.push({
      entry: { kind: "pending", key, card },
      // A dateless (picker) card is "just captured now", i.e. newest.
      instant: Number.isNaN(parsed) ? Number.MAX_SAFE_INTEGER : parsed,
      // On exact date ties an in-flight card outranks committed rows.
      tiebreak: Number.MAX_SAFE_INTEGER,
    });
  }
  return decorated
    .sort((a, b) => b.instant - a.instant || b.tiebreak - a.tiebreak)
    .map(({ entry }) => entry);
}

/**
 * Every whitespace-separated query term must appear somewhere in the
 * description, transcript, filename, or tags; selected tag chips all must be
 * present.
 */
export function filterMedia(
  items: MediaListItem[],
  query: string,
  selectedTags: string[],
): MediaListItem[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((item) => {
    const { title, markdown, transcript, filename, path, tags } = item.payload;
    // The stored name (path minus directory and hash prefix) is the
    // SANITIZED filename in-app deep links search by (lib/in-app-links.ts),
    // so names with spaces still match — but only that segment joins the
    // haystack: the /media/ prefix and content hash would make queries like
    // "media" match everything.
    const storedName = (path.split("/").at(-1) || "").replace(/^[0-9a-f]{32,}-/, "");
    const haystack =
      `${title} ${markdown} ${transcript} ${filename} ${storedName} ${tags.join(" ")}`.toLowerCase();
    return (
      terms.every((term) => haystack.includes(term)) &&
      selectedTags.every((tag) => tags.includes(tag))
    );
  });
}

/** Read every media event, paging like lib/approvals.ts readAllApprovalEvents. */
export async function readAllMediaEvents(stream: {
  getEvents: (args: { afterOffset: number; eventTypes: string[] }) => Promise<StreamEvent[]>;
}): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  let cursor = 0;
  while (true) {
    const page = await stream.getEvents({
      afterOffset: cursor,
      eventTypes: MEDIA_EVENT_TYPES,
    });
    if (page.length === 0) return events;
    events.push(...page);
    cursor = page.at(-1)!.offset;
  }
}

/** Run `work` over `items` with at most `limit` in flight — a sync pass
 * uploads many items and the reads/uploads overlap nicely. Preserves item
 * order in the result array. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}
