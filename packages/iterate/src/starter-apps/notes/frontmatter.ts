// A note IS a markdown file with YAML frontmatter (convergence decision D3/D4)
// — this module is the one place that composes and parses that shape. Unknown
// frontmatter keys are preserved on recompose: agents and humans may add
// their own fields, and the analysis write-back must never eat them.
//
// Mirrored by hand in apps/mobile/src/lib/notes.ts (the two runtimes can't
// share a module yet — same arrangement as media's filter logic).
import * as YAML from "yaml";

type NoteFile = {
  /** Parsed frontmatter, all keys preserved. Empty object when absent/broken. */
  frontmatter: Record<string, unknown>;
  /** Everything after the frontmatter block — the note text. */
  body: string;
};

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Tolerant parse: no frontmatter, or unparseable YAML, degrades to an empty
 * frontmatter object with the full content as body — a note must never
 * become unreadable because someone hand-edited its header badly. */
export function parseNoteFile(content: string): NoteFile {
  const match = content.match(FRONTMATTER_PATTERN);
  if (!match) return { frontmatter: {}, body: content };
  try {
    const parsed = YAML.parse(match[1]!);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { frontmatter: {}, body: content };
    }
    return { frontmatter: parsed as Record<string, unknown>, body: content.slice(match[0].length) };
  } catch {
    return { frontmatter: {}, body: content };
  }
}

export function composeNoteFile(frontmatter: Record<string, unknown>, body: string): string {
  if (Object.keys(frontmatter).length === 0) return body;
  return `---\n${YAML.stringify(frontmatter).trimEnd()}\n---\n${body}`;
}

/** The list/commit-message title: frontmatter title, else the body's first
 * non-blank line — same fallback the phone shows while analysis is pending. */
export function noteDisplayTitle(note: NoteFile): string {
  const title = note.frontmatter.title;
  if (typeof title === "string" && title.trim() !== "") return title.trim();
  return (note.body.split("\n").find((line) => line.trim() !== "") || "").trim().slice(0, 80);
}
