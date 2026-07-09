import { Suspense, useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  FilesIcon,
  GitBranchIcon,
  GitCommitVerticalIcon,
  GithubIcon,
  HistoryIcon,
  MinusIcon,
  PlusIcon,
  Undo2Icon,
} from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { Input } from "@iterate-com/ui/components/input";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@iterate-com/ui/components/resizable";
import { toast } from "@iterate-com/ui/components/sonner";
import { isBinaryRepoPath } from "./repo-file-kinds.ts";
import { localFileToBase64, pickLocalFile } from "./local-file.ts";
import { CommitDiffPane } from "./commit-diff-pane.tsx";
import { CommitHistoryPanel } from "./commit-history-panel.tsx";
import { RepoEditorPane } from "./repo-editor-pane.tsx";
import { RepoGithubPanel } from "./repo-github-panel.tsx";
import { RepoFileTree, type RepoTreeActions } from "./repo-file-tree.tsx";
import {
  commitPlan,
  effectiveEntry,
  useWorkingTree,
  workingTreeStore,
  type FileEntry,
  type WorkingTreeChanges,
} from "./staged-changes.ts";
import { useItx, useItxQuery } from "~/itx/itx-react.tsx";

/**
 * The repo mini-IDE: pierre file tree + per-kind file renderers over one
 * repo's HEAD, with a persistent in-browser working tree (working + staged
 * slots per path, localStorage-backed per HEAD oid) committed through
 * `itx.repos.get(path).commitFiles` as a single batch.
 */
