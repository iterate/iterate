import type { SourceCodeLanguage } from "@iterate-com/ui/components/source-code-block";

const TEXT_LANGUAGES: Record<string, SourceCodeLanguage> = {
  cjs: "javascript",
  cts: "typescript",
  htm: "html",
  html: "html",
  js: "javascript",
  json: "json",
  jsonc: "jsonc",
  jsx: "javascript",
  markdown: "markdown",
  md: "markdown",
  mjs: "javascript",
  mts: "typescript",
  sql: "sql",
  svg: "html",
  ts: "typescript",
  tsx: "typescript",
  yaml: "yaml",
  yml: "yaml",
};

const OPAQUE_EXTENSIONS = new Set([
  "avif",
  "bmp",
  "eot",
  "gif",
  "gz",
  "ico",
  "jar",
  "jpeg",
  "jpg",
  "otf",
  "pdf",
  "png",
  "tar",
  "ttf",
  "wasm",
  "webp",
  "woff",
  "woff2",
  "zip",
]);

/**
 * How a workspace file opens: a document (the collaborative editor with
 * comments), source text in a read-only CodeMirror buffer (with which
 * language), or an opaque file nothing renders. Extension-driven — a
 * workspace file has no content-type channel.
 */
export type WorkspaceFileKind =
  | { kind: "document" }
  | { kind: "text"; language: SourceCodeLanguage }
  | { kind: "opaque" };

export function workspaceFileKind(path: string): WorkspaceFileKind {
  const basename = path.split("/").pop() ?? path;
  const extension = basename.includes(".") ? basename.split(".").pop()!.toLowerCase() : "";
  if (/^(?:md|markdown|html?)$/.test(extension)) return { kind: "document" };
  if (OPAQUE_EXTENSIONS.has(extension)) return { kind: "opaque" };
  if (/^(?:tsconfig|jsconfig).*\.json$/.test(basename)) return { kind: "text", language: "jsonc" };
  // Everything else opens as text — unknown extensions (Dockerfile, .env,
  // .gitignore, .toml) are overwhelmingly text in project repos.
  return { kind: "text", language: TEXT_LANGUAGES[extension] ?? "text" };
}

/**
 * A typed file name as the file to create: a name with no extension at all
 * is a Markdown document (`notes` → `notes.md`); any extension, document or
 * not, is kept as typed (`worker.ts` stays `worker.ts`).
 */
export function withDocumentExtension(path: string): string {
  const basename = path.split("/").pop() ?? path;
  return basename.includes(".") ? path : `${path}.md`;
}
