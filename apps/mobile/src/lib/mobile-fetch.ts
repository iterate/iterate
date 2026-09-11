import { RpcTarget } from "capnweb";
import { z } from "zod";

const MAX_BODY_BYTES = 8 * 1024 * 1024;

const MobileFetchRequest = z.strictObject({
  url: z.url({ protocol: /^https?$/ }),
  method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]),
  headers: z.array(z.tuple([z.string(), z.string()])),
  body: z
    .instanceof(Uint8Array)
    .refine((bytes) => bytes.byteLength <= MAX_BODY_BYTES)
    .nullable(),
});

export type MobileFetchRequest = z.infer<typeof MobileFetchRequest>;
export type MobileFetchResponse = {
  status: number;
  headers: [string, string][];
  body: Uint8Array | null;
};

/** A buffered HTTP bridge; the final network request runs on the phone. */
export class MobileFetchCapabilities extends RpcTarget {
  #fetch: typeof fetch;
  #isForeground: () => boolean;

  constructor(nativeFetch: typeof fetch, isForeground: () => boolean) {
    super();
    this.#fetch = nativeFetch;
    this.#isForeground = isForeground;
  }

  async fetch(input: MobileFetchRequest): Promise<MobileFetchResponse> {
    const request = MobileFetchRequest.parse(input);
    if (!this.#isForeground())
      throw new Error("Phone fetch is unavailable while the app is in the background.");
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 30_000);
    try {
      const headers = new Headers(request.headers);
      // The native HTTP stack owns framing for the newly constructed request.
      for (const name of ["host", "connection", "content-length", "transfer-encoding"])
        headers.delete(name);
      const response = await this.#fetch(request.url, {
        method: request.method,
        headers,
        body: request.body ? request.body.slice().buffer : undefined,
        redirect: "follow",
        signal: abort.signal,
      });
      const bodyless = request.method === "HEAD" || [204, 205, 304].includes(response.status);
      if (!bodyless && Number(response.headers.get("content-length")) > MAX_BODY_BYTES) {
        abort.abort();
        throw new Error("Phone fetch response exceeds 8 MiB.");
      }
      const body = bodyless ? null : new Uint8Array(await response.arrayBuffer());
      if (body && body.byteLength > MAX_BODY_BYTES)
        throw new Error("Phone fetch response exceeds 8 MiB.");
      const responseHeaders = new Headers(response.headers);
      // Fetch has already decoded the bytes; do not describe them as compressed.
      for (const name of ["connection", "content-length", "content-encoding", "transfer-encoding"])
        responseHeaders.delete(name);
      return { status: response.status, headers: [...responseHeaders.entries()], body };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Published with the mount so agent scripts can discover the bridge's byte contract. */
export const MOBILE_FETCH_TYPES = `export interface MobileCapabilities {
  /** HTTP(S) from the foreground phone. Buffered bodies up to 8 MiB; 30s timeout.
   * Redirects stay on the phone; native cookie and redirect behavior applies. */
  fetch(request: {
    url: string;
    method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";
    headers: [string, string][];
    body: Uint8Array | null;
  }): Promise<{ status: number; headers: [string, string][]; body: Uint8Array | null }>;
}`;