export function RepoIde({ projectId, repoPath }: { projectId: string; repoPath: string }) {
  const itx = useItx();
  const queryClient = useQueryClient();
  const files = useItxQuery({
    key: ["repo-files", projectId, repoPath],
    query: (itx) => itx.repos.get(repoPath).listFiles(),
  });
  const store = workingTreeStore({ projectId, repoPath, commitOid: files.commitOid });
  const changes = useWorkingTree(store);
  const headPaths = files.paths;
  const headPathSet = new Set(headPaths);
  const {
    file: selectedPath,
    diff,
    preview,
    scm,
    gh,
    stagedView,
    history,
    commit: expandedCommitOid,
    patchSearch,
  } = useRepoIdeSearch();

  const selectFile = useCallback(
    (path: string | undefined) =>
      patchSearch({ file: path, diff: undefined, preview: undefined, staged: undefined }),
    [patchSearch],
  );

  /** The current content of a path — live edit, staged snapshot, or HEAD on
   * the lane the extension calls for. Rename fuel. */
  const resolveEntry = async (path: string): Promise<FileEntry> => {
    const current = effectiveEntry(changes.get(path) ?? {});
    if (current !== undefined && current.type !== "delete") return current;
    const lane = isBinaryRepoPath(path) ? "base64" : "utf8";
    const read = await itx.repos.get(repoPath).readFile({ path, encoding: lane });
    if (read === null) throw new Error(`Repo file does not exist: "${path}".`);
    return lane === "base64"
      ? { type: "write-base64", contentBase64: read.content }
      : { type: "write", content: read.content };
  };

  const dropChange = (path: string) => {
    store.setWorking(path, undefined);
    store.setStaged(path, undefined);
  };

  const removePath = (path: string) => {
    // Deleting a not-yet-committed file just drops its change; deleting a
    // HEAD file stages the deletion in the working slot.
    if (headPathSet.has(path)) store.setWorking(path, { type: "delete" });
    else {
      dropChange(path);
      if (selectedPath === path) selectFile(undefined);
    }
  };

  const pathsUnder = (directoryPath: string) => {
    const prefix = `${directoryPath}/`;
    const affected = new Set<string>();
    for (const path of headPaths) if (path.startsWith(prefix)) affected.add(path);
    for (const [path, change] of changes) {
      if (effectiveEntry(change)?.type !== "delete" && path.startsWith(prefix)) affected.add(path);
    }
    return [...affected];
  };

  const actions: RepoTreeActions = {
    createFile: (path) => {
      store.setWorking(path, { type: "write", content: "" });
      selectFile(path);
    },
    discard: (path) => store.discardWorking(path),
    remove: (path, isFolder) => {
      for (const affected of isFolder ? pathsUnder(path) : [path]) removePath(affected);
    },
    rename: (fromPath, toPath, isFolder) => {
      void (async () => {
        const moves = isFolder
          ? pathsUnder(fromPath).map((path) => ({
              from: path,
              to: `${toPath}${path.slice(fromPath.length)}`,
            }))
          : [{ from: fromPath, to: toPath }];
        try {
          // Resolve every source BEFORE staging anything so a failed read
          // leaves the working tree untouched (the tree row already moved;
          // the path-sync effect heals it on the next change).
          const resolved = await Promise.all(
            moves.map(async (move) => ({ ...move, entry: await resolveEntry(move.from) })),
          );
          for (const move of resolved) {
            store.setWorking(move.to, move.entry);
            removePath(move.from);
          }
          // Follow the rename with the selection — including a file OPEN
          // INSIDE a renamed folder, which would otherwise show its old
          // path's deletion state.
          if (selectedPath === fromPath) selectFile(toPath);
          else if (
            isFolder &&
            selectedPath !== undefined &&
            selectedPath.startsWith(`${fromPath}/`)
          )
            selectFile(`${toPath}${selectedPath.slice(fromPath.length)}`);
        } catch (error) {
          toast.error(error instanceof Error ? error.message : "Could not rename.");
        }
      })();
    },
    upload: (directoryPath) => {
      void (async () => {
        const file = await pickLocalFile();
        if (!file) return;
        const path = directoryPath === "" ? file.name : `${directoryPath}/${file.name}`;
        try {
          store.setWorking(path, {
            type: "write-base64",
            contentBase64: await localFileToBase64(file),
          });
          selectFile(path);
        } catch (error) {
          toast.error(error instanceof Error ? error.message : "Could not read the picked file.");
        }
      })();
    },
  };

  const commit = useMutation({
    mutationFn: async (message: string) => {
      const plan = commitPlan(changes);
      const result = await itx.repos.get(repoPath).commitFiles({
        message,
        changes: plan.fileChanges,
      });
      return { plan, result };
    },
    onSuccess: async ({ plan, result }) => {
      if (plan.mode === "everything") store.discardAll();
      else store.clearStaged(plan.paths);
      // HEAD moved: surviving working edits belong under the new oid's
      // (localStorage) key. Migrate only AFTER the file-list refetch lands —
      // until then the component still reads AND WRITES the old-oid store, so
      // an earlier migrate would blank the visible working tree and lose any
      // edits made while the commit was in flight.
      await queryClient.invalidateQueries({
        queryKey: ["itx", "repo-files", projectId, repoPath],
      });
      // The commit list changed too (this commit is now its head). Per-commit
      // detail/content queries stay — they key by oid and are immutable.
      await queryClient.invalidateQueries({
        queryKey: ["itx", "repo-log", projectId, repoPath],
      });
      store.migrateTo(workingTreeStore({ projectId, repoPath, commitOid: result.commitOid }));
      toast.success(
        result.noChanges
          ? "No changes to commit."
          : `Committed ${result.changedPaths.length} file(s) to ${result.branch} (${result.commitOid.slice(0, 7)}).`,
      );
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Could not commit.");
    },
  });

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-row">
      {/* vscode-style activity strip: Files / Source control / History / GitHub. */}
      <div className="flex shrink-0 flex-col items-center gap-1 border-r px-1 py-2">
        <Button
          variant={scm || gh || history ? "ghost" : "secondary"}
          size="icon"
          title="Files"
          aria-label="Files"
          // The Files view browses working-tree files; leaving the SCM,
          // GitHub, or History view also leaves any pseudo-file (Index,
          // commit diff) it had open.
          onClick={() =>
            patchSearch({
              scm: undefined,
              gh: undefined,
              staged: undefined,
              history: undefined,
              commit: undefined,
            })
          }
          className="text-muted-foreground"
        >
          <FilesIcon className="size-4" />
        </Button>
        <Button
          variant={scm ? "secondary" : "ghost"}
          size="icon"
          title="Source control"
          // Explicit name: the dirty-count badge inside would otherwise BE the
          // accessible name ("1"), beating the title.
          aria-label="Source control"
          onClick={() =>
            patchSearch({ scm: true, gh: undefined, history: undefined, commit: undefined })
          }
          className="relative text-muted-foreground"
        >
          <GitBranchIcon className="size-4" />
          {changes.size === 0 ? null : (
            <span className="absolute -right-0.5 -top-0.5 grid size-4 place-items-center rounded-full bg-primary text-[9px] font-semibold text-primary-foreground">
              {changes.size}
            </span>
          )}
        </Button>
        <Button
          variant={history ? "secondary" : "ghost"}
          size="icon"
          title="History"
          onClick={() =>
            patchSearch({ history: true, scm: undefined, gh: undefined, staged: undefined })
          }
          className="text-muted-foreground"
        >
          <HistoryIcon className="size-4" />
        </Button>
        <Button
          variant={gh ? "secondary" : "ghost"}
          size="icon"
          title="GitHub"
          onClick={() =>
            patchSearch({ gh: true, scm: undefined, history: undefined, commit: undefined })
          }
          className="text-muted-foreground"
        >
          <GithubIcon className="size-4" />
        </Button>
      </div>

      <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
        <ResizablePanel defaultSize="20%" minSize="10rem" className="min-w-0">
          {history ? (
            <Suspense
              fallback={
                <div className="p-3 text-xs text-muted-foreground" data-spinner="true">
                  Loading history…
                </div>
              }
            >
              <CommitHistoryPanel
                projectId={projectId}
                repoPath={repoPath}
                expandedOid={expandedCommitOid}
                selectedPath={selectedPath}
                onExpand={(oid) => patchSearch({ commit: oid })}
                onOpenFile={(path) => patchSearch({ file: path })}
              />
            </Suspense>
          ) : gh ? (
            // Own Suspense (like RepoEditorPane's): the panel's first
            // connections read suspends, and without a local boundary that
            // would bubble to the route's ItxBoundary and blank the whole IDE.
            <Suspense
              fallback={
                <div className="p-3 text-xs text-muted-foreground" data-spinner="true">
                  Loading…
                </div>
              }
            >
              <RepoGithubPanel projectId={projectId} repoPath={repoPath} />
            </Suspense>
          ) : scm ? (
            <GitPanel
              changes={changes}
              headPathSet={headPathSet}
              commitPending={commit.isPending}
              onCommit={(message, reset) => commit.mutate(message, { onSuccess: reset })}
              onStage={(path) => store.stage(path)}
              onUnstage={(path) => store.unstage(path)}
              onDiscard={(path) => store.discardWorking(path)}
              onDiscardAll={() => store.discardAll()}
              onOpen={(path, status) =>
                patchSearch({
                  file: path,
                  diff: status === "modified" ? true : undefined,
                  preview: undefined,
                  staged: undefined,
                })
              }
              onOpenStaged={(path) =>
                patchSearch({ file: path, diff: undefined, preview: undefined, staged: true })
              }
            />
          ) : (
            <RepoFileTree
              className="h-full"
              headPaths={headPaths}
              changes={changes}
              selectedPath={selectedPath}
              onSelect={selectFile}
              actions={actions}
            />
          )}
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel className="flex min-w-0 flex-col">
          {selectedPath === undefined ? (
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
              Select a file to view or edit it.
            </div>
          ) : (
            <Suspense
              fallback={
                <div
                  className="flex flex-1 items-center justify-center text-sm text-muted-foreground"
                  data-spinner="true"
                >
                  Loading {selectedPath}…
                </div>
              }
            >
              {history && expandedCommitOid !== undefined ? (
                <CommitDiffPane
                  key={`${selectedPath}:${expandedCommitOid}`}
                  projectId={projectId}
                  repoPath={repoPath}
                  path={selectedPath}
                  commitOid={expandedCommitOid}
                />
              ) : (
                <RepoEditorPane
                  key={selectedPath}
                  projectId={projectId}
                  repoPath={repoPath}
                  path={selectedPath}
                  headCommitOid={files.commitOid}
                  headHasPath={headPathSet.has(selectedPath)}
                  change={changes.get(selectedPath)}
                  diffOpen={diff}
                  // Diff and preview are mutually exclusive views of the same
                  // buffer — turning one on turns the other off.
                  onToggleDiff={(open) =>
                    patchSearch({ diff: open ? true : undefined, preview: undefined })
                  }
                  previewOpen={preview}
                  onTogglePreview={(open) =>
                    patchSearch({ preview: open ? true : undefined, diff: undefined })
                  }
                  onSetWorking={(entry) => store.setWorking(selectedPath, entry)}
                  onSetStaged={(entry) => store.setStaged(selectedPath, entry)}
                  onStageFile={() => store.stage(selectedPath)}
                  onUnstageFile={() => {
                    store.unstage(selectedPath);
                    patchSearch({ staged: undefined });
                  }}
                  onOpenWorking={() =>
                    patchSearch({ staged: undefined, diff: undefined, preview: undefined })
                  }
                  stagedView={stagedView && changes.get(selectedPath)?.staged !== undefined}
                  onRestore={() => dropChange(selectedPath)}
                />
              )}
            </Suspense>
          )}
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}

