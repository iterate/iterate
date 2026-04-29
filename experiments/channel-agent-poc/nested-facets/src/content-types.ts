// Shared content-type inference + cache header utilities.

export const CONTENT_TYPES: Record<string, string> = {
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

export function inferContentType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

// Content-hashed filenames (e.g. index-BNby28Aj.js) are immutable
export function isContentHashed(path: string): boolean {
  return /[-\.][A-Za-z0-9_-]{6,}\.\w+$/.test(path);
}

export function cacheHeaders(path: string): string {
  return isContentHashed(path) ? "public, max-age=31536000, immutable" : "public, max-age=3600";
}
