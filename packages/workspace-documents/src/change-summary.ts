import type { RepoFileStatus } from "@iterate-com/ui/components/repo-file-tree";

/** What the commit UI (and a commit-message writer) knows about one changed file. */
export type FileChangeSummary = { path: string; status: RepoFileStatus; title: string };

/**
 * A deterministic one-line commit message for a change set: "Add x, update
 * 3 files, delete y". `noun` names the things being committed ("files",
 * "tasks").
 */
export function fallbackCommitMessage(
  changes: readonly FileChangeSummary[],
  noun = "files",
): string {
  if (changes.length === 0) return `Update ${noun}`;
  const added = changes.filter((change) => change.status === "added");
  const modified = changes.filter((change) => change.status === "modified");
  const deleted = changes.filter((change) => change.status === "deleted");
  const parts: string[] = [];
  if (added.length === 1) parts.push(`add ${added[0]!.title}`);
  else if (added.length > 1) parts.push(`add ${added.length} ${noun}`);
  if (modified.length === 1) parts.push(`update ${modified[0]!.title}`);
  else if (modified.length > 1) parts.push(`update ${modified.length} ${noun}`);
  if (deleted.length === 1) parts.push(`delete ${deleted[0]!.title}`);
  else if (deleted.length > 1) parts.push(`delete ${deleted.length} ${noun}`);
  const body = parts.join(", ");
  return body === "" ? `Update ${noun}` : `${body[0]!.toUpperCase()}${body.slice(1)}`;
}
