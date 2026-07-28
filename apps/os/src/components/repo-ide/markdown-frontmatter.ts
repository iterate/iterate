import { parseDocument, type Document } from "yaml";

function parseMarkdownFrontmatter(content: string): {
  body: string;
  document: Document;
  exists: boolean;
} {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(content);
  if (match === null) return { body: content, document: parseDocument(""), exists: false };
  return {
    body: content.slice(match[0].length),
    document: parseDocument(match[1] ?? ""),
    exists: true,
  };
}

function markdownFrontmatterRecord(document: Document): Record<string, unknown> {
  try {
    const value: unknown = document.toJS();
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    // YAML deliberately returns unknown; the guards above prove the record
    // shape, and copying it would only add work without improving safety.
    return value as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function projectMarkdownPreview(content: string): {
  body: string;
  metadata: Array<{ key: string; value: string }>;
} {
  const frontmatter = parseMarkdownFrontmatter(content);
  if (!frontmatter.exists || frontmatter.document.errors.length > 0)
    return { body: content, metadata: [] };
  return {
    body: frontmatter.body,
    metadata: Object.entries(markdownFrontmatterRecord(frontmatter.document)).map(
      ([key, value]) => ({
        key,
        value: formatFrontmatterValue(value),
      }),
    ),
  };
}

function formatFrontmatterValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(formatFrontmatterValue).join(", ");
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  if (value === null) return "null";
  return String(value);
}
