import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";
import type YProvider from "y-partyserver/provider";
import { SidebarTrigger } from "@iterate-com/ui/components/sidebar";
import { Skeleton } from "@iterate-com/ui/components/skeleton";
import {
  DEFAULT_REPO_PATH,
  applyTextEdit,
  checkoutBaseCommit,
  checkoutBaseContents,
  checkoutFileContents,
  checkoutFilesMap,
  checkoutTaskChanges,
  normalizeRepoPath,
} from "../lib/checkout-shared.ts";
import {
  applyVerifiedIdentity,
  assignAgentOp,
  commitCheckoutOp,
  generateCheckoutMessageOp,
  useCheckout,
  whoami,
} from "../lib/use-checkout.ts";
import type { TasksUser } from "../lib/tasks-api.ts";
import { useTaskCommit, type CommitMessageApi } from "../lib/use-task-commit.ts";
import type { TaskChangeSummary } from "../state.ts";
import {
  columnsForTasks,
  fallbackCommitMessage,
  isTaskFilePath,
  newTaskFile,
  setTaskCardLabels,
  setTaskCardState,
  taskColumnState,
  taskPathForTitle,
} from "../tasks-model.ts";
import {
  taskPathInFolder,
  toBoardTask,
  type BoardTask,
  type Peer,
  type PresenceUser,
  type RowField,
} from "../lib/board-model.ts";
import { useRecentTouches, type RecencyState } from "../lib/recency.ts";
import { projectBoard } from "../lib/board-engine.ts";
import { Board } from "../components/board.tsx";
import { TaskSheet } from "../components/task-sheet.tsx";
import { CommitControls, DeletedTasksStrip } from "../components/commit-controls.tsx";
import { PresenceAvatars } from "../components/presence.tsx";
import {
  CheckoutBreadcrumbs,
  FilterControl,
  GroupControl,
  MobileOverflow,
  ShareButton,
} from "../components/checkout-header.tsx";

/**
 * Every piece of view state rides in the URL so any view is deep-linkable:
 * `repoPath` (omitted for the default repo), `task` (the open task sheet),
 * `q` (the board filter), `group=none|tags` (folder grouping is the
 * default and stays out of the URL).
 */
type CheckoutSearch = { repoPath?: string; task?: string; q?: string; group?: "none" | "tags" };

export const Route = createFileRoute("/c/$checkoutId")({
  validateSearch: (search: Record<string, unknown>): CheckoutSearch => {
    const repoPath = normalizeRepoPath(
      typeof search.repoPath === "string" ? search.repoPath : null,
    );
    const validated: CheckoutSearch =
      repoPath === null || repoPath === DEFAULT_REPO_PATH ? {} : { repoPath };
    if (typeof search.task === "string" && search.task !== "") validated.task = search.task;
    if (typeof search.q === "string" && search.q !== "") validated.q = search.q;
    if (search.group === "none" || search.group === "tags") validated.group = search.group;
    return validated;
  },
  beforeLoad: ({ params, search }) => {
    // The workspace board (/w) is the product; the Yjs lane stays reachable
    // only with ?legacy=1 for comparison until it is deleted.
    if ((search as { legacy?: string }).legacy !== "1") {
      const legacy = search as { group?: string; q?: string; repoPath?: string; task?: string };
      throw redirect({
        params,
        search: {
          annotation: "",
          group: legacy.group === "tags" ? ("label" as const) : ("folder" as const),
          q: legacy.q ?? "",
          repo: legacy.repoPath ?? "/repos/config",
          task: legacy.task ?? "",
          view: "editor",
        },
        to: "/w/$checkoutId",
      });
    }
  },
  component: CheckoutPage,
});

/**
 * The collaborative board page. Everything above the board lives in ONE
 * filter strip (no page header): sidebar trigger, task filter, grouping
 * control, presence, and the commit surface. Every mutation edits the
 * checkout's shared Y.Doc, so all collaborators repaint together.
 */
