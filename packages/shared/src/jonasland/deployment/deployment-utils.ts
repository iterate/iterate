import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
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

export function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error(`Operation aborted${signal.reason ? `: ${String(signal.reason)}` : ""}`);
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

/**
 * HTTP/1.1 request that buffers the entire response body.
 * Uses node:http / node:https to avoid HTTP/2 connection-reuse issues
 * with Fly's proxy layer.
 */
function http1Request(params: {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body?: Buffer;
}): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const impl = params.url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = impl(params.url, { method: params.method, headers: params.headers }, (res) => {
      const status = res.statusCode ?? 500;
      const h = new Headers();
      for (const [k, v] of Object.entries(res.headers)) {
        if (v === undefined) continue;
        if (Array.isArray(v)) for (const e of v) h.append(k, e);
        else h.set(k, v);
      }
      if (status === 204 || status === 205 || status === 304) {
        resolve(new Response(null, { status, headers: h }));
        return;
      }
      const bodyStream = new ReadableStream<Uint8Array>({
        start(controller) {
          res.on("data", (chunk: Buffer) => {
            controller.enqueue(new Uint8Array(chunk));
          });
          res.on("end", () => {
            controller.close();
          });
          res.on("error", (error) => {
            controller.error(error);
          });
        },
        cancel() {
          res.destroy();
        },
      });
      resolve(new Response(bodyStream, { status, headers: h }));
    });
    req.on("error", reject);
    if (params.body) req.write(params.body);
    req.end();
  });
}

/**
 * Returns a fetch function that rewrites URLs to `baseUrl` and sets
 * `X-Forwarded-Host` to tell Caddy which service to route to.
 *
 * The actual TCP `Host` stays as the natural destination (127.0.0.1:{port}).
 * Caddy's first directive in the catch-all block rewrites Host from
 * X-Forwarded-Host so all downstream matchers (vhosts, dynamic fragments)
 * just match on Host.
 *
 * Uses HTTP/1.1 under the hood to avoid HTTP/2 stream issues on Fly.
 */
export function createHostRoutedFetch(params: {
  baseUrl: string;
  host: string;
}): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const requestUrl = new URL(request.url);
    const url = new URL(`${requestUrl.pathname}${requestUrl.search}`, params.baseUrl);
    const headers: Record<string, string> = {};
    request.headers.forEach((v, k) => {
      headers[k] = v;
    });
    headers["x-forwarded-host"] = params.host;
    const method = request.method;
    const body =
      method === "GET" || method === "HEAD" ? undefined : Buffer.from(await request.arrayBuffer());
    return await http1Request({ url, method, headers, body });
  };
}

export function createCaddyAdminClient(params: { baseUrl: string; host: string }): CaddyClient {
  const caddy = new CaddyClient({ adminUrl: params.baseUrl });
  caddy.request = async (path: string, options: RequestInit = {}): Promise<Response> => {
    const url = new URL(path.startsWith("/") ? path : `/${path}`, params.baseUrl);
    const headers: Record<string, string> = { "x-forwarded-host": params.host };
    if (options.headers) {
      new Headers(options.headers).forEach((v, k) => {
        headers[k] = v;
      });
    }
    if (options.body != null && !headers["content-type"]) {
      headers["content-type"] = "application/json";
    }
    const body =
      options.body == null
        ? undefined
        : Buffer.from(await new Response(options.body).arrayBuffer());
    return await http1Request({ url, method: options.method ?? "GET", headers, body });
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
