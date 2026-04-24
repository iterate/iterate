// R2BucketProxy — prefix-scoped R2 access for dynamic workers.
//
// Provided to dynamic workers via ctx.exports:
//   env.ASSETS = ctx.exports.R2BucketProxy({ props: { prefix: "..." } })
//   env.STORAGE = ctx.exports.R2BucketProxy({ props: { prefix: "..." } })
//
// .fetch() serves files with correct content types + cache headers.
// RPC methods provide get/put/head/delete/list.

import { WorkerEntrypoint } from "cloudflare:workers";

interface Env {
  WORKSPACE_R2: R2Bucket;
}

const CONTENT_TYPES: Record<string, string> = {
  js: "application/javascript",
  mjs: "application/javascript",
  css: "text/css",
  html: "text/html;charset=utf-8",
  json: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff2: "font/woff2",
  woff: "font/woff",
  ttf: "font/ttf",
  otf: "font/otf",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  wasm: "application/wasm",
  pdf: "application/pdf",
  txt: "text/plain",
  xml: "application/xml",
};

function inferContentType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

// Content-hashed filenames (e.g. index-BNby28Aj.js) are immutable
function isContentHashed(path: string): boolean {
  return /[-\.][A-Za-z0-9_-]{6,}\.\w+$/.test(path);
}

export class R2BucketProxy extends WorkerEntrypoint<Env> {
  get #prefix(): string {
    return (this.ctx as any).props?.prefix ?? "";
  }

  get #r2(): R2Bucket {
    return this.env.WORKSPACE_R2;
  }

  #key(path: string): string {
    // Strip leading slash, prepend prefix
    const clean = path.replace(/^\/+/, "");
    return this.#prefix + clean;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    let path = url.pathname === "/" ? "/index.html" : url.pathname;

    const key = this.#key(path);
    const obj = await this.#r2.get(key);
    if (!obj) {
      // SPA fallback: serve index.html for non-file paths
      if (!path.includes(".") && !path.startsWith("/api/")) {
        const indexObj = await this.#r2.get(this.#key("index.html"));
        if (indexObj) {
          return new Response(indexObj.body, {
            headers: {
              "content-type": "text/html;charset=utf-8",
              "cache-control": "no-cache",
            },
          });
        }
      }
      return new Response("Not found", { status: 404 });
    }

    const ct = inferContentType(path);
    const cc = isContentHashed(path)
      ? "public, max-age=31536000, immutable"
      : "public, max-age=3600";

    return new Response(obj.body, {
      headers: {
        "content-type": ct,
        "cache-control": cc,
        etag: obj.httpEtag,
      },
    });
  }

  // ── RPC methods ──

  async get(path: string): Promise<{ body: ArrayBuffer; contentType: string } | null> {
    const obj = await this.#r2.get(this.#key(path));
    if (!obj) return null;
    return { body: await obj.arrayBuffer(), contentType: inferContentType(path) };
  }

  async put(path: string, data: ArrayBuffer | string): Promise<void> {
    const body = typeof data === "string" ? new TextEncoder().encode(data) : data;
    await this.#r2.put(this.#key(path), body, {
      httpMetadata: { contentType: inferContentType(path) },
    });
  }

  async head(path: string): Promise<{ size: number; contentType: string } | null> {
    const obj = await this.#r2.head(this.#key(path));
    if (!obj) return null;
    return { size: obj.size, contentType: inferContentType(path) };
  }

  async delete(path: string): Promise<void> {
    await this.#r2.delete(this.#key(path));
  }

  async list(prefix?: string): Promise<string[]> {
    const fullPrefix = this.#prefix + (prefix ?? "");
    const listed = await this.#r2.list({ prefix: fullPrefix, limit: 1000 });
    return listed.objects.map((o) => o.key.slice(this.#prefix.length));
  }
}
