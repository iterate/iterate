import type { RepoFileStatus } from "@iterate-com/ui/components/repo-file-tree";
import type { FileChangeSummary } from "@iterate-com/workspace-documents/change-summary";

/**
 * One task card, parsed from a markdown file under tasks/ in a repo mounted
 * in the workspace, the config repo by default (frontmatter
 * `state`/`labels`/`agent` plus title and body). `path` is the repo-relative
 * file path and doubles as the card id.
 */
export type TaskCard = {
  path: string;
  title: string;
  /** Canonical column: "todo" | "in-progress" | "in-review" | "done" (or a custom literal). */
  state: string;
  labels: string[];
  agent: string | null;
  /** Durable attribution: "Name <email>", or a /stream path (linked). */
  createdBy: string | null;
  /** Full markdown source of the file (frontmatter included) for the detail editor. */
  source: string;
  /** True when the file HAS a frontmatter block but its YAML fails to
   * parse — the file is then treated as plain text (no state/tags). */
  frontmatterError: boolean;
  /** Non-deleted comments in the file's discussion store (0 when the store
   * is absent or the file contains malformed RFM). */
  commentCount: number;
};

/** The canonical Kanban columns, in board order. Custom states get their own column after these. */
export const BOARD_COLUMNS = ["todo", "in-progress", "in-review", "done"] as const;

/** Uncommitted board status for a changed task path — the shared tree's status letters. */
export type TaskChangeStatus = RepoFileStatus;

/** What the commit UI (and the message writer) knows about one changed task. */
export type TaskChangeSummary = FileChangeSummary;
