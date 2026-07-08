import { Suspense, useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { GitCommitVerticalIcon, Trash2Icon } from "lucide-react";
import { Badge } from "@iterate-com/ui/components/badge";
import { Button } from "@iterate-com/ui/components/button";
import { Input } from "@iterate-com/ui/components/input";
import { Popover, PopoverContent, PopoverTrigger } from "@iterate-com/ui/components/popover";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@iterate-com/ui/components/resizable";
import { toast } from "@iterate-com/ui/components/sonner";
import { isBinaryRepoPath } from "./repo-file-kinds.ts";
import { localFileToBase64, pickLocalFile } from "./local-file.ts";
import { RepoEditorPane } from "./repo-editor-pane.tsx";
import { RepoFileTree, type RepoTreeActions } from "./repo-file-tree.tsx";
import {
  stagedChangesStore,
  stagedGitStatus,
  stagedRepoFileChanges,
  useStagedChanges,
  type StagedEntry,
} from "./staged-changes.ts";
import { useItx, useItxQuery } from "~/itx/itx-react.tsx";

/**
 * The repo mini-IDE: pierre file tree + per-kind file renderers over one
 * repo's HEAD, with an in-browser staged working tree committed through
 * `itx.repos.get(path).commitFiles` as a single batch.
 */
export function RepoIde({ projectId, repoPath }: { projectId: string; repoPath: string }) {
  const itx = useItx();
  const queryClient = useQueryClient();
  const store = stagedChangesStore({ projectId, repoPath });
  const changes = useStagedChanges(store);
  const files = useItxQuery({
    key: ["repo-files", projectId, repoPath],
    query: (itx) => itx.repos.get(repoPath).listFiles(),
  });
  const headPaths = files.paths;
  const headPathSet = new Set(headPaths);
  const { file: selectedPath, diff, patchSearch } = useRepoIdeSearch();

  const selectFile = useCallback(
    (path: string | undefined) => patchSearch({ file: path, diff: undefined }),
    [patchSearch],
  );

  /** The current content of a path as a staged entry — staged if dirty, else
   * read from HEAD on the lane the extension calls for. Rename fuel. */
  const resolveEntry = async (path: string): Promise<StagedEntry> => {
    const staged = changes.get(path);
    if (staged !== undefined && staged.type !== "delete") return staged;
    const lane = isBinaryRepoPath(path) ? "base64" : "utf8";
    const read = await itx.repos.get(repoPath).readFile({ path, encoding: lane });
    if (read === null) throw new Error(`Repo file does not exist: "${path}".`);
    return lane === "base64"
      ? { type: "write-base64", contentBase64: read.content }
      : { type: "write", content: read.content };
  };

  const removePath = (path: string) => {
    // Deleting a not-yet-committed file just discards it; deleting a HEAD
    // file stages the deletion.
    if (headPathSet.has(path)) store.stage(path, { type: "delete" });
    else store.discard(path);
    if (selectedPath === path && !headPathSet.has(path)) selectFile(undefined);
  };

  const pathsUnder = (directoryPath: string) => {
    const prefix = `${directoryPath}/`;
    const affected = new Set<string>();
    for (const path of headPaths) if (path.startsWith(prefix)) affected.add(path);
    for (const [path, entry] of changes) {
      if (entry.type !== "delete" && path.startsWith(prefix)) affected.add(path);
    }
    return [...affected];
  };

  const actions: RepoTreeActions = {
    createFile: (path) => {
      store.stage(path, { type: "write", content: "" });
      selectFile(path);
    },
    discard: (path) => store.discard(path),
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
          // leaves the staged map untouched (the tree row already moved; the
          // path-sync effect heals it on the next staged change).
          const resolved = await Promise.all(
            moves.map(async (move) => ({ ...move, entry: await resolveEntry(move.from) })),
          );
          for (const move of resolved) {
            store.stage(move.to, move.entry);
            removePath(move.from);
          }
          if (selectedPath === fromPath) selectFile(toPath);
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
          store.stage(path, { type: "write-base64", contentBase64: await localFileToBase64(file) });
          selectFile(path);
        } catch (error) {
          toast.error(error instanceof Error ? error.message : "Could not read the picked file.");
        }
      })();
    },
  };

  const commit = useMutation({
    mutationFn: async (message: string) => {
      return await itx.repos.get(repoPath).commitFiles({
        message,
        changes: stagedRepoFileChanges(changes),
      });
    },
    onSuccess: (result) => {
      store.discardAll();
      // New HEAD: refetch the file list; content queries key off its commitOid.
      void queryClient.invalidateQueries({
        queryKey: ["itx", "repo-files", projectId, repoPath],
      });
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
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
        <StagedChangesSummary
          changes={changes}
          headPathSet={headPathSet}
          onDiscard={(path) => store.discard(path)}
          onDiscardAll={() => store.discardAll()}
          onOpen={selectFile}
        />
        <form
          className="ml-auto flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const message = String(new FormData(form).get("message") || "").trim();
            if (message === "" || changes.size === 0) return;
            commit.mutate(message, { onSuccess: () => form.reset() });
          }}
        >
          <Input
            name="message"
            placeholder="Commit message"
            className="h-8 w-64 text-xs"
            disabled={changes.size === 0 || commit.isPending}
          />
          <Button
            type="submit"
            size="sm"
            disabled={changes.size === 0 || commit.isPending}
            className="text-xs"
          >
            <GitCommitVerticalIcon className="size-3.5" />
            {commit.isPending ? "Committing…" : "Commit"}
          </Button>
        </form>
      </div>

      <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
        <ResizablePanel defaultSize="20%" minSize="10rem" className="min-w-0">
          <RepoFileTree
            className="h-full"
            headPaths={headPaths}
            changes={changes}
            selectedPath={selectedPath}
            onSelect={selectFile}
            actions={actions}
          />
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
              <RepoEditorPane
                key={selectedPath}
                projectId={projectId}
                repoPath={repoPath}
                path={selectedPath}
                headCommitOid={files.commitOid}
                headHasPath={headPathSet.has(selectedPath)}
                staged={changes.get(selectedPath)}
                diffOpen={diff}
                onToggleDiff={(open) => patchSearch({ diff: open ? true : undefined })}
                onStage={(entry) => store.stage(selectedPath, entry)}
                onDiscard={() => store.discard(selectedPath)}
              />
            </Suspense>
          )}
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}

