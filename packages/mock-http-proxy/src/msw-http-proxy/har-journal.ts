import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Entry as HarEntry, Har } from "har-format";
import { serializeBodyForHar } from "./proxy-request.ts";

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function mapRecordHeaders(headers: Record<string, string>): Array<{ name: string; value: string }> {
  return Object.entries(headers).map(([name, value]) => ({ name, value }));
}

function mapResponseHeaders(headers: Headers): Array<{ name: string; value: string }> {
  const mapped: Array<{ name: string; value: string }> = [];
  for (const [name, value] of headers.entries()) {
    mapped.push({ name, value });
  }
  return mapped;
}

function createEmptyHar(): Har {
  return {
    log: {
      version: "1.2",
      creator: { name: "@iterate-com/mock-http-proxy/msw", version: "0.0.1" },
      entries: [],
    },
  };
}

export type AppendHttpExchangeInput = {
  startedAt: number;
  durationMs: number;
  method: string;
  targetUrl: URL;
  requestHeaders: Record<string, string>;
  requestBody: Uint8Array | null;
  response: Response;
  responseBody: Uint8Array | null;
};

export class HarJournal {
  private readonly har: Har;

  constructor(initialHar?: Har) {
    this.har = initialHar ? deepClone(initialHar) : createEmptyHar();
  }

  static async fromSource(source: Har | string | undefined): Promise<HarJournal> {
    if (!source) return new HarJournal();

    if (typeof source === "string") {
      const parsed = JSON.parse(await readFile(source, "utf8")) as Har;
      return new HarJournal(parsed);
    }

    return new HarJournal(source);
  }

  entries(): ReadonlyArray<HarEntry> {
    return this.har.log.entries as HarEntry[];
  }

  appendHttpExchange(input: AppendHttpExchangeInput): void {
    const requestContentType = input.requestHeaders["content-type"] ?? "application/octet-stream";
    const requestBody = serializeBodyForHar(input.requestBody, requestContentType);

    const responseContentType =
      input.response.headers.get("content-type") ?? "application/octet-stream";
    const responseBody = serializeBodyForHar(input.responseBody, responseContentType);

    const entry: HarEntry = {
      startedDateTime: new Date(input.startedAt).toISOString(),
      time: input.durationMs,
      request: {
        method: input.method,
        url: input.targetUrl.toString(),
        httpVersion: "HTTP/1.1",
        cookies: [],
        headers: mapRecordHeaders(input.requestHeaders),
        queryString: Array.from(input.targetUrl.searchParams.entries()).map(([name, value]) => ({
          name,
          value,
        })),
        headersSize: -1,
        bodySize: requestBody?.size ?? 0,
        ...(requestBody
          ? {
              postData: {
                mimeType: requestContentType,
                text: requestBody.text,
              },
            }
          : {}),
      },
      response: {
        status: input.response.status,
        statusText: input.response.statusText,
        httpVersion: "HTTP/1.1",
        cookies: [],
        headers: mapResponseHeaders(input.response.headers),
        content: {
          size: responseBody?.size ?? 0,
          mimeType: responseContentType,
          ...(responseBody
            ? {
                text: responseBody.text,
                ...(responseBody.encoding ? { encoding: responseBody.encoding } : {}),
              }
            : {}),
        },
        redirectURL: "",
        headersSize: -1,
        bodySize: responseBody?.size ?? 0,
      },
      cache: {},
      timings: {
        send: 0,
        wait: 0,
        receive: 0,
      },
    };

    this.har.log.entries.push(entry);
  }

  getHar(): Har {
    return deepClone(this.har);
  }

  async write(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(this.har, null, 2)}\n`, "utf8");
  }
}
