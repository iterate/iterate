// What a file in a repo opens as, by its name: markdown in the live-preview editor, html in a code
// editor with a preview beside it, any other text in a code editor highlighted by its extension,
// and a binary file not at all (a repo's text is what Docs edits).
export type FileKind = "markdown" | "html" | "code" | "binary";

/** Extensions of files that aren't text. Anything else is taken for text. */
const binaryExtensions = new Set(
  "png jpg jpeg gif webp avif heic ico bmp tif tiff psd pdf zip gz tgz tar bz2 xz 7z rar jar wasm bin exe dll so dylib woff woff2 ttf otf eot mp3 wav ogg flac m4a mp4 mov webm avi mkv sqlite db".split(
    " ",
  ),
);

export function fileKind(path: string): FileKind {
  const name = path.split("/").at(-1)!;
  const extension = name.includes(".") ? name.split(".").at(-1)!.toLowerCase() : "";
  if (extension === "md" || extension === "markdown" || extension === "mdx") return "markdown";
  if (extension === "html" || extension === "htm") return "html";
  return binaryExtensions.has(extension) ? "binary" : "code";
}
