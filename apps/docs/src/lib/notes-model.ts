/**
 * Notes: plain Markdown files in a repo's `notes/` folder, edited directly.
 * One of them is special only in how it is opened — the long-running log,
 * Reflect's daily notes minus everything but the dates: the app appends a
 * `## YYYY-MM-DD` heading at its tail when the day changes, so opening it
 * always lands you under today. Dates are the WRITER's local calendar — a
 * log is a diary, not an audit trail (the commit carries the exact time).
 */

/** The folder, repo-relative. */
export const NOTES_DIR = "notes";

/** The long-running note that opens by default. */
export const DEFAULT_NOTE = `${NOTES_DIR}/log.md`;

const DAY_HEADING = /^## (\d{4}-\d{2}-\d{2})\s*$/;

/** YYYY-MM-DD in local time. */
export function logDateStamp(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The date of the LAST day heading in the file, or null when it has none. */
export function lastLogDate(content: string): string | null {
  let last: string | null = null;
  for (const line of content.split("\n")) {
    const match = DAY_HEADING.exec(line);
    if (match !== null) last = match[1]!;
  }
  return last;
}

/**
 * The log with today's heading at its tail — unchanged when the last day
 * heading already is today, otherwise the heading appended after one blank
 * line (trailing blank lines are folded into it) and followed by the blank
 * line the caret lands on. A missing file starts with just the heading.
 */
export function ensureTodayHeading(content: string | null, date: string): string {
  const current = content ?? "";
  if (lastLogDate(current) === date) return current;
  const body = current.replace(/\s+$/, "");
  return `${body === "" ? "" : `${body}\n\n`}## ${date}\n\n`;
}

/** One commit per day for everything under notes/: the message names the day. */
export function notesCommitMessage(date: string): string {
  return `Notes: ${date}`;
}

/**
 * The repo-relative note paths a workspace status reports as changed under
 * one repo mount — the dirty set the header and the list dots show. Only
 * notes/ counts: the board's own change map keeps task files, so it is the
 * wrong lens here (it would drop every note).
 */
export function noteChangesFrom(status: unknown, repoPath: string): Set<string> {
  const changed = new Set<string>();
  // status() is typed unknown on purpose (tasks-api.ts: workspace-wide,
  // each consumer reads what it needs). The platform's WorkspaceStatus is
  // `{ mounts: [{ path, changes: [{ change, path }] }], unmounted }`
  // (apps/os workspaces/types.ts); only those fields are read here, every
  // level tolerates absence, and a path is always a string there.
  const mounts = (status as { mounts?: { changes?: { path: string }[]; path?: string }[] }).mounts;
  for (const mount of mounts ?? []) {
    if (mount.path !== repoPath) continue;
    for (const change of mount.changes ?? []) {
      const key = change.path.slice(repoPath.length).replace(/^\/+/, "");
      if (key.startsWith(`${NOTES_DIR}/`)) changed.add(key);
    }
  }
  return changed;
}

/** A new note's file, from its title: lowercase, dashes, `.md`. */
export function noteFileName(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${NOTES_DIR}/${slug === "" ? "note" : slug}.md`;
}

/** What the list calls a note: the log by name, others by file stem. */
export function noteLabel(path: string): string {
  if (path === DEFAULT_NOTE) return "Log";
  return path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
}
