// Media capture pipeline: pure logic only (no Expo imports), so vitest
// covers it in root CI. The screen (app/project/[projectId]/media.tsx) wires
// this to the picker and itx. Flow per item: bytes to itx.files at a
// content-hash path, then ONE capabilityHost.runScript call server-side does
// files.bytes → ai.toMarkdown (vision model describes the image) → one
// vision-model call over the actual pixels returning {transcript, tags} →
// append a media/captured event, idempotency-keyed by the hash so retries
// and re-picks dedup. "Re-analyze" runs the same pipeline again and appends
// a media/processed event; the list derivation takes the latest processing
// per item, so prompt/model improvements apply retroactively. Search is
// client-side over description + transcript + tags.

import type { StreamEvent } from "iterate/sdk/itx/react";

export const MEDIA_STREAM_PATH = "/media";
export const MEDIA_CAPTURED_EVENT_TYPE = "events.iterate.com/media/captured";
export const MEDIA_PROCESSED_EVENT_TYPE = "events.iterate.com/media/processed";
export const MEDIA_EVENT_TYPES = [MEDIA_CAPTURED_EVENT_TYPE, MEDIA_PROCESSED_EVENT_TYPE];
/** Sees the pixels: transcribes text verbatim and picks tags. */
export const MEDIA_VISION_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";

/**
 * Starter taxonomy — expect churn. Multi-tag with overlap allowed; the model
 * may also coin up to two novel kebab-case tags, and returning NO tags is an
 * acceptable answer (deliberately conservative — early dogfood tagged
 * everything `bug-report` on wild guesses).
 */
export const MEDIA_TAGS: { tag: string; hint: string }[] = [
  { tag: "screenshot", hint: "a captured device screen: app UI, web page, status bar visible" },
  { tag: "photo", hint: "a camera photograph of the physical world" },
  { tag: "transient", hint: "one-off info with no lasting value: OTP codes, confirmations" },
  { tag: "clipping", hint: "a saved post, article, meme, or quote worth keeping" },
  { tag: "logistics", hint: "tickets, bookings, schedules, travel details, QR codes" },
  { tag: "receipt", hint: "proof of purchase, invoices, order confirmations" },
  { tag: "conversation", hint: "chat threads, DMs, emails, comment sections" },
  { tag: "code", hint: "code, terminals, dev tools, technical docs" },
  { tag: "reference", hint: "info to keep long-term: settings, lists, instructions" },
];

export type MediaProcessingResult = {
  /** The vision model's natural-language description — half the search corpus. */
  markdown: string;
  /** Verbatim text visible in the image — the other half. */
  transcript: string;
  tags: string[];
  processedBy: string;
};

export type MediaCapturedPayload = MediaProcessingResult & {
  stableKey: string;
  /** itx.files path holding the bytes. */
  path: string;
  filename: string;
  contentType: string;
  width: number;
  height: number;
};

export type MediaProcessedPayload = MediaProcessingResult & { stableKey: string };

export function mediaFilePath(stableKey: string, filename: string): string {
  const safe = filename.replace(/[^\w.-]+/g, "_").slice(-64);
  return `/media/inbound/${stableKey}-${safe}`;
}

export function mediaIdempotencyKey(stableKey: string): string {
  return `media-captured-${stableKey}`;
}

export type ProcessScriptInput = {
  stableKey: string;
  filename: string;
  contentType: string;
  width: number;
  height: number;
  /**
   * "capture" appends the media/captured birth event (idempotent per
   * stableKey — a re-run returns the existing event). A reprocess appends a
   * media/processed event instead; the nonce keys each re-run separately.
   */
  mode: "capture" | { reprocessNonce: string };
};

/**
 * The server-side half, as an `async (itx) => {...}` script string for
 * capabilityHost.runScript. Input rides in as one JSON literal — never
 * interpolate fields individually (filenames are attacker-ish data).
 * Returns the appended (or pre-existing) event.
 */