/** The Source Control sidebar: commit box on top, then Staged Changes and
 * Changes — vscode's SCM view shape, including a file appearing in both when
 * it was edited again after staging. Commit takes the staged snapshots when
 * anything is staged, otherwise everything. */
function GitPanel({
  changes,
  headPathSet,
  commitPending,
  onCommit,
  onStage,
  onUnstage,
  onDiscard,
  onDiscardAll,
  onOpen,
  onOpenStaged,
}: {
  changes: WorkingTreeChanges;
  headPathSet: ReadonlySet<string>;
  commitPending: boolean;
  onCommit: (message: string, reset: () => void) => void;
  onStage: (path: string) => void;
  onUnstage: (path: string) => void;
  onDiscard: (path: string) => void;
  onDiscardAll: () => void;
  onOpen: (path: string, status: "added" | "deleted" | "modified") => void;
  onOpenStaged: (path: string) => void;
}) {
  const rowStatus = (path: string, entry: FileEntry) =>
    entry.type === "delete"
      ? ("deleted" as const)
      : headPathSet.has(path)
        ? ("modified" as const)
        : ("added" as const);

  const staged = [...changes].filter(([, change]) => change.staged !== undefined);
  const working = [...changes].filter(([, change]) => change.working !== undefined);
  const plan = commitPlan(changes);

  const row = (
    path: string,
    entry: FileEntry,
    buttons: React.ReactNode,
    onClick?: () => void,
  ): React.ReactNode => {
    const status = rowStatus(path, entry);
    return (
      <div
        key={path}
        className="group flex items-center gap-1.5 rounded-sm px-1.5 py-1 hover:bg-accent"
      >
        <button
          type="button"
          className="min-w-0 flex-1 truncate text-left font-mono text-xs"
          title={path}
          onClick={onClick ?? (() => onOpen(path, status))}
        >
          {path}
        </button>
        <span className="invisible flex items-center gap-0.5 group-hover:visible">{buttons}</span>
        <span
          className={
            status === "deleted"
              ? "font-mono text-xs font-semibold text-red-600"
              : status === "added"
                ? "font-mono text-xs font-semibold text-green-600"
                : "font-mono text-xs font-semibold text-blue-600"
          }
        >
          {status === "deleted" ? "D" : status === "added" ? "A" : "M"}
        </span>
      </div>
    );
  };

  const iconButton = (title: string, onClick: () => void, icon: React.ReactNode) => (
    <Button
      variant="ghost"
      size="icon-sm"
      title={title}
      onClick={onClick}
      // size-5, not icon-sm's size-7: the buttons must fit inside the row's
      // natural height or hovering makes every row jump taller.
      className="size-5 text-muted-foreground"
    >
      {icon}
    </Button>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <form
        className="flex shrink-0 flex-col gap-2 border-b p-2"
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const message = String(new FormData(form).get("message") || "").trim();
          if (message === "" || changes.size === 0) return;
          onCommit(message, () => form.reset());
        }}
      >
        <Input
          name="message"
          placeholder="Commit message"
          className="h-8 text-xs"
          disabled={changes.size === 0 || commitPending}
        />
        <Button
          type="submit"
          size="sm"
          disabled={changes.size === 0 || commitPending}
          className="text-xs"
        >
          <GitCommitVerticalIcon className="size-3.5" />
          {commitPending
            ? "Committing…"
            : plan.mode === "staged"
              ? `Commit ${plan.paths.length} staged`
              : `Commit ${plan.paths.length || ""}`}
        </Button>
      </form>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-2">
        {staged.length === 0 ? null : (
          <>
            <div className="flex items-center justify-between px-3 pb-1 pt-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Staged Changes
              </span>
              {iconButton(
                "Unstage all",
                () => staged.forEach(([path]) => onUnstage(path)),
                <MinusIcon className="size-3" />,
              )}
            </div>
            <div className="flex flex-col gap-0.5 px-1.5">
              {staged.map(([path, change]) =>
                row(
                  path,
                  change.staged!,
                  iconButton(
                    "Unstage change",
                    () => onUnstage(path),
                    <MinusIcon className="size-3" />,
                  ),
                  () => onOpenStaged(path),
                ),
              )}
            </div>
          </>
        )}
        <div className="flex items-center justify-between px-3 pb-1 pt-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Changes
          </span>
          {working.length === 0 ? null : (
            <span className="flex items-center gap-0.5">
              {iconButton("Discard all changes", onDiscardAll, <Undo2Icon className="size-3" />)}
              {iconButton(
                "Stage all changes",
                () => working.forEach(([path]) => onStage(path)),
                <PlusIcon className="size-3" />,
              )}
            </span>
          )}
        </div>
        <div className="flex flex-col gap-0.5 px-1.5">
          {working.length === 0 ? (
            <span className="px-1.5 py-2 text-xs text-muted-foreground">No changes.</span>
          ) : (
            working.map(([path, change]) =>
              row(
                path,
                change.working!,
                <>
                  {iconButton(
                    "Discard changes",
                    () => onDiscard(path),
                    <Undo2Icon className="size-3" />,
                  )}
                  {iconButton("Stage change", () => onStage(path), <PlusIcon className="size-3" />)}
                </>,
              ),
            )
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * IDE view state, URL-owned like every stream view's: `file` is the open
 * path, `diff` whether the HEAD↔staged diff is showing, `preview` whether a
 * markdown/html file shows its rendered preview instead of the editor,
 * `scm`/`gh`/`history` which sidebar shows instead of the file tree (Source
 * Control / GitHub / commit history), `commit` the expanded commit's oid
 * (which also pins the readonly commit diff the open file renders as). The
 * repo detail route validates these (RepoDetailSearch), so loose reads here
 * are safe.
 */
function useRepoIdeSearch() {
  const search = useSearch({ strict: false }) as {
    file?: string;
    diff?: boolean;
    preview?: boolean;
    scm?: boolean;
    gh?: boolean;
    staged?: boolean;
    history?: boolean;
    commit?: string;
  };
  const navigate = useNavigate();
  const patchSearch = useCallback(
    (patch: {
      file?: string | undefined;
      diff?: boolean | undefined;
      preview?: boolean | undefined;
      scm?: boolean | undefined;
      gh?: boolean | undefined;
      staged?: boolean | undefined;
      history?: boolean | undefined;
      commit?: string | undefined;
    }) => {
      void navigate({
        search: ((previous: Record<string, unknown>) => ({
          ...previous,
          ...patch,
        })) as unknown as never,
        replace: true,
      });
    },
    [navigate],
  );
  return {
    file: search.file,
    diff: search.diff === true,
    preview: search.preview === true,
    scm: search.scm === true,
    gh: search.gh === true,
    stagedView: search.staged === true,
    history: search.history === true,
    commit: search.commit,
    patchSearch,
  };
}