function CheckoutPage() {
  const { checkoutId } = Route.useParams();
  const repoPath = Route.useSearch().repoPath ?? DEFAULT_REPO_PATH;
  const { provider, doc, status, docVersion, awarenessVersion } = useCheckout(
    checkoutId,
    repoPath,
  );

  // The platform-verified identity: fetched once per page, overlaid on our
  // presence (real name, userId/email in awareness) as soon as both the
  // identity and the provider exist.
  const [me, setMe] = useState<TasksUser | null>(null);
  useEffect(() => {
    let cancelled = false;
    whoami()
      .then((user) => {
        if (!cancelled) setMe(user);
      })
      .catch(() => {
        // identity is progressive enhancement — the animal name stands in
      });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (provider !== null && me !== null) applyVerifiedIdentity(provider, me);
  }, [provider, me]);

  const snapshot = useMemo(() => {
    if (doc === null) return null;
    void docVersion; // dependency: recompute when the doc changes
    const files = checkoutFileContents(doc);
    const base = checkoutBaseContents(doc);
    const tasks: BoardTask[] = [];
    for (const [path, source] of Object.entries(files)) {
      if (isTaskFilePath(path)) tasks.push(toBoardTask(path, source));
    }
    tasks.sort((a, b) => a.path.localeCompare(b.path));
    return {
      files,
      base,
      baseCommit: checkoutBaseCommit(doc),
      tasks,
      taskChanges: checkoutTaskChanges(files, base),
    };
  }, [doc, docVersion]);

  const peers = useMemo<Peer[]>(() => {
    if (provider === null || doc === null) return [];
    void awarenessVersion;
    const listed: Peer[] = [];
    for (const [id, state] of provider.awareness.getStates()) {
      if (id === doc.clientID) continue;
      const user = (
        state as { user?: PresenceUser & { email?: string; userId?: string; image?: string } }
      ).user;
      if (!user || typeof user.name !== "string") continue;
      const openPath = (state as { openPath?: string | null }).openPath ?? null;
      listed.push({
        id,
        user: { name: user.name, color: user.color },
        email: typeof user.email === "string" ? user.email : undefined,
        userId: typeof user.userId === "string" ? user.userId : undefined,
        image: typeof user.image === "string" ? user.image : undefined,
        openPath,
      });
    }
    return listed;
  }, [provider, doc, awarenessVersion]);

  const ready = provider !== null && doc !== null && snapshot?.baseCommit !== undefined;
  // Recency glows: who touched which task (and which characters), since
  // this viewer has been watching. Active only once synced so the initial
  // load never glows.
  const recency = useRecentTouches(doc, ready);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {ready ? (
        <ReadyCheckout
          checkoutId={checkoutId}
          repoPath={repoPath}
          provider={provider}
          doc={doc}
          snapshot={snapshot!}
          peers={peers}
          me={me}
          recency={recency}
          disconnected={status === "disconnected"}
        />
      ) : (
        <div className="flex flex-col gap-3">
          <header className="flex h-11 shrink-0 items-center gap-2 border-b bg-background px-3">
            <SidebarTrigger className="-ml-1 md:hidden" />
            <CheckoutBreadcrumbs repoPath={repoPath} checkoutId={checkoutId} />
          </header>
          <div className="flex flex-1 flex-col items-center gap-3 bg-muted/30 p-4">
            <div className="flex justify-center gap-2">
              <Skeleton className="h-44 w-72" />
              <Skeleton className="h-44 w-72" />
              <Skeleton className="hidden h-44 w-72 md:block" />
              <Skeleton className="hidden h-44 w-72 lg:block" />
            </div>
            <p className="text-sm text-muted-foreground">
              {status === "disconnected" ? "disconnected — retrying…" : "opening the checkout…"}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function ReadyCheckout({
  checkoutId,
  repoPath,
  provider,
  doc,
  snapshot,
  peers,
  me,
  recency,
  disconnected,
}: {
  checkoutId: string;
  repoPath: string;
  provider: YProvider;
  doc: Y.Doc;
  snapshot: {
    files: Record<string, string>;
    base: Record<string, string>;
    baseCommit: string | undefined;
    tasks: BoardTask[];
    taskChanges: TaskChangeSummary[];
  };
  peers: Peer[];
  me: TasksUser | null;
  recency: RecencyState;
  disconnected: boolean;
}) {
  const { files, base, tasks, taskChanges } = snapshot;
  // View state lives in the URL (deep-linkable): q = filter, group = row
  // grouping, task = the open sheet. Filter/grouping replace history
  // entries; opening a task pushes one, so Back closes the sheet.
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const filter = search.q ?? "";
  const rowField: RowField =
    search.group === "none" ? null : search.group === "tags" ? "label" : "folder";
  const openPath = search.task ?? null;
  const setFilter = (value: string) =>
    void navigate({
      search: (prev) => ({ ...prev, q: value === "" ? undefined : value }),
      replace: true,
    });
  const setRowField = (value: RowField) =>
    void navigate({
      search: (prev) => ({
        ...prev,
        group: value === null ? "none" : value === "label" ? "tags" : undefined,
      }),
      replace: true,
    });
  const setOpenPath = (path: string | null, options?: { replace?: boolean }) =>
    void navigate({
      search: (prev) => ({ ...prev, task: path ?? undefined }),
      replace: options?.replace ?? false,
    });
  // A just-created task: the sheet opens on it with the caret selecting the
  // headline, and until it is committed its filename follows the headline
  // (debounced renames, like apps/os's title-derived paths).
  const [draftPath, setDraftPath] = useState<string | null>(null);
  const renamedDraftRef = useRef(false);

  const projection = useMemo(
    () => projectBoard({ tasks, filter, rowField }),
    [tasks, filter, rowField],
  );

  // Auto-commit is a personal preference, remembered locally.
  const [autoCommit, setAutoCommitState] = useState(
    () =>
      typeof window === "undefined" || window.localStorage.getItem("tasks-autocommit") !== "off",
  );
  const setAutoCommit = (value: boolean) => {
    setAutoCommitState(value);
    try {
      window.localStorage.setItem("tasks-autocommit", value ? "on" : "off");
    } catch {
      // private mode
    }
  };

  const taskChangeByPath = useMemo(
    () => new Map(taskChanges.map((change) => [change.path, change.status] as const)),
    [taskChanges],
  );
  const deletedChanges = useMemo(
    () => taskChanges.filter((change) => change.status === "deleted"),
    [taskChanges],
  );
  const presenceByPath = useMemo(() => {
    const byPath = new Map<string, PresenceUser[]>();
    for (const peer of peers) {
      if (!peer.openPath) continue;
      const listed = byPath.get(peer.openPath) ?? [];
      listed.push(peer.user);
      byPath.set(peer.openPath, listed);
    }
    return byPath;
  }, [peers]);
  // Content-sensitive signature so every remote OR local edit restarts the
  // shared autosave window; whichever collaborator's timer fires first
  // commits, and the base rewrite syncs to everyone else, cancelling theirs.
  const taskChangeSignature = useMemo(
    () =>
      taskChanges
        .map((change) => `${change.path}:${change.status}:${files[change.path] ?? ""}`)
        .join("|"),
    [taskChanges, files],
  );

  const [commitPending, setCommitPending] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);

  const api = useMemo<CommitMessageApi>(
    () => ({
      generateCommitMessage: () => generateCheckoutMessageOp(checkoutId, repoPath),
    }),
    [checkoutId, repoPath],
  );

  const commitCheckout = useCallback(
    async (message: string | undefined) => {
      setCommitPending(true);
      setCommitError(null);
      try {
        await commitCheckoutOp(
          checkoutId,
          repoPath,
          message ??
            fallbackCommitMessage(
              checkoutTaskChanges(checkoutFileContents(doc), checkoutBaseContents(doc)),
            ),
        );
      } catch (error) {
        setCommitError(error instanceof Error ? error.message : String(error));
        throw error;
      } finally {
        setCommitPending(false);
      }
    },
    [checkoutId, repoPath, doc],
  );

  const commit = useTaskCommit({
    api,
    taskChanges,
    taskChangeSignature,
    enabled: autoCommit,
    onCommit: commitCheckout,
  });

  const filesMap = checkoutFilesMap(doc);
  const writeTask = (path: string, content: string) => {
    const text = filesMap.get(path);
    if (text) applyTextEdit(text, content);
    else filesMap.set(path, new Y.Text(content));
  };
  const moveTask = (task: BoardTask, state: string, folder: string, labels?: string[]) => {
    let content =
      taskColumnState(task.state) === state ? task.source : setTaskCardState(task.source, state);
    if (labels !== undefined) content = setTaskCardLabels(content, labels);
    if (folder === task.folder) {
      if (content !== task.source) writeTask(task.path, content);
      return;
    }
    // Cross-folder drop = rename: same file content lands on the new path.
    const nextPath = taskPathInFolder(task.path, folder);
    if (nextPath === task.path || filesMap.has(nextPath)) return;
    doc.transact(() => {
      filesMap.delete(task.path);
      filesMap.set(nextPath, new Y.Text(content));
    });
    if (openPath === task.path) setOpenPath(nextPath);
  };
  const addTask = (state: string, folder: string | null, label?: string) => {
    const reserved = new Set([...Object.keys(files), ...Object.keys(base)]);
    let file = newTaskFile({
      title: "New task",
      state,
      author: me?.email ?? me?.userId ?? undefined,
    });
    for (let suffix = 2; reserved.has(inFolder(file.path, folder)); suffix++) {
      file = { ...file, path: taskPathForTitle("New task", `${suffix}`) };
    }
    const path = inFolder(file.path, folder);
    // Adding from a tag row: the task wears that tag from birth (parity
    // with the workspace board).
    const content = label === undefined ? file.content : setTaskCardLabels(file.content, [label]);
    filesMap.set(path, new Y.Text(content));
    renamedDraftRef.current = false;
    setDraftPath(path);
    setOpenPath(path);
  };
  const deleteTask = (path: string) => {
    filesMap.delete(path);
    if (openPath === path) setOpenPath(null);
  };
  /** Back to the base commit's version: restore a delete, drop an add, undo edits. */
  const revertTask = (path: string) => {
    const baseContent = base[path];
    if (baseContent === undefined) filesMap.delete(path);
    else writeTask(path, baseContent);
  };
  const discardAll = () => {
    doc.transact(() => {
      for (const change of checkoutTaskChanges(
        checkoutFileContents(doc),
        checkoutBaseContents(doc),
      )) {
        revertTask(change.path);
      }
    });
  };

  const columns = useMemo(() => columnsForTasks(tasks).map((column) => column.state), [tasks]);
  const allTags = useMemo(
    () => [...new Set(tasks.flatMap((task) => task.labels))].sort((a, b) => a.localeCompare(b)),
    [tasks],
  );
  const openTask = openPath === null ? null : (tasks.find((task) => task.path === openPath) ?? null);

  // While the draft's sheet is open and it is still an uncommitted add, its
  // filename trails the headline. The rename replaces the Y.Text, so the
  // editor remounts with the caret parked at the headline's end.
  useEffect(() => {
    if (draftPath === null || openPath !== draftPath) return;
    if (taskChangeByPath.get(draftPath) !== "added") return;
    const task = tasks.find((candidate) => candidate.path === draftPath);
    if (task === undefined) return;
    const target = inFolder(
      taskPathForTitle(task.title),
      task.folder === "/" ? null : task.folder,
    );
    if (target === draftPath || base[target] !== undefined) return;
    const timer = setTimeout(() => {
      const files = checkoutFilesMap(doc);
      const text = files.get(draftPath);
      if (text === undefined || files.has(target)) return;
      const content = text.toString();
      doc.transact(() => {
        files.delete(draftPath);
        files.set(target, new Y.Text(content));
      });
      renamedDraftRef.current = true;
      setDraftPath(target);
      setOpenPath(target, { replace: true });
    }, 700);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are the intentional rename-retrigger set; the helpers used inside are stable
  }, [draftPath, openPath, tasks, taskChangeByPath, base, doc]);

  return (
    <>
      <header className="flex h-11 shrink-0 items-center gap-2 border-b bg-background px-3">
        <SidebarTrigger className="-ml-1 md:hidden" />
        <CheckoutBreadcrumbs repoPath={repoPath} checkoutId={checkoutId} />
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <PresenceAvatars provider={provider} peers={peers} me={me} />
          <div className="hidden items-center gap-1.5 sm:flex">
            <ShareButton />
            <FilterControl value={filter} onChange={setFilter} />
            <GroupControl value={rowField} onChange={setRowField} />
          </div>
          <div className="sm:hidden">
            <MobileOverflow
              filter={filter}
              onChangeFilter={setFilter}
              group={rowField}
              onChangeGroup={setRowField}
            />
          </div>
          <CommitControls
            taskChanges={taskChanges}
            commitMessage={commit.commitMessage}
            onCommitMessageChange={commit.setCommitMessage}
            commitPending={commitPending}
            generatingMessage={commit.generatingMessage}
            autoSaveDueAt={commit.autoSaveDueAt}
            autoCommit={autoCommit}
            onAutoCommitChange={setAutoCommit}
            canCommit={true}
            onMakeCommit={commit.makeCommit}
            onWriteCommitMessage={commit.writeCommitMessage}
            onDiscardAll={discardAll}
          />
        </div>
      </header>
      {disconnected ? (
        <p className="border-b bg-amber-500/10 px-3 py-1 text-xs text-amber-800">
          disconnected — reconnecting… (edits keep working and sync when back)
        </p>
      ) : null}
      {commitError ? (
        <p className="border-b bg-destructive/10 px-3 py-1 text-xs text-red-700">
          commit failed: {commitError}
        </p>
      ) : null}
      <DeletedTasksStrip deletedChanges={deletedChanges} onRestore={revertTask} />
      <Board
        projection={projection}
        taskChangeByPath={taskChangeByPath}
        presenceByPath={presenceByPath}
        recentByPath={recency.touches}
        onMove={moveTask}
        onAdd={addTask}
        onOpen={setOpenPath}
      />
      <TaskSheet
        task={openTask}
        text={openTask === null ? undefined : filesMap.get(openTask.path)}
        awareness={provider.awareness}
        columns={columns}
        presence={openTask === null ? [] : (presenceByPath.get(openTask.path) ?? [])}
        changeStatus={openTask === null ? undefined : taskChangeByPath.get(openTask.path)}
        initialSpans={openTask === null ? undefined : recency.spans.get(openTask.path)}
        focusHeadline={
          openTask !== null && openTask.path === draftPath
            ? renamedDraftRef.current
              ? "end"
              : "select"
            : undefined
        }
        allTags={allTags}
        onChangeState={(state) => {
          if (openTask !== null) writeTask(openTask.path, setTaskCardState(openTask.source, state));
        }}
        onChangeLabels={(labels) => {
          if (openTask !== null) writeTask(openTask.path, setTaskCardLabels(openTask.source, labels));
        }}
        onAssignAgent={async () => {
          if (openTask !== null) await assignAgentOp(checkoutId, repoPath, openTask.path);
        }}
        onRevert={() => {
          if (openTask !== null) revertTask(openTask.path);
        }}
        onDelete={() => {
          if (openTask !== null) deleteTask(openTask.path);
        }}
        onClose={() => {
          setDraftPath(null);
          setOpenPath(null);
        }}
      />
    </>
  );
}

function inFolder(path: string, folder: string | null): string {
  return folder === null || folder === "/" ? path : taskPathInFolder(path, folder);
}
