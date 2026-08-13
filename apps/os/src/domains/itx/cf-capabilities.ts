// The itx-facing data shapes for the Cloudflare first-party platform
// capabilities (Workers AI markdown conversion, Browser Run, Images, Media
// Transformations). The capability surfaces themselves are the RpcTarget
// classes in rpc-targets.ts (AiRpcTarget, CfBrowserCapabilityRpcTarget, …);
// these are the input/output shapes their signatures publish.

import type { FileData } from "../files/file-url-signing.ts";

/** One input document for Workers AI markdown conversion (`ai.toMarkdown`):
 * a filename plus the raw bytes. */
export type CfMarkdownDocument = {
  /** Filename including the extension; Cloudflare uses it to choose the converter. */
  name: string;
  /** The document bytes: any `FileData` shape (Uint8Array, base64 string,
   * Blob, …), coerced server-side. Blob does not survive the capnweb hop
   * from script sandboxes, so pass bytes or base64 from scripts. */
  blob: FileData;
};

/** Per-format tuning for `ai.toMarkdown`: output format (markdown, or plain
 * text with link targets and image URLs stripped — the compact choice for
 * emails and newsletters full of tracking links), HTML scoping (CSS selector,
 * hostname for relative links), image description language, PDF metadata
 * exclusion. */
export type CfMarkdownConversionOptions = {
  conversionOptions?: {
    output?: {
      format?: "markdown" | "text";
    };
    html?: {
      cssSelector?: string;
      hostname?: string;
    };
    image?: {
      descriptionLanguage?: string;
    };
    pdf?: {
      excludeMetadata?: boolean;
    };
  };
};

/** One converted document from `ai.toMarkdown`: `format` is "markdown" — or
 * "text" when `output.format: "text"` was requested — with the converted
 * text in `data` (plus a token estimate), or "error" with the failure
 * message in `error`. */
export type CfMarkdownConversionResult = {
  name: string;
  format: "markdown" | "text" | "error";
  mimeType?: string;
  tokens?: number;
  data?: string;
  error?: string;
};

/** One file format the markdown converter accepts (extension plus MIME type);
 * `ai.toMarkdown()` with no arguments returns the full list. */
export type CfMarkdownSupportedFormat = {
  extension: string;
  mimeType: string;
};

/** The `ai.toMarkdown` argument tuple: empty lists the supported formats;
 * otherwise one document (or an array) plus optional conversion options
 * converts to markdown. */
export type CfMarkdownConversionArgs =
  | []
  | [documents: CfMarkdownDocument | CfMarkdownDocument[], options?: CfMarkdownConversionOptions];

/** The Workers AI binding's per-call options (`env.AI.run`'s third argument),
 * published structurally so itx callers can route a call through a specific
 * AI Gateway configuration — e.g. `{ gateway: { id: "default", skipCache: true } }`. */
export type CfAiRunOptions = {
  gateway?: {
    id: string;
    cacheKey?: string;
    cacheTtl?: number;
    skipCache?: boolean;
    metadata?: Record<string, number | string | boolean | null>;
    collectLog?: boolean;
  };
  returnRawResponse?: boolean;
};

/** A Browser Run quick-action name (`browser.quickAction`'s first argument):
 * what to extract from the rendered page — page content, screenshot, PDF,
 * markdown, accessibility snapshot, scraped elements, structured JSON, links,
 * or a crawl. */
export type CfBrowserQuickAction =
  | "content"
  | "screenshot"
  | "pdf"
  | "markdown"
  | "snapshot"
  | "scrape"
  | "json"
  | "links"
  | "crawl";

/** Options for a Browser Run quick action: the target page as a `url` or as
 * inline `html`, plus the action's own pass-through options (e.g.
 * `screenshotOptions`). */
export type CfBrowserQuickActionOptions = Record<string, unknown> &
  ({ url: string } | { html: string });

/** One Cloudflare Images transform step (width, height, fit, rotate, …),
 * passed through to the Images binding verbatim. */
export type CfImageTransformOptions = Record<string, unknown>;

/** Output encoding for a Cloudflare Images transform: the target `format`
 * (e.g. "image/webp") plus pass-through options such as quality. */
export type CfImageOutputOptions = { format: string } & Record<string, unknown>;

/** Placement options for one overlay draw in a Cloudflare Images transform
 * (opacity, repeat, top/left, …), passed through to the Images binding
 * verbatim. */
export type CfImageDrawOptions = Record<string, unknown>;

/** Input to the Images capability's `transform`: the source image stream,
 * ordered transform steps, optional overlay draws (watermarks — each with its
 * own transforms), and the output encoding. */
export type CfImageTransformInput = {
  /** Source image: a stream, or any FileData shape (bytes/base64/Blob) —
   * coerced server-side; streams and Blobs do not survive the RPC hop from
   * script sandboxes, so pass bytes or base64 from scripts. */
  image: ReadableStream<Uint8Array> | FileData;
  transforms?: CfImageTransformOptions[];
  draws?: Array<{
    image: ReadableStream<Uint8Array> | FileData;
    options?: CfImageDrawOptions;
    transforms?: CfImageTransformOptions[];
  }>;
  output: CfImageOutputOptions;
};

/** Transform options for a Media Transformations video call (width, height,
 * fit, trim, …), passed through to the binding verbatim. */
export type CfVideoTransformOptions = Record<string, unknown>;

/** Output selection for a video transform: `mode` picks a video, spritesheet,
 * single frame, or audio track; other options pass through to the binding. */
export type CfVideoOutputOptions = {
  mode: "video" | "spritesheet" | "frame" | "audio";
} & Record<string, unknown>;

/** Input to the videos capability's `transform`: the source video stream,
 * optional transform options, and the output selection. */
export type CfVideoTransformInput = {
  video: ReadableStream<Uint8Array>;
  transform?: CfVideoTransformOptions;
  output: CfVideoOutputOptions;
};

/**
 * Unwraps a Browser Run quick-action Response to the caller-facing result:
 * JSON envelopes (`{ success, result }`) yield their `result` (throwing the
 * envelope's error on failure), binary media (screenshot, pdf) yields bytes.
 * Pure so the unwrap contract is unit-testable — the binding itself is an
 * external service local dev cannot dial.
 */
export async function unwrapBrowserRunQuickAction(
  action: string,
  response: Response,
): Promise<string | Uint8Array | unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    // Binary actions (screenshot, pdf) respond with the media itself.
    return new Uint8Array(await response.arrayBuffer());
  }
  const envelope = (await response.json()) as {
    success?: boolean;
    result?: unknown;
    error?: unknown;
  } | null;
  if (envelope && typeof envelope === "object" && "success" in envelope) {
    if (envelope.success !== true) {
      throw new Error(
        `Browser Run ${action} failed: ${JSON.stringify(envelope.error ?? envelope).slice(0, 500)}`,
      );
    }
    return envelope.result;
  }
  return envelope;
}
