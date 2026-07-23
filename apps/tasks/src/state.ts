/**
 * One task card, parsed from a markdown file under tasks/ in the project's
 * /repos/config repo (frontmatter `state`/`labels`/`agent` plus title and
 * body). `path` is the repo-relative file path and doubles as the card id.
 */
export type TaskCard = {
  path: string;
  title: string;
  /** Canonical column: "todo" | "in-progress" | "in-review" | "done" (or a custom literal). */
  state: string;
  labels: string[];
  agent: string | null;
  /** Full markdown source of the file (frontmatter included) for the detail editor. */
  source: string;
  /** True when the file HAS a frontmatter block but its YAML fails to
   * parse — the file is then treated as plain text (no state/tags). */
  frontmatterError: boolean;
};

/** The canonical Kanban columns, in board order. Custom states get their own column after these. */
export const BOARD_COLUMNS = ["todo", "in-progress", "in-review", "done"] as const;

/** One repo file mutation — the wire shape `commitFiles` takes. */
export type RepoFileChange =
  | { path: string; content: string }
  | {
      path: string;
      /** Standard base64 of the file's raw bytes — the binary write lane. */
      contentBase64: string;
    }
  | { path: string; delete: true };

/** Uncommitted board status for a changed task path (working or staged). */
export type TaskChangeStatus = "added" | "modified" | "deleted";

/** What the commit UI (and the AI message generator) knows about one change. */
export type TaskChangeSummary = { path: string; status: TaskChangeStatus; title: string };

/** What one `commitFiles` batch reported back. */
export type CommitResult = {
  branch: string;
  changedPaths: string[];
  commitOid: string;
  noChanges: boolean;
};

