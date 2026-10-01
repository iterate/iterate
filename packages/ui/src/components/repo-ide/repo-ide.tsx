import type { RepoLogEntry } from "iterate/api";
import { CommitDiffPane } from "./commit-diff-pane.tsx";
import { CommitHistoryPanel } from "./commit-history-panel.tsx";
import { EmptyPane, ErrorPane } from "./file-chrome.tsx";
import { GitPanel } from "./git-panel.tsx";
import { RepoEditorPane, type RepoFileHandlers } from "./repo-editor-pane.tsx";
import { RepoFileTree } from "./repo-file-tree.tsx";
import { RepoIdeActivityStrip } from "./repo-ide-activity-strip.tsx";
import type { RepoIdeSearch } from "./repo-ide-search.ts";
import {
  useRepoFiles,
  useRepoLog,
  type Read,
  type RepoFiles,
  type RepoProject,
} from "./repo-client.ts";
import {
  useWorkingTree,
  workingTreeGitStatus,
  workingTreeStore,
  type WorkingTreeChanges,
} from "./staged-changes.ts";
import { useRepoIdeActions } from "./use-repo-ide-actions.ts";

/**
 * The repo IDE: pierre file tree and a CodeMirror editor over one repo's HEAD, with a persistent
 * in-browser working tree (working and staged slots per path, kept in localStorage per HEAD oid)
 * committed through `itx.repos.get(path).commitFiles` as one batch. It fills the space its parent
 * gives it (a flex row with `min-h-0 flex-1`).
 *
 * The IDE's view state (open file, diff, preview, sidebar) is `search`, `RepoIdeSearch`, so a host
 * with a router keeps it in the URL and every view is a link; any host can hold it in state.
 */
export function RepoIde({
  project,
  projectId,
  repoPath,
  author,
  search,
  onSearchChange,
}: {
  /** The project's root context, as the signed-in app holds it. */
  project: RepoProject;
  projectId: string;
  /** `/repos/<name>` */
  repoPath: string;
  /** The commit's author: the person signed in; none leaves the repo's own default. */
  author: { name: string; email: string } | undefined;
  search: RepoIdeSearch;
  onSearchChange: (patch: Partial<RepoIdeSearch>) => void;
}) {
  const { state, reload } = useRepoFiles(project, repoPath);
  if (state.status === "failed") return <ErrorPane message={state.message} />;
  if (state.status === "pending") return <EmptyPane label="Loading repo…" spinner />;
  return (
    <LoadedRepoIde
      project={project}
      projectId={projectId}
      repoPath={repoPath}
      author={author}
      files={state.value}
      reload={reload}
      search={search}
      onSearchChange={onSearchChange}
    />
  );
}

function LoadedRepoIde({
  project,
  projectId,
  repoPath,
  author,
  files,
  reload,
  search,
  onSearchChange,
}: {
  project: RepoProject;
  projectId: string;
  repoPath: string;
  author: { name: string; email: string } | undefined;
  files: RepoFiles;
  reload: () => Promise<void>;
  search: RepoIdeSearch;
  onSearchChange: (patch: Partial<RepoIdeSearch>) => void;
}) {
  // a repo with no commit yet keys its working tree under "unborn"
  const store = workingTreeStore({ projectId, repoPath, commitOid: files.commitOid || "unborn" });
  const changes = useWorkingTree(store);
  const ide = useRepoIdeActions({
    project,
    projectId,
    repoPath,
    author,
    files,
    reload,
    store,
    changes,
    selectedPath: search.file,
    onSearchChange,
  });
  const commits = useRepoLog(project, repoPath, Boolean(search.history), files.commitOid);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-row">
      <RepoIdeActivityStrip
        search={search}
        changeCount={changes.size}
        onSearchChange={onSearchChange}
      />
      <div className="flex min-h-0 w-72 shrink-0 flex-col border-r">
        <RepoIdeSidebar
          project={project}
          repoPath={repoPath}
          files={files}
          commits={commits}
          changes={changes}
          store={store}
          ide={ide}
          search={search}
          onSearchChange={onSearchChange}
        />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <RepoIdeMain
          project={project}
          repoPath={repoPath}
          files={files}
          commits={commits}
          changes={changes}
          store={store}
          ide={ide}
          search={search}
          onSearchChange={onSearchChange}
        />
      </div>
    </div>
  );
}

type Ide = ReturnType<typeof useRepoIdeActions>;
type Store = ReturnType<typeof workingTreeStore>;

