import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import type { Har } from "har-format";
import type {
  AppendHttpExchangeInput,
  AppendWebSocketExchangeInput,
} from "../msw-http-proxy/har-journal.ts";
import { HarJournal } from "../msw-http-proxy/har-journal.ts";

export type RecorderContentEncoding = "br" | "gzip" | "deflate";
export type RecorderEntryKind = "http" | "websocket";
export type RecorderHttpSource = "handled" | "passthrough";

export type RecorderFilterContext = {
  kind: RecorderEntryKind;
  method: string;
  url: URL;
};

export type RecorderSanitizeOptions = {
  requestHeaders?: string[];
  responseHeaders?: string[];
  replacement?: string;
};

export type RecorderOpts = {
  enabled?: boolean;
  harPath?: string;
  includeHandledRequests?: boolean;
  decodeContentEncodings?: RecorderContentEncoding[];
  sanitize?: RecorderSanitizeOptions;
  filter?: (entry: RecorderFilterContext) => boolean;
};

type NormalizedRecorderOpts = {
  enabled: boolean;
  harPath?: string;
  includeHandledRequests: boolean;
  decodeContentEncodings: Set<RecorderContentEncoding>;
  sanitizeRequestHeaders: Set<string>;
  sanitizeResponseHeaders: Set<string>;
  sanitizeReplacement: string;
  filter?: (entry: RecorderFilterContext) => boolean;
};

function normalizeHeaderNames(input: string[] | undefined): Set<string> {
  if (!input || input.length === 0) return new Set();
  return new Set(input.map((value) => value.toLowerCase()));
}

function normalizeRecorderOpts(input: RecorderOpts | undefined): NormalizedRecorderOpts {
  return {
    enabled: input?.enabled ?? true,
    harPath: input?.harPath,
    includeHandledRequests: input?.includeHandledRequests ?? true,
    decodeContentEncodings: new Set(input?.decodeContentEncodings ?? []),
    sanitizeRequestHeaders: normalizeHeaderNames(input?.sanitize?.requestHeaders),
    sanitizeResponseHeaders: normalizeHeaderNames(input?.sanitize?.responseHeaders),
    sanitizeReplacement: input?.sanitize?.replacement ?? "<redacted>",
    filter: input?.filter,
  };
}

function sanitizeRecordHeaders(
  input: Record<string, string>,
  names: Set<string>,
  replacement: string,
): Record<string, string> {
  if (names.size === 0) return input;

  const mapped: Record<string, string> = {};
  for (const [name, value] of Object.entries(input)) {
    mapped[name] = names.has(name.toLowerCase()) ? replacement : value;
  }
  return mapped;
}

function sanitizeHeaders(input: Headers, names: Set<string>, replacement: string): Headers {
  if (names.size === 0) return input;

  const mapped = new Headers();
  for (const [name, value] of input.entries()) {
    mapped.append(name, names.has(name.toLowerCase()) ? replacement : value);
  }
  return mapped;
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
    const journal = normalized.harPath
      ? await HarJournal.fromSource(normalized.harPath).catch(() => new HarJournal())
      : new HarJournal();
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

    const requestHeaders = sanitizeRecordHeaders(
      input.requestHeaders,
      this.opts.sanitizeRequestHeaders,
      this.opts.sanitizeReplacement,
    );
    const sanitizedResponseHeaders = sanitizeHeaders(
      input.response.headers,
      this.opts.sanitizeResponseHeaders,
      this.opts.sanitizeReplacement,
    );
    const contentEncoding = readContentEncoding(sanitizedResponseHeaders);
    const canDecode =
      contentEncoding !== undefined &&
      Boolean(input.responseBody) &&
      this.opts.decodeContentEncodings.has(contentEncoding);

    let responseHeaders = sanitizedResponseHeaders;
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
      requestHeaders,
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

    const requestHeaders = sanitizeRecordHeaders(
      input.requestHeaders,
      this.opts.sanitizeRequestHeaders,
      this.opts.sanitizeReplacement,
    );
    const responseHeaders = sanitizeHeaders(
      input.responseHeaders,
      this.opts.sanitizeResponseHeaders,
      this.opts.sanitizeReplacement,
    );

    this.journal.appendWebSocketExchange({
      ...input,
      requestHeaders,
      responseHeaders,
    });
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
