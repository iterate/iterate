/**
 * HAR recorder — captures HTTP and WebSocket exchanges into a HAR archive.
 *
 * ## Sanitization
 *
 * All entries pass through a sanitizer function before being stored in the
 * in-memory journal. This means `recorder.getHar()` never returns unsanitized
 * secrets, even if the archive is never written to disk.
 *
 * By default, `createDefaultHarSanitizer()` from `./har-sanitizer.ts` is used.
 * It redacts sensitive headers (authorization, cookie, set-cookie, etc.),
 * query parameters (token, api_key, jwt, etc.), JSON body fields (token,
 * secret, password, etc.), and WebSocket text frames (Discord Identify,
 * GraphQL connection_init, Coinbase subscribe JWTs).
 *
 * Values matching the `getIterateSecret({...})` placeholder pattern are
 * preserved — they are safe proxy tokens that never contain real secrets.
 *
 * The redaction format is `<prefix>---sanitised-secret-<hash>` where the
 * prefix is up to 30% of the original value and the hash is 8 hex chars of
 * SHA-256. This is deterministic, so the same secret always produces the same
 * redacted form.
 *
 * To disable sanitization, pass `sanitizer: null`. To use a custom sanitizer,
 * pass any `(entry: HarEntry) => HarEntry` function.
 */

import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import type { Entry as HarEntry, Har } from "har-format";
import type { AppendHttpExchangeInput, AppendWebSocketExchangeInput } from "./har-journal.ts";
import { HarJournal } from "./har-journal.ts";
import { createDefaultHarSanitizer, type HarEntrySanitizer } from "./har-sanitizer.ts";

export type RecorderContentEncoding = "br" | "gzip" | "deflate";
export type RecorderEntryKind = "http" | "websocket";
export type RecorderHttpSource = "handled" | "passthrough";

export type RecorderFilterContext = {
  kind: RecorderEntryKind;
  method: string;
  url: URL;
};

export type RecorderOpts = {
  enabled?: boolean;
  harPath?: string;
  includeHandledRequests?: boolean;
  decodeContentEncodings?: RecorderContentEncoding[];
  /**
   * Entry-level sanitizer applied to every HarEntry before it is stored in
   * the in-memory journal. Pass `null` to disable sanitization entirely.
   *
   * Default: `createDefaultHarSanitizer()` which redacts sensitive headers,
   * query params, JSON body keys, and WebSocket text frame payloads while
   * preserving `getIterateSecret({...})` placeholder values.
   */
  sanitizer?: HarEntrySanitizer | null;
  filter?: (entry: RecorderFilterContext) => boolean;
  /** Fired with each HAR entry after it is sanitized and appended. */
  onEntry?: (entry: HarEntry) => void;
};

type NormalizedRecorderOpts = {
  enabled: boolean;
  harPath?: string;
  includeHandledRequests: boolean;
  decodeContentEncodings: Set<RecorderContentEncoding>;
  sanitizer: HarEntrySanitizer | null;
  filter?: (entry: RecorderFilterContext) => boolean;
  onEntry?: (entry: HarEntry) => void;
};

function normalizeRecorderOpts(input: RecorderOpts | undefined): NormalizedRecorderOpts {
  const explicitSanitizer = input?.sanitizer;
  return {
    enabled: input?.enabled ?? true,
    harPath: input?.harPath,
    includeHandledRequests: input?.includeHandledRequests ?? true,
    decodeContentEncodings: new Set(input?.decodeContentEncodings ?? []),
    sanitizer:
      explicitSanitizer === null ? null : (explicitSanitizer ?? createDefaultHarSanitizer()),
    filter: input?.filter,
    onEntry: input?.onEntry,
  };
}

function readContentEncoding(headers: Headers): RecorderContentEncoding | undefined {
  const raw = headers.get("content-encoding");
  if (!raw) return undefined;
  const normalized = raw.split(",")[0]?.trim().toLowerCase();
  if (normalized === "br" || normalized === "gzip" || normalized === "deflate") {
    return normalized;
  }
  return undefined;
}

function decodeResponseBody(encoding: RecorderContentEncoding, body: Uint8Array): Uint8Array {
  const buffer = Buffer.from(body);
  switch (encoding) {
    case "br":
      return brotliDecompressSync(buffer);
    case "gzip":
      return gunzipSync(buffer);
    case "deflate":
      return inflateSync(buffer);
  }
}

export class HarRecorder {
  private readonly opts: NormalizedRecorderOpts;
  private readonly journal: HarJournal;

  private constructor(opts: NormalizedRecorderOpts, journal: HarJournal) {
    this.opts = opts;
    this.journal = journal;
  }

  static async create(opts: RecorderOpts | undefined): Promise<HarRecorder> {
    const normalized = normalizeRecorderOpts(opts);
    const sanitizer = normalized.sanitizer ?? undefined;
    const onEntry = normalized.onEntry;
    const journal = normalized.harPath
      ? await HarJournal.fromSource(normalized.harPath, { sanitizer, onEntry }).catch(
          () => new HarJournal({ sanitizer, onEntry }),
        )
      : new HarJournal({ sanitizer, onEntry });
    return new HarRecorder(normalized, journal);
  }

  getHar(): Har {
    return this.journal.getHar();
  }

  configuredHarPath(): string | undefined {
    return this.opts.harPath;
  }

  shouldRecord(entry: RecorderFilterContext): boolean {
    if (!this.opts.enabled) return false;
    return this.opts.filter ? this.opts.filter(entry) : true;
  }

  appendHttpExchange(input: AppendHttpExchangeInput, source: RecorderHttpSource): void {
    if (source === "handled" && !this.opts.includeHandledRequests) {
      return;
    }

    if (
      !this.shouldRecord({
        kind: "http",
        method: input.method,
        url: input.targetUrl,
      })
    ) {
      return;
    }

    const contentEncoding = readContentEncoding(input.response.headers);
    const canDecode =
      contentEncoding !== undefined &&
      Boolean(input.responseBody) &&
      this.opts.decodeContentEncodings.has(contentEncoding);

    let responseHeaders = input.response.headers;
    let responseBody = input.responseBody;

    if (canDecode && contentEncoding !== undefined && responseBody) {
      try {
        const decodedBody = decodeResponseBody(contentEncoding, responseBody);
        responseBody = decodedBody;
        responseHeaders = new Headers(responseHeaders);
        responseHeaders.delete("content-encoding");
        responseHeaders.set("content-length", String(decodedBody.byteLength));
      } catch {
        // If decoding fails, keep original bytes/headers.
      }
    }

    const response = new Response(responseBody ? Buffer.from(responseBody) : null, {
      status: input.response.status,
      statusText: input.response.statusText,
      headers: responseHeaders,
    });

    this.journal.appendHttpExchange({
      ...input,
      response,
      responseBody,
    });
  }

  appendWebSocketExchange(input: AppendWebSocketExchangeInput): void {
    if (
      !this.shouldRecord({
        kind: "websocket",
        method: "GET",
        url: input.targetUrl,
      })
    ) {
      return;
    }

    this.journal.appendWebSocketExchange(input);
  }

  async write(path = this.opts.harPath): Promise<void> {
    if (!path) {
      throw new Error("no recorder.harPath configured");
    }
    await this.journal.write(path);
  }

  async writeConfiguredIfAny(): Promise<void> {
    if (!this.opts.harPath) return;
    await this.journal.write(this.opts.harPath);
  }
}
