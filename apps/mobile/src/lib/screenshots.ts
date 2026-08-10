// Screenshot capture pipeline: pure logic only (no Expo imports), so vitest
// covers it in root CI. The screen (app/project/[projectId]/screenshots.tsx)
// wires this to the picker and itx. Flow per screenshot: bytes to itx.files
// at a content-hash path, then ONE capabilityHost.runScript call server-side
// does files.bytes → ai.toMarkdown (vision model describes the image) →
// ai.run (cheap text model multi-tags the description) → append a
// screenshots/captured event, idempotency-keyed by the hash so retries and
// re-picks dedup. Search is client-side over the descriptions — the vision
// model's prose is what makes "train ticket" findable.

import type { StreamEvent } from "iterate/sdk/itx/react";

export const SCREENSHOTS_STREAM_PATH = "/screenshots";
export const SCREENSHOT_CAPTURED_EVENT_TYPE = "events.iterate.com/screenshots/captured";
export const SCREENSHOT_TAGGER_MODEL = "@cf/meta/llama-3.2-3b-instruct";

/**
 * Starter taxonomy — expect churn. Multi-tag with overlap allowed
 * (deliberately not first-match-wins); the model may also coin up to two
 * novel kebab-case tags, so this list constrains nothing permanently.
 */
export const SCREENSHOT_TAGS: { tag: string; hint: string }[] = [
  { tag: "transient", hint: "one-off info: OTP codes, confirmations, loading states, errors" },
  { tag: "media", hint: "posts, articles, memes, video stills worth keeping" },
  { tag: "logistics", hint: "travel tickets, bookings, schedules, addresses, QR codes" },
  { tag: "receipt", hint: "proof of purchase, invoices, order confirmations" },
  { tag: "bug-report", hint: "software misbehaving: broken UI, stack traces, wrong output" },
  { tag: "iterate", hint: "the iterate product itself: os.iterate.com, the iterate mobile app" },
  { tag: "code", hint: "code, terminals, dev tools, technical docs" },
  { tag: "conversation", hint: "chat threads, DMs, emails, comment sections" },
  { tag: "reference", hint: "info to keep long-term: settings, lists, instructions" },
];

export type ScreenshotCapturedPayload = {
  stableKey: string;
  /** itx.files path holding the bytes. */
  path: string;
  filename: string;
  contentType: string;
  width: number;
  height: number;
  /** The vision model's natural-language description — the search corpus. */
  markdown: string;
  tags: string[];
  taggedBy: string;
};

export function screenshotFilePath(stableKey: string, filename: string): string {
  const safe = filename.replace(/[^\w.-]+/g, "_").slice(-64);
  return `/screenshots/inbound/${stableKey}-${safe}`;
}

export function screenshotIdempotencyKey(stableKey: string): string {
  return `screenshot-captured-${stableKey}`;
}

export type CaptureScriptInput = {
  stableKey: string;
  filename: string;
  contentType: string;
  width: number;
  height: number;
};

/**
 * The server-side half, as an `async (itx) => {...}` script string for
 * capabilityHost.runScript. Input rides in as one JSON literal — never
 * interpolate fields individually (filenames are attacker-ish data).
 * Returns the appended (or pre-existing) captured event.
 */
