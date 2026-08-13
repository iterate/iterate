import type { TaskCard } from "../state.ts";
import type { TaskChangeStatus } from "../state.ts";
import { parseTaskCard } from "../tasks-model.ts";

/** A card plus what the board needs to place and preview it. */
export type BoardTask = TaskCard & {
  /** Grouping key: "/" for files directly under tasks/, else "/sub/dir". */
  folder: string;
  /** First body line after the heading, for the card's excerpt. */
  summary: string;
  /** Source offset of the rendered title (null when not from the heading). */
  titleFrom: number | null;
  /** Source offset of the summary line's first rendered character. */
  summaryFrom: number;
};

export type PresenceUser = { name: string; color: string };

/** Board swimlane grouping: folder rows, tag rows, or one flat row. */
export type RowField = "folder" | "label" | null;

export function stateLabel(state: string): string {
  switch (state) {
    case "todo":
      return "Todo";
    case "in-progress":
      return "In progress";
    case "in-review":
      return "In review";
    case "done":
      return "Done";
    default:
      return state;
  }
}

export function toBoardTask(path: string, source: string): BoardTask {
  const card = parseTaskCard(path, source);
  const summary = taskSummary(source);
  return {
    ...card,
    folder: taskFolder(path),
    summary: summary.text,
    summaryFrom: summary.from,
    titleFrom: titleOffset(source, card.title),
  };
}

/** Where the heading-derived title starts in the source, for highlighting. */
function titleOffset(source: string, title: string): number | null {
  const heading = /^#\s+(.+?)\s*#*\s*$/m.exec(source);
  if (!heading || heading[1] !== title) return null;
  return heading.index + heading[0].indexOf(heading[1]!);
}

/** A task's folder is simply its DIRECTORY — the whole path minus the
 * filename: `tasks/design/board-parity.md` → `tasks/design`,
 * `apps/some-app/tasks/banana.md` → `apps/some-app/tasks`. */
function taskFolder(path: string): string {
  const segments = path.split("/").filter(Boolean);
  return segments.slice(0, -1).join("/") || "tasks";
}

/** Rebuild a task's path for a (possibly different) folder, keeping the
 * filename. Always emits a NORMALIZED path — split/filter makes double
 * slashes unrepresentable. */
export function taskPathInFolder(path: string, folder: string): string {
  const filename = path.split("/").filter(Boolean).at(-1) ?? path;
  return [...folder.split("/").filter(Boolean), filename].join("/");
}

function taskSummary(source: string): { text: string; from: number } {
  const frontmatter = /^---[ \t]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(source);
  const bodyOffset = frontmatter?.[0].length ?? 0;
  const body = source.slice(bodyOffset);
  let lineOffset = 0;
  for (const line of body.split("\n")) {
    // The discussion store at EOF is not card-summary material.
    if (line.startsWith("<!-- task-")) break;
    const trimmed = line.trim();
    if (trimmed !== "" && !trimmed.startsWith("#")) {
      const from = bodyOffset + lineOffset + line.indexOf(trimmed);
      return {
        text: trimmed.length > 160 ? `${trimmed.slice(0, 160)}…` : trimmed,
        from,
      };
    }
    lineOffset += line.length + 1;
  }
  return { text: "", from: bodyOffset };
}

/** Optimistic change-status transition for a local write: a path the board
 * has never seen is an ADD; a known one keeps its status (added stays
 * added) or becomes modified. */
export function changeAfterWrite(
  current: TaskChangeStatus | undefined,
  known: boolean,
): TaskChangeStatus {
  // Recreating a deleted file: it existed at base, so the live copy is a
  // modification again — never a lingering deleted badge.
  if (current === "deleted") return "modified";
  if (current) return current;
  return known ? "modified" : "added";
}

/** Optimistic transition for a local delete: deleting an uncommitted ADD
 * erases the change entirely (nothing existed at base); anything else is a
 * deletion. Returns null to clear the entry. */
export function changeAfterDelete(current: TaskChangeStatus | undefined): TaskChangeStatus | null {
  return current === "added" ? null : "deleted";
}

/** First free path for a desired task file: the path itself, else the
 * filename suffixed -2, -3, … — two tasks must never collapse onto one
 * file through adds, drags, or renames. */
export function unclaimedPath(desired: string, taken: (path: string) => boolean): string {
  if (!taken(desired)) return desired;
  const segments = desired.split("/");
  const filename = segments.pop() ?? desired;
  const stem = filename.replace(/\.md$/i, "");
  for (let suffix = 2; ; suffix++) {
    const candidate = [...segments, `${stem}-${suffix}.md`].join("/");
    if (!taken(candidate)) return candidate;
  }
}
