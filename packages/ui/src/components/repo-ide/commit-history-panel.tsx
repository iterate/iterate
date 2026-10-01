import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import type { RepoLogEntry } from "iterate/api";
import { readChangedFiles, useRead, type RepoProject } from "./repo-client.ts";

/** A moment as `2026-09-30 15:39 UTC`: the same on the server and in the browser, whatever the
 *  reader's locale. */
function utcStamp(timestamp: number) {
  return `${new Date(timestamp).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** How long ago, in the coarsest whole unit. */
function timeAgo(timestamp: number) {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  for (const [unit, size] of [
    ["d", 86_400],
    ["h", 3_600],
    ["m", 60],
  ] as const) {
    if (seconds >= size) return `${Math.floor(seconds / size)}${unit} ago`;
  }
  return "just now";
}

/**
 * The History sidebar of the repo IDE: a linear newest-first commit list (repos are single-branch,
 * so no graph). Expanding a row reads the files the commit changed; clicking one opens the
 * readonly parent-against-commit diff.
 */
export function CommitHistoryPanel({
  commits,
  project,
  repoPath,
  expandedOid,
  selectedPath,
  onExpand,
  onOpenFile,
}: {
  commits: RepoLogEntry[];
  project: RepoProject;
  repoPath: string;
  /** The commit whose row is expanded (URL-owned view state). */
  expandedOid: string | undefined;
  /** The file open in the diff pane, to highlight its row. */
  selectedPath: string | undefined;
  onExpand: (oid: string | undefined) => void;
  onOpenFile: (path: string) => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between border-b px-3 py-2">
        <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          History
        </span>
        <span className="text-[11px] text-muted-foreground">
          main · {commits.length} commit{commits.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {commits.map((commit) => {
          const expanded = commit.oid === expandedOid;
          return (
            <div key={commit.oid}>
              <button
                type="button"
                className="flex w-full items-start gap-1.5 px-2 py-1.5 text-left hover:bg-accent"
                onClick={() => onExpand(expanded ? undefined : commit.oid)}
              >
                {expanded ? (
                  <ChevronDownIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRightIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-xs" title={commit.message}>
                    {commit.message.split("\n")[0]}
                  </span>
                  <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <span className="min-w-0 truncate">{commit.author.name}</span>
                    <span className="shrink-0">{timeAgo(commit.timestamp)}</span>
                    <span className="ml-auto shrink-0 font-mono">{commit.oid.slice(0, 7)}</span>
                  </span>
                </span>
              </button>
              {expanded ? (
                <ExpandedCommit
                  commit={commit}
                  project={project}
                  repoPath={repoPath}
                  selectedPath={selectedPath}
                  onOpenFile={onOpenFile}
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The expanded commit: its full message, author, and the files it changed. */
function ExpandedCommit({
  commit,
  project,
  repoPath,
  selectedPath,
  onOpenFile,
}: {
  commit: RepoLogEntry;
  project: RepoProject;
  repoPath: string;
  selectedPath: string | undefined;
  onOpenFile: (path: string) => void;
}) {
  // a commit's diff against its parent never changes, so it is read once per expansion
  const files = useRead(
    () => readChangedFiles(project, repoPath, commit),
    [project, repoPath, commit.oid],
  );
  const parent = commit.parents[0];
  return (
    <div className="mx-2 mb-1.5 flex flex-col gap-1.5 rounded-sm border bg-muted/30 px-2.5 py-2">
      <p className="text-xs whitespace-pre-wrap">{commit.message}</p>
      <div className="flex flex-col gap-0.5 text-[11px] text-muted-foreground">
        <span className="truncate" title={commit.author.email}>
          {commit.author.name} &lt;{commit.author.email}&gt;
        </span>
        <span>{utcStamp(commit.timestamp)}</span>
        <span className="font-mono">
          {commit.oid.slice(0, 7)}
          {!parent ? " (root commit)" : ` ← ${parent.slice(0, 7)}`}
        </span>
      </div>
      <div className="flex flex-col gap-0.5 border-t pt-1.5">
        {files.status === "pending" ? (
          <span className="text-[11px] text-muted-foreground" data-spinner="true">
            Loading commit…
          </span>
        ) : files.status === "failed" ? (
          <span role="alert" data-type="error" className="text-[11px] text-destructive">
            {files.message}
          </span>
        ) : files.value.length === 0 ? (
          <span className="text-[11px] text-muted-foreground">No file changes.</span>
        ) : (
          files.value.map((file) => (
            <button
              key={file.path}
              type="button"
              className={`flex items-center gap-1.5 rounded-sm px-1 py-0.5 text-left hover:bg-accent ${file.path === selectedPath ? "bg-accent" : ""}`}
              title={file.path}
              onClick={() => onOpenFile(file.path)}
            >
              <span
                className={
                  file.status === "deleted"
                    ? "w-3 shrink-0 font-mono text-xs font-semibold text-red-600"
                    : file.status === "added"
                      ? "w-3 shrink-0 font-mono text-xs font-semibold text-green-600"
                      : "w-3 shrink-0 font-mono text-xs font-semibold text-blue-600"
                }
              >
                {file.status === "deleted" ? "D" : file.status === "added" ? "A" : "M"}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{file.path}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
