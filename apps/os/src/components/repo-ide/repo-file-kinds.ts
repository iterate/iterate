import type { SourceCodeLanguage } from "@iterate-com/ui/components/source-code-block";

const IMAGE_MIME_TYPES: Record<string, string> = {
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

const TEXT_LANGUAGES: Record<string, SourceCodeLanguage> = {
  cjs: "javascript",
  cts: "typescript",
  htm: "html",
  html: "html",
  js: "javascript",
  json: "json",
  jsonc: "json",
  jsx: "javascript",
  markdown: "markdown",
  md: "markdown",
  mjs: "javascript",
  mts: "typescript",
  sql: "sql",
  // svg is xml-ish text; the html grammar highlights it well and editing
  // beats a raster preview for repo-committed icons.
  svg: "html",
  ts: "typescript",
  tsx: "typescript",
  yaml: "yaml",
  yml: "yaml",
};

const OPAQUE_BINARY_EXTENSIONS = new Set([
  "eot",
  "gz",
  "jar",
  "otf",
  "tar",
  "ttf",
  "wasm",
  "woff",
  "woff2",
  "zip",
]);

/**
 * How the repo IDE opens a path: in a CodeMirror editor (with which language),
 * an image/PDF renderer, or the generic binary fallback. Extension-driven —
 * repo files have no content-type channel.
 */
type RepoFileKind =
  | { kind: "text"; language: SourceCodeLanguage }
  | { kind: "image"; mimeType: string }
  | { kind: "pdf" }
  | { kind: "binary" };

export function repoFileKind(path: string): RepoFileKind {
  const basename = path.split("/").pop() ?? path;
  const extension = basename.includes(".") ? basename.split(".").pop()!.toLowerCase() : "";
  const imageMimeType = IMAGE_MIME_TYPES[extension];
  if (imageMimeType !== undefined) return { kind: "image", mimeType: imageMimeType };
  if (extension === "pdf") return { kind: "pdf" };
  if (OPAQUE_BINARY_EXTENSIONS.has(extension)) return { kind: "binary" };
  // Everything else opens as text — unknown extensions (Dockerfile, .env,
  // .gitignore, .toml) are overwhelmingly text in project repos.
  return { kind: "text", language: TEXT_LANGUAGES[extension] || "text" };
}

/** Whether the path's content travels on the base64 lane (readFile/commitFiles). */
export function isBinaryRepoPath(path: string): boolean {
  return repoFileKind(path).kind !== "text";
}
