import { parseRestrictedFrontmatterYaml } from "./frontmatter.ts";

export interface MarkdownPreviewProjection {
  body: string;
  metadata: Array<{ key: string; value: string }>;
}

/**
 * Projects independently valid YAML frontmatter away from a Markdown preview.
 *
 * This deliberately does not parse the annotation store. A malformed store
 * makes the transactional document codec fail open, but it must not make
 * otherwise valid frontmatter appear as document prose. Invalid or unsupported
 * frontmatter remains byte-for-byte visible with the rest of the raw file.
 */
export function projectMarkdownPreview(content: string): MarkdownPreviewProjection {
  const opening = /^(?:\uFEFF)?---[ \t]*\r?\n/.exec(content);
  if (opening === null) return { body: content, metadata: [] };

  const afterOpening = content.slice(opening[0].length);
  const closing = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(afterOpening);
  if (closing === null) return { body: content, metadata: [] };

  const parsed = parseRestrictedFrontmatterYaml(afterOpening.slice(0, closing.index));
  if (!parsed.ok) return { body: content, metadata: [] };

  return {
    body: afterOpening.slice(closing.index + closing[0].length),
    metadata: Object.entries(parsed.data).map(([key, value]) => ({
      key,
      value: formatFrontmatterValue(value),
    })),
  };
}

function formatFrontmatterValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(formatFrontmatterValue).join(", ");
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  if (value === null) return "null";
  return String(value);
}