export function buildCaptureScript(input: CaptureScriptInput): string {
  const scriptInput = {
    ...input,
    path: screenshotFilePath(input.stableKey, input.filename),
    idempotencyKey: screenshotIdempotencyKey(input.stableKey),
    eventType: SCREENSHOT_CAPTURED_EVENT_TYPE,
    streamPath: SCREENSHOTS_STREAM_PATH,
    taggerModel: SCREENSHOT_TAGGER_MODEL,
    tagSystemPrompt: tagSystemPrompt(),
  };
  return `async (itx) => {
  const input = ${asJsLiteral(scriptInput)};
  const stream = itx.streams.get(input.streamPath);
  const existing = await stream.getEvent({ idempotencyKey: input.idempotencyKey });
  if (existing) return existing;

  // blob takes raw bytes (a Blob cannot cross the sandbox RPC boundary);
  // the extension in \`name\` picks the converter.
  const bytes = await itx.files.get(input.path).bytes();
  const described = await itx.ai.toMarkdown({ name: input.filename, blob: bytes });
  if (described.format === "error") {
    throw new Error("toMarkdown failed for " + input.filename + ": " + described.error);
  }
  const markdown = (described.data || "").trim();

  // Text-generation models answer in \`response\`; the description (not the
  // pixels) is what gets classified. Parse defensively: an unparseable
  // answer tags as ["untagged"] so failures stay visible, not fatal.
  const answer = await itx.ai.run(input.taggerModel, {
    messages: [
      { role: "system", content: input.tagSystemPrompt },
      { role: "user", content: markdown || "(empty description)" },
    ],
  });
  let tags = ["untagged"];
  // Workers AI text models answer in \`response\` or OpenAI-style \`choices\`.
  const text = typeof answer?.response === "string"
    ? answer.response
    : typeof answer?.choices?.[0]?.message?.content === "string"
      ? answer.choices[0].message.content
      : "";
  const match = text.match(/\\[[\\s\\S]*?\\]/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      const cleaned = [...new Set(
        parsed
          .filter((tag) => typeof tag === "string")
          .map((tag) => tag.toLowerCase().trim().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, ""))
          .filter((tag) => tag.length > 0 && tag.length <= 30),
      )].slice(0, 6);
      if (cleaned.length > 0) tags = cleaned;
    } catch {}
  }

  const [event] = await stream.append({
    type: input.eventType,
    idempotencyKey: input.idempotencyKey,
    payload: {
      stableKey: input.stableKey,
      path: input.path,
      filename: input.filename,
      contentType: input.contentType,
      width: input.width,
      height: input.height,
      markdown,
      tags,
      taggedBy: input.taggerModel,
    },
  });
  return event;
}`;
}

function tagSystemPrompt(): string {
  const lines = SCREENSHOT_TAGS.map(({ tag, hint }) => `- "${tag}": ${hint}`);
  return [
    "You tag screenshots from a description of their contents.",
    "Reply with ONLY a JSON array of tag strings, nothing else.",
    "Pick every tag that applies (overlap is expected) from:",
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

export type ScreenshotListItem = {
  offset: number;
  capturedAt: string;
  payload: ScreenshotCapturedPayload;
};

/** Captured events → list items, newest first. */
export function deriveScreenshotList(events: StreamEvent[]): ScreenshotListItem[] {
  return events
    .filter((event) => event.type === SCREENSHOT_CAPTURED_EVENT_TYPE)
    .map((event) => ({
      offset: event.offset,
      capturedAt: event.createdAt,
      payload: event.payload as ScreenshotCapturedPayload,
    }))
    .sort((a, b) => b.offset - a.offset);
}

/**
 * Every whitespace-separated query term must appear somewhere in the
 * description, filename, or tags; selected tag chips all must be present.
 */
export function filterScreenshots(
  items: ScreenshotListItem[],
  query: string,
  selectedTags: string[],
): ScreenshotListItem[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((item) => {
    const haystack =
      `${item.payload.markdown} ${item.payload.filename} ${item.payload.tags.join(" ")}`.toLowerCase();
    return (
      terms.every((term) => haystack.includes(term)) &&
      selectedTags.every((tag) => item.payload.tags.includes(tag))
    );
  });
}

/** Read every captured event, paging like lib/approvals.ts readAllApprovalEvents. */
export async function readAllScreenshotEvents(stream: {
  getEvents: (args: { afterOffset: number; eventTypes: string[] }) => Promise<StreamEvent[]>;
}): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  let cursor = 0;
  while (true) {
    const page = await stream.getEvents({
      afterOffset: cursor,
      eventTypes: [SCREENSHOT_CAPTURED_EVENT_TYPE],
    });
    if (page.length === 0) return events;
    events.push(...page);
    cursor = page.at(-1)!.offset;
  }
}