/** The sidebar the activity strip chose: the file tree, Source control, or History. */
function RepoIdeSidebar({
  project,
  repoPath,
  files,
  commits,
  changes,
  store,
  ide,
  search,
  onSearchChange,
}: {
  project: RepoProject;
  repoPath: string;
  files: RepoFiles;
  commits: Read<RepoLogEntry[]>;
  changes: WorkingTreeChanges;
  store: Store;
  ide: Ide;
  search: RepoIdeSearch;
  onSearchChange: (patch: Partial<RepoIdeSearch>) => void;
}) {
  if (search.history) {
    if (commits.status !== "loaded") {
      return (
        <div className="p-3 text-xs text-muted-foreground" data-spinner="true">
          {commits.status === "failed" ? commits.message : "Loading history…"}
        </div>
      );
    }
    return (
      <CommitHistoryPanel
        commits={commits.value}
        project={project}
        repoPath={repoPath}
        expandedOid={search.commit}
        selectedPath={search.file}
        onExpand={(oid) => onSearchChange({ commit: oid })}
        // selecting a file clears diff, preview and staged too, so a lingering preview does not
        // reopen for the file picked out of a commit; the commit stays expanded
        onOpenFile={ide.selectFile}
      />
    );
  }
  if (search.scm) {
    return (
      <GitPanel
        changes={changes}
        headPathSet={ide.headPathSet}
        commitPending={ide.committing}
        actions={{
          commit: (message, onCommitted) => void ide.commit(message, onCommitted),
          stage: (path) => store.stage(path),
          unstage: (path) => store.unstage(path),
          discard: ide.discardPath,
          discardAll: () => store.discardAll(),
          open: (path, status) =>
            onSearchChange({
              file: path,
              diff: status === "modified" ? true : undefined,
              preview: undefined,
              staged: undefined,
            }),
          openStaged: (path) =>
            onSearchChange({ file: path, diff: undefined, preview: undefined, staged: true }),
        }}
      />
    );
  }
  return (
    <RepoFileTree
      className="h-full"
      headPaths={files.paths}
      changes={
        new Map(
          workingTreeGitStatus(changes, ide.headPathSet).map((entry) => [entry.path, entry.status]),
        )
      }
      selectedPath={search.file}
      onSelect={ide.selectFile}
      actions={ide.treeActions}
    />
  );
}

/** The open file: the editor, or in History the commit's diff of it. */
function RepoIdeMain({
  project,
  repoPath,
  files,
  commits,
  changes,
  store,
  ide,
  search,
  onSearchChange,
}: {
  project: RepoProject;
  repoPath: string;
  files: RepoFiles;
  commits: Read<RepoLogEntry[]>;
  changes: WorkingTreeChanges;
  store: Store;
  ide: Ide;
  search: RepoIdeSearch;
  onSearchChange: (patch: Partial<RepoIdeSearch>) => void;
}) {
  const path = search.file;
  if (!path) return <EmptyPane label="Select a file to view or edit it." />;

  const expandedCommit =
    commits.status === "loaded" ? commits.value.find((c) => c.oid === search.commit) : undefined;
  if (search.history && expandedCommit) {
    return (
      <CommitDiffPane
        key={`${path}:${expandedCommit.oid}`}
        project={project}
        repoPath={repoPath}
        path={path}
        commit={expandedCommit}
      />
    );
  }

  const change = changes.get(path);
  const handlers: RepoFileHandlers = {
    setWorking: (entry) => store.setWorking(path, entry),
    setStaged: (entry) => store.setStaged(path, entry),
    discard: () => ide.discardPath(path),
    stage: () => store.stage(path),
    unstage: () => {
      store.unstage(path);
      onSearchChange({ staged: undefined });
    },
    openWorking: () => onSearchChange({ staged: undefined, diff: undefined, preview: undefined }),
    restore: () => ide.dropChange(path),
    // diff and preview are exclusive views of the same buffer: one on turns the other off
    setDiff: (open) => onSearchChange({ diff: open ? true : undefined, preview: undefined }),
    setPreview: (open) => onSearchChange({ preview: open ? true : undefined, diff: undefined }),
  };
  return (
    <RepoEditorPane
      key={path}
      project={project}
      repoPath={repoPath}
      path={path}
      headCommitOid={files.commitOid}
      headHasPath={ide.headPathSet.has(path)}
      change={change}
      view={{
        diff: Boolean(search.diff),
        preview: Boolean(search.preview),
        staged: Boolean(search.staged && change?.staged),
      }}
      handlers={handlers}
    />
  );
}