export function buildProcessScript(input: ProcessScriptInput): string {
  const scriptInput = {
    stableKey: input.stableKey,
    filename: input.filename,
    contentType: input.contentType,
    width: input.width,
    height: input.height,
    path: mediaFilePath(input.stableKey, input.filename),
    capture: input.mode === "capture",
    idempotencyKey:
      input.mode === "capture"
        ? mediaIdempotencyKey(input.stableKey)
        : `media-processed-${input.stableKey}-${input.mode.reprocessNonce}`,
    eventType: input.mode === "capture" ? MEDIA_CAPTURED_EVENT_TYPE : MEDIA_PROCESSED_EVENT_TYPE,
    streamPath: MEDIA_STREAM_PATH,
    visionModel: MEDIA_VISION_MODEL,
    visionPrompt: visionPrompt(),
  };
  return `async (itx) => {
  const input = ${asJsLiteral(scriptInput)};
  const stream = itx.streams.get(input.streamPath);
  if (input.capture) {
    const existing = await stream.getEvent({ idempotencyKey: input.idempotencyKey });
    if (existing) return existing;
  }

  // blob takes raw bytes (a Blob cannot cross the sandbox RPC boundary);
  // the extension in \`name\` picks the converter.
  const bytes = await itx.files.get(input.path).bytes();
  const described = await itx.ai.toMarkdown({ name: input.filename, blob: bytes });
  if (described.format === "error") {
    throw new Error("toMarkdown failed for " + input.filename + ": " + described.error);
  }
  const markdown = (described.data || "").trim();

  // One vision call over the actual pixels: verbatim transcript + tags in a
  // single JSON answer. Parse defensively — an unparseable answer degrades
  // to an empty transcript and ["untagged"] so failures stay visible.
  let binary = "";
  for (let i = 0; i < bytes.length; i += 32768) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  }
  const answer = await itx.ai.run(input.visionModel, {
    messages: [{
      role: "user",
      content: [
        { type: "text", text: input.visionPrompt },
        { type: "image_url", image_url: { url: "data:" + input.contentType + ";base64," + btoa(binary) } },
      ],
    }],
    max_tokens: 1024,
  });
  const text = typeof answer?.response === "string"
    ? answer.response
    : typeof answer?.choices?.[0]?.message?.content === "string"
      ? answer.choices[0].message.content
      : "";
  let transcript = "";
  let tags = ["untagged"];
  const match = text.match(/\\{[\\s\\S]*\\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (typeof parsed.transcript === "string") transcript = parsed.transcript.trim();
      if (Array.isArray(parsed.tags)) {
        tags = [...new Set(
          parsed.tags
            .filter((tag) => typeof tag === "string")
            .map((tag) => tag.toLowerCase().trim().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, ""))
            .filter((tag) => tag.length > 0 && tag.length <= 30),
        )].slice(0, 6);
      }
    } catch {}
  }

  const [event] = await stream.append({
    type: input.eventType,
    idempotencyKey: input.idempotencyKey,
    payload: {
      stableKey: input.stableKey,
      markdown,
      transcript,
      tags,
      processedBy: input.visionModel,
      ...(input.capture
        ? {
            path: input.path,
            filename: input.filename,
            contentType: input.contentType,
            width: input.width,
            height: input.height,
          }
        : {}),
    },
  });
  return event;
}`;
}

function visionPrompt(): string {
  const lines = MEDIA_TAGS.map(({ tag, hint }) => `- "${tag}": ${hint}`);
  return [
    'Reply with ONLY a JSON object: {"transcript": string, "tags": string[]}.',
    "transcript: ALL text visible in the image, verbatim, reading order. Empty string if there is none.",
    "tags: pick from the list below. Include a tag ONLY when the image clearly shows it — no guesses.",
    "Fewer tags is better; an empty array is a fine answer. Overlap is allowed.",
    ...lines,
    "You may add at most 2 extra kebab-case tags if something important has no tag above.",
  ].join("\n");
}

/**
 * JSON.stringify is almost a JS literal — U+2028/U+2029 are the exception
 * (legal in JSON strings, line terminators in source). Escape them so a
 * filename can never break out of the script.
 */
function asJsLiteral(value: unknown): string {
  return JSON.stringify(value).replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

export type MediaListItem = {
  /** The captured event's offset — the item's identity in the list. */
  offset: number;
  capturedAt: string;
  payload: MediaCapturedPayload;
};

/**
 * Captured events → list items, newest first, with the latest media/processed
 * result (by offset) overlaid per stableKey — so a re-analysis updates what
 * you see without rewriting history.
 */
export function deriveMediaList(events: StreamEvent[]): MediaListItem[] {
  const latestProcessed = new Map<string, MediaProcessedPayload>();
  for (const event of events) {
    // Events arrive offset-ascending, so later wins by insertion order.
    if (event.type === MEDIA_PROCESSED_EVENT_TYPE) {
      const payload = event.payload as MediaProcessedPayload;
      latestProcessed.set(payload.stableKey, payload);
    }
  }
  return events
    .filter((event) => event.type === MEDIA_CAPTURED_EVENT_TYPE)
    .map((event) => {
      const captured = event.payload as MediaCapturedPayload;
      const processed = latestProcessed.get(captured.stableKey);
      return {
        offset: event.offset,
        capturedAt: event.createdAt,
        payload: processed ? { ...captured, ...processed } : captured,
      };
    })
    .sort((a, b) => b.offset - a.offset);
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
    const { markdown, transcript, filename, tags } = item.payload;
    const haystack = `${markdown} ${transcript} ${filename} ${tags.join(" ")}`.toLowerCase();
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

/** Run `work` over `items` with at most `limit` in flight — the capture
 * pipeline is AI-call-bound (~5-15s per item), so strict sequencing made a
 * 20-item batch crawl. Preserves item order in the result array. */
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
