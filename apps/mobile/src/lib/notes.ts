// Notes, convergence edition: a note IS a markdown file with YAML
// frontmatter in the project's dedicated notes repo, written through the
// notes workspace (fast overlay writes; the server's NotesApp analyzes into
// frontmatter and commits to git). Pure logic only (no Expo imports) so
// vitest covers it in root CI; the composer and notes screen wire it to itx.
//
// The list is FILE-derived (glob + readFiles + parse — files are truth);
// events on the workspace's stream are the live invalidation signal, not a
// data source. Frontmatter helpers mirror the server's
// packages/iterate/src/starter-apps/notes/frontmatter.ts by hand (the two
// runtimes can't share a module yet — same arrangement as media's filter).

import type { StreamEvent } from "iterate/sdk/itx/react";
import * as YAML from "yaml";

export const NOTES_WORKSPACE_PATH = "/workspaces/notes";
export const NOTES_REPO_PATH = "/repos/notes";

export const NOTE_CAPTURED_EVENT_TYPE = "events.iterate.com/notes/captured";
export const NOTE_UPDATED_EVENT_TYPE = "events.iterate.com/notes/updated";
export const NOTE_ANALYSIS_SETTLED_EVENT_TYPE = "events.iterate.com/notes/analysis-settled";
export const NOTE_REANALYZE_EVENT_TYPE = "events.iterate.com/notes/reanalyze-requested";
export const NOTE_DELETED_EVENT_TYPE = "events.iterate.com/notes/deleted";
/** The facts that change what the list shows — each one invalidates the
 * file-derived list query. */
export const NOTE_EVENT_TYPES = [
  NOTE_CAPTURED_EVENT_TYPE,
  NOTE_UPDATED_EVENT_TYPE,
  NOTE_ANALYSIS_SETTLED_EVENT_TYPE,
  NOTE_DELETED_EVENT_TYPE,
];

export type NoteAttachment = {
  /** itx.files path holding the bytes — mediaFilePath shape, shared with /media. */
  path: string;
  filename: string;
  contentType: string;
  width: number;
  height: number;
};

/** `/repos/notes/2026-08-12T15-01-20-841Z-x7ab.md` — sortable by name
 * (newest last lexicographically), collision-proofed by entropy, and
 * deterministic per capture so a retried write hits the same path. */
export function noteFilePath(capturedAtIso: string, entropy: string): string {
  return `${NOTES_REPO_PATH}/${capturedAtIso.replace(/[:.]/g, "-")}-${entropy}.md`;
}

/** Only stamp-named files are notes. The notes repo is born with the project
 * config template in it (`create({type:"empty"})` seeds it — platform quirk,
 * flagged separately), and agents may add arbitrary files later; the list
 * must never render ONBOARDING.md as a note. */
export function isNoteFilePath(path: string): boolean {
  return /^\/repos\/notes\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[^/]+\.md$/.test(path);
}

// --- frontmatter (hand-mirrored from the server module) ---

export type NoteFile = {
  frontmatter: Record<string, unknown>;
  body: string;
};

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

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
  if (!Object.keys(frontmatter).length) return body;
  return `---\n${YAML.stringify(frontmatter).trimEnd()}\n---\n${body}`;
}

// --- the list ---

export type NoteListItem = {
  /** The note's identity: its file path in the notes repo. */
  path: string;
  /** Frontmatter capturedAt, else nothing better than the filename stamp. */
  capturedAt: string;
  /** Analysis-written title ("" until it lands or when hand-removed). */
  title: string;
  tags: string[];
  attachments: NoteAttachment[];
  /** The note text (frontmatter stripped). */
  text: string;
  /** Title, else the text's first line — what the row shows. */
  displayTitle: string;
  /** Every other frontmatter key (agents may add their own) — kept so edits
   * recompose losslessly. */
  frontmatter: Record<string, unknown>;
};

export function parseNoteListItem(path: string, content: string): NoteListItem {
  const { frontmatter, body } = parseNoteFile(content);
  const title = typeof frontmatter.title === "string" ? frontmatter.title.trim() : "";
  const tags = Array.isArray(frontmatter.tags)
    ? frontmatter.tags.filter((tag): tag is string => typeof tag === "string")
    : [];
  const attachments = Array.isArray(frontmatter.attachments)
    ? frontmatter.attachments.filter(
        (attachment: any): attachment is NoteAttachment =>
          typeof attachment?.path === "string" && typeof attachment?.contentType === "string",
      )
    : [];
  return {
    path,
    capturedAt:
      typeof frontmatter.capturedAt === "string"
        ? frontmatter.capturedAt
        : stampFromPath(path) || "",
    title,
    tags,
    attachments,
    text: body,
    displayTitle: title || noteFirstLine(body),
    frontmatter,
  };
}

/** Files → list items, newest first (the stamp-prefixed filename sorts).
 * Non-note files (the seeded template, agent-authored extras) are skipped. */
export function deriveNotesList(files: Record<string, string | null>): NoteListItem[] {
  return Object.entries(files)
    .filter((entry): entry is [string, string] => !!entry[1] && isNoteFilePath(entry[0]))
    .map(([path, content]) => parseNoteListItem(path, content))
    .sort((a, b) => b.path.localeCompare(a.path));
}

export function noteFirstLine(text: string): string {
  return (text.split("\n").find((line) => line.trim() !== "") || "").trim().slice(0, 80);
}

function stampFromPath(path: string): string | null {
  // 2026-08-12T15-01-20-841Z from the filename → best-effort ISO.
  const stem = path.split("/").at(-1) || "";
  const match = stem.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/);
  if (!match) return null;
  return `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`;
}

/**
 * Every whitespace-separated query term must appear in the title, text,
 * attachment filenames, or tags.
 */
export function filterNotes(items: NoteListItem[], query: string): NoteListItem[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((item) => {
    const haystack =
      `${item.title} ${item.text} ${item.attachments.map((a) => a.filename).join(" ")} ${item.tags.join(" ")}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

// --- event builders (facts appended AFTER the file write) ---

export function buildCapturedEvent(path: string) {
  return {
    type: NOTE_CAPTURED_EVENT_TYPE,
    // Keyed by the note's identity so a retried append (flaky network,
    // double-tapped send, a re-drained pending note) folds to one fact.
    idempotencyKey: `notes-captured-${path}`,
    payload: { path },
  };
}

export function buildUpdatedEvent(path: string, nonce: string) {
  return {
    type: NOTE_UPDATED_EVENT_TYPE,
    // Each deliberate edit is its own fact.
    idempotencyKey: `notes-updated-${path}-${nonce}`,
    payload: { path },
  };
}

export function buildDeletedEvent(path: string) {
  return {
    type: NOTE_DELETED_EVENT_TYPE,
    // Per-note, not per-invocation: deleting twice is one tombstone.
    idempotencyKey: `notes-deleted-${path}`,
    payload: { path },
  };
}

export function buildReanalyzeEvent(path: string, nonce: string) {
  return {
    type: NOTE_REANALYZE_EVENT_TYPE,
    // Each deliberate re-run is its own fact.
    idempotencyKey: `notes-reanalyze-${path}-${nonce}`,
    payload: { path },
  };
}

/** The newest offset among note facts — the file-list query keys on this so
 * every new fact triggers a refetch (events are the live signal; files are
 * the data). */
export function latestNoteFactOffset(events: StreamEvent[]): number {
  return events.reduce((max, event) => Math.max(max, event.offset), 0);
}
