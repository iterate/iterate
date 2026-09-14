import { isMap, parseDocument } from "yaml";

export interface MarkdownPreviewProjection {
  body: string;
  metadata: Array<{ key: string; value: string }>;
}

/** Projects valid YAML frontmatter away from a Markdown preview. */
export function projectMarkdownPreview(content: string): MarkdownPreviewProjection {
  const opening = /^(?:\uFEFF)?---[ \t]*\r?\n/.exec(content);
  if (opening === null) return { body: content, metadata: [] };

  const afterOpening = content.slice(opening[0].length);
  const closing = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(afterOpening);
  if (closing === null) return { body: content, metadata: [] };

  let document;
  try {
    document = parseDocument(afterOpening.slice(0, closing.index));
  } catch {
    return { body: content, metadata: [] };
  }

  if (document.errors.length > 0 || !isMap(document.contents))
    return { body: content, metadata: [] };
  let metadata: Array<{ key: string; value: string }>;
  try {
    metadata = Object.entries(document.toJS()).map(([key, value]) => ({
      key,
      value: formatFrontmatterValue(value),
    }));
  } catch {
    return { body: content, metadata: [] };
  }
  return { body: afterOpening.slice(closing.index + closing[0].length), metadata };
}

function formatFrontmatterValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(formatFrontmatterValue).join(", ");
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  if (value === null) return "null";
  return String(value);
}
