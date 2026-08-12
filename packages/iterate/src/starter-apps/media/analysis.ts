// The media analysis pipeline: bytes → ai.toMarkdown (vision model describes
// the image) → one vision call over the actual pixels returning
// {title, transcript, tags}. Ported from the mobile capture script
// (apps/mobile/src/lib/media.ts buildProcessScript, PR #2466) when analysis
// moved server-side: the phone now appends a cheap media/uploaded event and
// the MediaApp processor (processor.ts) drives this pipeline as an
// obligation. The server owns the analysis vocabulary — model, taxonomy,
// prompt; the mobile app keeps a display-only tag list (lib/media.ts
// MEDIA_TAGS) kept in sync by hand, same convention as search semantics.

/** Sees the pixels: transcribes text verbatim and picks tags. */
export const MEDIA_VISION_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";

/**
 * Starter taxonomy — expect churn. Multi-tag with overlap allowed; the model
 * may also coin up to two novel kebab-case tags, and returning NO tags is an
 * acceptable answer (deliberately conservative — early dogfood tagged
 * everything `bug-report` on wild guesses).
 */
export const MEDIA_TAG_TAXONOMY: { tag: string; hint: string }[] = [
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

export type MediaAnalysisResult = {
  /** One-line description of what the image IS — the row's bold first line. */
  title: string;
  /** The vision model's natural-language description — half the search corpus. */
  markdown: string;
  /** Verbatim text visible in the image — the other half. */
  transcript: string;
  tags: string[];
  processedBy: string;
};

/**
 * The itx slice the pipeline dials — structural on purpose so the real
 * `Project` session satisfies it and tests hand in a plain fake.
 */
export type MediaAnalysisSession = {
  files: { get(path: string): { bytes(): Promise<Uint8Array> } };
  ai: {
    toMarkdown(document: {
      name: string;
      blob: Uint8Array;
    }): Promise<{ format: string; data?: string; error?: string }>;
    run(model: string, body: unknown): Promise<unknown>;
  };
  integrations: {
    cf: {
      images: {
        transformBytes(input: {
          image: Uint8Array;
          transforms: { width: number }[];
          output: { format: string; quality: number };
        }): Promise<{ bytes: Uint8Array; contentType: string }>;
      };
    };
  };
};

/**
 * One full analysis of a stored media file. Throws on conversion failure so
 * the caller (the processor's obligation attempt) owns retry/settlement; an
 * unparseable vision answer degrades to empty title/transcript and
 * ["untagged"] so failures stay visible instead of hiding an item.
 */
export async function analyzeMediaImage(
  session: MediaAnalysisSession,
  input: { path: string; filename: string; contentType: string },
): Promise<MediaAnalysisResult> {
  // blob takes raw bytes (a Blob cannot cross the RPC boundary); the
  // extension in `name` picks the converter.
  const bytes = await session.files.get(input.path).bytes();
  const described = await session.ai.toMarkdown({ name: input.filename, blob: bytes });
  if (described.format === "error") {
    throw new Error(`toMarkdown failed for ${input.filename}: ${described.error}`);
  }
  const markdown = (described.data || "").trim();

  // Workers AI rejects oversized request bodies (error 3006) — long
  // full-page screenshots hit it. Downscale for the AI call only (the
  // stored original is untouched); if the Images binding can't (e.g. some
  // local dev setups), fall through with the original and let the model
  // call answer.
  let visionBytes = bytes;
  let visionType = input.contentType;
  if (bytes.length > 1_000_000) {
    try {
      const resized = await session.integrations.cf.images.transformBytes({
        image: bytes,
        transforms: [{ width: 1280 }],
        output: { format: "image/jpeg", quality: 80 },
      });
      visionBytes = resized.bytes;
      visionType = resized.contentType;
    } catch {}
  }

  // One vision call over the actual pixels: title + verbatim transcript +
  // tags in a single JSON answer.
  let binary = "";
  for (let i = 0; i < visionBytes.length; i += 32_768) {
    binary += String.fromCharCode(...visionBytes.subarray(i, i + 32_768));
  }
  const answer = await session.ai.run(MEDIA_VISION_MODEL, {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: mediaVisionPrompt() },
          {
            type: "image_url",
            image_url: { url: `data:${visionType};base64,${btoa(binary)}` },
          },
        ],
      },
    ],
    max_tokens: 1024,
  });
  return { ...parseVisionAnswer(visionAnswerText(answer)), markdown };
}

/** Both Workers AI answer shapes: `{ response }` and OpenAI-style choices. */
function visionAnswerText(answer: unknown): string {
  const bag = answer as {
    response?: unknown;
    choices?: { message?: { content?: unknown } }[];
  } | null;
  if (typeof bag?.response === "string") return bag.response;
  const content = bag?.choices?.[0]?.message?.content;
  return typeof content === "string" ? content : "";
}

/** Extract the JSON object from a chatty model answer, defensively. */
function parseVisionAnswer(text: string): Omit<MediaAnalysisResult, "markdown"> {
  let title = "";
  let transcript = "";
  let tags = ["untagged"];
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as {
        title?: unknown;
        transcript?: unknown;
        tags?: unknown;
      };
      if (typeof parsed.title === "string") title = parsed.title.trim().slice(0, 120);
      if (typeof parsed.transcript === "string") transcript = parsed.transcript.trim();
      if (Array.isArray(parsed.tags)) {
        tags = [
          ...new Set(
            parsed.tags
              .filter((tag): tag is string => typeof tag === "string")
              .map((tag) =>
                tag
                  .toLowerCase()
                  .trim()
                  .replace(/[^a-z0-9-]+/g, "-")
                  .replace(/^-+|-+$/g, ""),
              )
              .filter((tag) => tag.length > 0 && tag.length <= 30),
          ),
        ].slice(0, 6);
      }
    } catch {}
  }
  return { title, transcript, tags, processedBy: MEDIA_VISION_MODEL };
}

function mediaVisionPrompt(): string {
  const lines = MEDIA_TAG_TAXONOMY.map(({ tag, hint }) => `- "${tag}": ${hint}`);
  return [
    'Reply with ONLY a JSON object: {"title": string, "transcript": string, "tags": string[]}.',
    "title: ONE line saying what the image IS, specific not generic — 'Trenitalia ticket Rome→Florence 09:45', never 'Screenshot' or 'Image Description'.",
    "transcript: ALL text visible in the image, verbatim, reading order. Empty string if there is none.",
    "tags: pick from the list below. Include a tag ONLY when the image clearly shows it — no guesses.",
    "Fewer tags is better; an empty array is a fine answer. Overlap is allowed.",
    ...lines,
    "You may add at most 2 extra kebab-case tags if something important has no tag above.",
  ].join("\n");
}