function StagedChangesSummary({
  changes,
  headPathSet,
  onDiscard,
  onDiscardAll,
  onOpen,
}: {
  changes: ReturnType<typeof useStagedChanges>;
  headPathSet: ReadonlySet<string>;
  onDiscard: (path: string) => void;
  onDiscardAll: () => void;
  onOpen: (path: string) => void;
}) {
  const statuses = stagedGitStatus(changes, headPathSet);
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button variant="ghost" size="sm" className="text-xs" disabled={changes.size === 0} />
        }
      >
        Changes
        <Badge variant={changes.size === 0 ? "outline" : "secondary"} className="text-[10px]">
          {changes.size}
        </Badge>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-96 p-2">
        <div className="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
          {statuses.map(({ path, status }) => (
            <div
              key={path}
              className="flex items-center gap-2 rounded-sm px-1.5 py-1 hover:bg-accent"
            >
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left font-mono text-xs"
                onClick={() => onOpen(path)}
              >
                {path}
              </button>
              <Badge
                variant={status === "deleted" ? "destructive" : "secondary"}
                className="text-[10px]"
              >
                {status}
              </Badge>
              <Button
                variant="ghost"
                size="icon-sm"
                title="Discard change"
                onClick={() => onDiscard(path)}
                className="text-muted-foreground"
              >
                <Trash2Icon className="size-3" />
              </Button>
            </div>
          ))}
        </div>
        <div className="mt-2 flex justify-end border-t pt-2">
          <Button variant="ghost" size="sm" className="text-xs" onClick={onDiscardAll}>
            Discard all
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * IDE view state, URL-owned like every stream view's: `file` is the open
 * path, `diff` whether the HEAD↔staged diff is showing. The repo detail route
 * validates these (RepoDetailSearch), so loose reads here are safe.
 */
function useRepoIdeSearch() {
  const search = useSearch({ strict: false }) as { file?: string; diff?: boolean };
  const navigate = useNavigate();
  const patchSearch = useCallback(
    (patch: { file?: string | undefined; diff?: boolean | undefined }) => {
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
  return { file: search.file, diff: search.diff === true, patchSearch };
}
