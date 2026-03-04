import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { CaddyClient } from "@accelerated-software-development/caddy-api-client";

export function networkErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  if ("code" in error && typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  const cause =
    "cause" in error && (error as { cause?: unknown }).cause
      ? (error as { cause: unknown }).cause
      : undefined;
  if (!cause || cause === error) return undefined;
  return networkErrorCode(cause);
}

const RETRIABLE_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

export function isRetriableNetworkError(error: unknown): boolean {
  const code = networkErrorCode(error);
  if (code && RETRIABLE_CODES.has(code)) return true;
  return error instanceof Error && /socket hang up/i.test(error.message);
}

export function shQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

export function toEnvRecord(env?: Record<string, string> | string[]): Record<string, string> {
  if (!env) return {};
  if (!Array.isArray(env)) return { ...env };
  const record: Record<string, string> = {};
  for (const entry of env) {
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;
    const key = entry.slice(0, separator).trim();
    if (!key) continue;
    record[key] = entry.slice(separator + 1);
  }
  return record;
}

function parseResponseHeaders(raw: Record<string, string | string[] | undefined>): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const entry of value) {
        headers.append(key, entry);
      }
      continue;
    }
    headers.set(key, String(value));
  }
  return headers;
}

export async function nodeHttpRequest(params: {
  url: URL;
  method: string;
  headers: Headers;
  body?: Buffer;
  buffered?: boolean;
}): Promise<Response> {
  return await new Promise<Response>((resolve, reject) => {
    const requestImpl = params.url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = requestImpl(
      params.url,
      {
        method: params.method,
        headers: Object.fromEntries(params.headers.entries()),
      },
      (res) => {
        const responseHeaders = parseResponseHeaders(
          res.headers as Record<string, string | string[] | undefined>,
        );
        const status = res.statusCode ?? 500;

        if (params.buffered) {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer | string) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          res.on("end", () => {
            resolve(
              new Response(Buffer.concat(chunks), {
                status,
                statusText: res.statusMessage ?? "",
                headers: responseHeaders,
              }),
            );
          });
          return;
        }

        const responseBody =
          status === 204 || status === 304
            ? undefined
            : (Readable.toWeb(res as unknown as Readable) as ReadableStream<Uint8Array>);
        resolve(
          new Response(responseBody, {
            status,
            statusText: res.statusMessage ?? "",
            headers: responseHeaders,
          }),
        );
      },
    );

    req.on("error", reject);
    if (params.body !== undefined) {
      req.write(params.body);
    }
    req.end();
  });
}

async function forwardedRequest(params: {
  baseUrl: string;
  host: string;
  path: string;
  method: string;
  headers?: RequestInit["headers"];
  body?: Buffer;
  buffered?: boolean;
  defaultContentType?: string;
}): Promise<Response> {
  const url = new URL(
    params.path.startsWith("/") ? params.path : `/${params.path}`,
    params.baseUrl,
  );
  const headers = new Headers(params.headers);
  if (params.defaultContentType && !headers.has("content-type")) {
    headers.set("content-type", params.defaultContentType);
  }
  headers.set("x-forwarded-host", params.host);
  headers.delete("host");
  headers.delete("content-length");
  if (params.body !== undefined) {
    headers.set("content-length", params.body.byteLength.toString());
  }
  return await nodeHttpRequest({
    url,
    method: params.method.toUpperCase(),
    headers,
    body: params.body,
    buffered: params.buffered,
  });
}

export function createHostRoutedFetch(params: {
  baseUrl: string;
  host: string;
}): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const requestUrl = new URL(request.url);
    const method = request.method.toUpperCase();
    const body =
      method === "GET" || method === "HEAD"
        ? undefined
        : Buffer.from(await request.clone().arrayBuffer());
    return await forwardedRequest({
      baseUrl: params.baseUrl,
      host: params.host,
      path: `${requestUrl.pathname}${requestUrl.search}`,
      method,
      headers: request.headers,
      body,
    });
  };
}

export function createCaddyAdminClient(params: { baseUrl: string; host: string }): CaddyClient {
  const caddy = new CaddyClient({ adminUrl: params.baseUrl });
  caddy.request = async (path: string, options: RequestInit = {}): Promise<Response> => {
    const body =
      options.body == null
        ? undefined
        : Buffer.from(await new Response(options.body).arrayBuffer());
    return await forwardedRequest({
      baseUrl: params.baseUrl,
      host: params.host,
      path,
      method: options.method ?? "GET",
      headers: options.headers,
      body,
      buffered: true,
      defaultContentType: "application/json",
    });
  };
  return caddy;
}

export function collectTextOutput(stream: NodeJS.ReadableStream): { flush: () => string } {
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer | string) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  return {
    flush() {
      return Buffer.concat(chunks).toString("utf-8");
    },
  };
}
