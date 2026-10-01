/** The languages the editor highlights. */
export type RepoFileLanguage =
  | "css"
  | "html"
  | "javascript"
  | "json"
  | "jsonc"
  | "markdown"
  | "sql"
  | "text"
  | "typescript"
  | "yaml";

const TEXT_LANGUAGES: Record<string, RepoFileLanguage> = {
  cjs: "javascript",
  css: "css",
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
  // svg is xml-ish text; the html grammar highlights it well
  svg: "html",
  ts: "typescript",
  tsx: "typescript",
  yaml: "yaml",
  yml: "yaml",
};

/** Files a text editor cannot show: the repo's reads and commits carry text only. */
const BINARY_EXTENSIONS = new Set([
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

/** The `.json` files that allow comments and trailing commas by convention, even without a
 *  `.jsonc` extension: the tsconfig and jsconfig families and VS Code's own config folder. */
function isJsoncByConvention(path: string, basename: string): boolean {
  if (/^(tsconfig|jsconfig).*\.json$/.test(basename)) return true;
  return /(^|\/)\.vscode\/[^/]+\.json$/.test(path);
}

/** How the repo IDE opens a path: in the text editor (with which language), or not at all.
 *  Extension-driven, since repo files have no content type. */
export type RepoFileKind = { kind: "text"; language: RepoFileLanguage } | { kind: "binary" };

export function repoFileKind(path: string): RepoFileKind {
  const basename = path.split("/").pop() ?? path;
  const extension = basename.includes(".") ? basename.split(".").pop()!.toLowerCase() : "";
  if (BINARY_EXTENSIONS.has(extension)) return { kind: "binary" };
  if (isJsoncByConvention(path, basename)) return { kind: "text", language: "jsonc" };
  // everything else opens as text: unknown extensions (Dockerfile, .env, .gitignore, .toml) are
  // overwhelmingly text in project repos
  return { kind: "text", language: TEXT_LANGUAGES[extension] || "text" };
}

/** Files that get the editor pane's Code | Preview toggle: html and svg documents (rendered in a
 *  sandboxed iframe, raw svg markup being valid in an html body) and markdown. */
export function isPreviewablePath(path: string): boolean {
  if (/\.(html?|svg)$/i.test(path)) return true;
  const kind = repoFileKind(path);
  return kind.kind === "text" && kind.language === "markdown";
}
