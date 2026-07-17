import { Suspense } from "react";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useItxQuery } from "iterate/react";
import type { RepoCommitFileChange } from "~/domains/repos/types.ts";
import { formatTimeAgo } from "~/lib/format-relative-time.ts";

/**
 * The History sidebar of the repo mini-IDE: a linear newest-first commit list
 * ("Git Graph" minus the graph — repos are single-branch). Expanding a row
 * lazily fetches `commitDetails` (metadata + changed files with +/- counts);
 * clicking a changed file opens the readonly parent-vs-commit diff pane.
 */
export function CommitHistoryPanel({
  projectId,
  repoPath,
  expandedOid,
  selectedPath,
  onExpand,
  onOpenFile,
}: {
  projectId: string;
  repoPath: string;
  /** The commit whose row is expanded (URL-owned view state). */
  expandedOid: string | undefined;
  /** The file open in the diff pane, to highlight its row. */
  selectedPath: string | undefined;
  onExpand: (oid: string | undefined) => void;
  onOpenFile: (path: string) => void;
}) {
  const log = useItxQuery({
    key: ["repo-log", projectId, repoPath],
    query: (itx) => itx.repos.get(repoPath).log({ limit: 50 }),
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between border-b px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          History
        </span>
        <span className="text-[11px] text-muted-foreground">
          {log.branch} · {log.commits.length} commit{log.commits.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {log.commits.map((commit) => {
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
                    <span className="shrink-0">
                      {formatTimeAgo(new Date(commit.timestamp).toISOString())}
                    </span>
                    <span className="ml-auto shrink-0 font-mono">{commit.oid.slice(0, 7)}</span>
                  </span>
                </span>
              </button>
              {expanded ? (
                <Suspense
                  fallback={
                    <div
                      className="px-8 py-2 text-[11px] text-muted-foreground"
                      data-spinner="true"
                    >
                      Loading commit…
                    </div>
                  }
                >
                  <ExpandedCommit
                    projectId={projectId}
                    repoPath={repoPath}
                    commitOid={commit.oid}
                    selectedPath={selectedPath}
                    onOpenFile={onOpenFile}
                  />
                </Suspense>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The expanded commit body: full metadata + changed files with +/- counts. */
function ExpandedCommit({
  projectId,
  repoPath,
  commitOid,
  selectedPath,
  onOpenFile,
}: {
  projectId: string;
  repoPath: string;
  commitOid: string;
  selectedPath: string | undefined;
  onOpenFile: (path: string) => void;
}) {
  const details = useItxQuery({
    // Keyed by oid only (not HEAD): a commit's diff against its parent is
    // immutable, so this never needs invalidation.
    key: ["repo-commit", projectId, repoPath, commitOid],
    query: (itx) => itx.repos.get(repoPath).commitDetails({ commitOid }),
  });

  return (
    <div className="mx-2 mb-1.5 flex flex-col gap-1.5 rounded-sm border bg-muted/30 px-2.5 py-2">
      <p className="whitespace-pre-wrap text-xs">{details.message}</p>
      <div className="flex flex-col gap-0.5 text-[11px] text-muted-foreground">
        <span className="truncate" title={details.author.email}>
          {details.author.name} &lt;{details.author.email}&gt;
        </span>
        <span>{new Date(details.timestamp).toLocaleString()}</span>
        <span className="font-mono">
          {details.oid.slice(0, 7)}
          {details.parentOid === null ? " (root commit)" : ` ← ${details.parentOid.slice(0, 7)}`}
        </span>
      </div>
      <div className="flex flex-col gap-0.5 border-t pt-1.5">
        {details.files.map((file) => (
          <ChangedFileRow
            key={file.path}
            file={file}
            selected={file.path === selectedPath}
            onOpen={() => onOpenFile(file.path)}
          />
        ))}
        {details.files.length === 0 ? (
          <span className="text-[11px] text-muted-foreground">No file changes.</span>
        ) : null}
      </div>
    </div>
  );
}

function ChangedFileRow({
  file,
  selected,
  onOpen,
}: {
  file: RepoCommitFileChange;
  selected: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className={`flex items-center gap-1.5 rounded-sm px-1 py-0.5 text-left hover:bg-accent ${selected ? "bg-accent" : ""}`}
      title={file.path}
      onClick={onOpen}
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
      {file.binary ? (
        <span className="shrink-0 text-[10px] text-muted-foreground">binary</span>
      ) : (
        <span className="flex shrink-0 items-center gap-1 font-mono text-[11px]">
          <span className="text-green-600">+{file.additions}</span>
          <span className="text-red-600">−{file.deletions}</span>
        </span>
      )}
    </button>
  );
}
