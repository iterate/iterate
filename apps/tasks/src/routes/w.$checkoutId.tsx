import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIcon } from "lucide-react";
import { SidebarTrigger } from "@iterate-com/ui/components/sidebar";
import { Button } from "@iterate-com/ui/components/button";
import type { CollabEditorApi } from "../lib/collab-editor-api.ts";
import { Board } from "../components/board.tsx";
import {
  CheckoutBreadcrumbs,
  FilterControl,
  MobileOverflow,
  ShareButton,
} from "../components/checkout-header.tsx";
import { BoardSettings } from "../components/board-settings.tsx";
import { CommitControls, DeletedTasksStrip } from "../components/commit-controls.tsx";
import { StreamEventsSheet } from "../components/stream-events-sheet.tsx";
import { WithTooltip } from "../components/checkout-header.tsx";
import { WorkspaceTaskSheet } from "../components/workspace-task-sheet.tsx";
import { useWorkspaceBoard } from "../lib/use-workspace-board.ts";
import { usePointerPresence } from "../lib/pointer-presence.ts";
import { PointerOverlay } from "../components/pointer-overlay.tsx";
import { useTaskCommit } from "../lib/use-task-commit.ts";
import { projectBoard } from "../lib/board-engine.ts";
import { taskPathInFolder, unclaimedPath, type BoardTask, type RowField } from "../lib/board-model.ts";
import { DEFAULT_REPO_PATH, normalizeRepoPath } from "../lib/checkout-shared.ts";
import {
  columnsForTasks,
  fallbackCommitMessage,
  isTaskFilePath,
  newTaskFile,
  parseTaskCard,
  setTaskCardLabels,
  setTaskCardState,
  taskColumnState,
  taskPathForTitle,
} from "../tasks-model.ts";

/**
 * The tasks board on the WORKSPACE mechanism — the SAME experience as the
 * Yjs checkout board (chrome, swimlanes, drag, filter/group, commit controls
 * with message writing, deleted-tasks strip, tag editing, deep links), but
 * every read and write is the platform workspace: the overlay is the diff,
 * commits are workspace commits, and the detail editor is the live
 * rebase-model collab session with redlines.
 *   /w/<checkoutId>?repo=/repos/config&task=<path>&q=<filter>&group=none
 */
export const Route = createFileRoute("/w/$checkoutId")({
  validateSearch: (search: Record<string, unknown>) => ({
    group:
      search.group === "none" || search.group === "label"
        ? (search.group as "none" | "label")
        : ("folder" as const),
    q: typeof search.q === "string" ? search.q : "",
    repo: typeof search.repo === "string" ? search.repo : DEFAULT_REPO_PATH,
    task: typeof search.task === "string" ? search.task : "",
  }),
  component: WorkspaceBoardPage,
});

function WorkspaceBoardPage() {
  const { checkoutId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const repoPath = normalizeRepoPath(search.repo) ?? DEFAULT_REPO_PATH;
  const board = useWorkspaceBoard(checkoutId, repoPath);
  // Everyone's mouse pointer, Figma-style (only ready boards announce —
  // presence on a workspace that is still creating would force-create it).
  const pointers = usePointerPresence(checkoutId, repoPath, {
    group: search.group,
    q: search.q,
    task: search.task,
  });
  // Auto-commit defaults OFF on the workspace board: every commit advances
  // the redline baseline, and a 60s autosave would wipe "what everyone did"
  // minute by minute. Committing is an explicit act here.
  const [autoCommit, setAutoCommit] = useState(false);
  const [eventsOpen, setEventsOpen] = useState(false);
  // Bumped on revert: the platform ends the file's session, so the open
  // editor must remount and reseed from the reverted content.
  const [editorEpoch, setEditorEpoch] = useState(0);
  // Track changes (redlines) is a board-level setting, default on.
  const [trackChanges, setTrackChanges] = useState(true);
  // A just-created task: the editor opens with the headline selected and the
  // filename trails the title — settled at REST POINTS (sheet close, commit),
  // never mid-typing: on this lane a rename is write+delete, which ends the
  // file's collab session and wipes its redline fold, so renaming under the
  // open editor forced a remount that flashed the sheet and dropped the marks.
  const [draftPath, setDraftPath] = useState<string | null>(null);
  /** Fresh draft only: the editor opens with the headline selected so typing
   * replaces it. Cleared on close/commit — reopening is an ordinary open. */
  const draftFocusRef = useRef<"select" | undefined>(undefined);
  // The open sheet's live-doc API: mutations of the OPEN file go through the
  // live document (the board mirror is 200ms behind it — writing board state
  // over a live path would drop the newest keystrokes).
  const editorApiRef = useRef<CollabEditorApi | null>(null);
  // ONE rename at a time: a second write/delete sequence starting while the
  // first is mid-flight could duplicate files or delete the wrong source.
  const renamingRef = useRef(false);
  // Paths claimed by mutations THIS RENDER: board.files is async React
  // state, so two rapid adds/moves in one frame would both see it stale and
  // collapse onto one filename without this synchronous guard. Claims are
  // short-lived reservations (they bridge until the optimistic write shows
  // up in board.files) — a TTL lets deleted/renamed/failed paths free their
  // names again instead of forcing -2/-3 suffixes forever.
  const claimedRef = useRef(new Map<string, number>());
  // Fresh board state for timers/claims WITHOUT depending on the board
  // object (recreated every render — depending on it would reset debounces
  // on every keystroke reflect and poll tick).
  const boardRef = useRef(board);
  const searchTaskRef = useRef(search.task);
  const draftPathRef = useRef(draftPath);
  useEffect(() => {
    boardRef.current = board;
    searchTaskRef.current = search.task;
    draftPathRef.current = draftPath;
  });
  // Warm the editor + preview stacks while the board renders: the CM6 and
  // markdown chunks and the whoami identity round trip come off the first
  // sheet-open's critical path.
  useEffect(() => {
    void import("../lib/use-collab-editor.ts").then(
      (module) => void module.ensureCollabIdentity(),
    );
    void import("../components/workspace-task-preview.tsx");
  }, []);
  /** Prune expired claims and answer whether a path is spoken for. */
  const isTaken = useCallback((path: string): boolean => {
    const now = Date.now();
    for (const [claimed, at] of claimedRef.current) {
      if (now - at > 5_000) claimedRef.current.delete(claimed);
    }
    return boardRef.current.files?.[path] !== undefined || claimedRef.current.has(path);
  }, []);

  const claimPath = useCallback(
    (desired: string): string => {
      const target = unclaimedPath(desired, isTaken);
      claimedRef.current.set(target, Date.now());
      return target;
    },
    [isTaken],
  );


  /** Live text of the open file, else the board's copy. */
  const sourceOf = useCallback((task: BoardTask): string => {
    const api = editorApiRef.current;
    return api !== null && api.path === task.path ? api.source() : task.source;
  }, []);

  /** Transform the OPEN file in the live editor; false when not open. */
  const applyLive = useCallback(
    (path: string, transform: (source: string) => string): boolean => {
      const api = editorApiRef.current;
      if (api === null || api.path !== path) return false;
      api.applyTransform(transform);
      // Reflect immediately so cards/commit summaries don't lag the doc.
      board.reflectLiveContent(path, api.source());
      return true;
    },
    [board],
  );

  /** The live-doc rule, structurally: transform the OPEN file in its editor,
   * else write the transformed board copy. */
  const mutateTask = useCallback(
    (task: BoardTask, transform: (source: string) => string) => {
      if (!applyLive(task.path, transform)) board.writeTask(task.path, transform(sourceOf(task)));
    },
    [applyLive, board, sourceOf],
  );
  const [commitPending, setCommitPending] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);

  const patchSearch = useCallback(
    (patch: Partial<typeof search>) =>
      void navigate({ replace: true, search: (current) => ({ ...current, ...patch }) }),
    [navigate],
  );
  const rowField: RowField =
    search.group === "none" ? null : search.group === "label" ? "label" : "folder";

  const projection = useMemo(
    () => projectBoard({ filter: search.q, rowField, tasks: board.tasks }),
    [board.tasks, search.q, rowField],
  );
  const columns = useMemo(
    () => columnsForTasks(board.tasks).map((column) => column.state),
    [board.tasks],
  );
  const allTags = useMemo(
    () =>
      [...new Set(board.tasks.flatMap((task) => task.labels))].sort((a, b) => a.localeCompare(b)),
    [board.tasks],
  );
  const openTask = useMemo(
    () => board.tasks.find((task) => task.path === search.task) ?? null,
    [board.tasks, search.task],
  );
  const deletedChanges = useMemo(
    () => board.taskChanges.filter((change) => change.status === "deleted"),
    [board.taskChanges],
  );

  const commit = useTaskCommit({
    // The workspace lane summarizes deterministically; the AI one-liner is a
    // checkout-DO capability this lane can adopt later.
    api: {
      generateCommitMessage: async ({ changes }) => fallbackCommitMessage(changes),
    },
    enabled: autoCommit,
    onCommit: async (message) => {
      setCommitError(null);
      setCommitPending(true);
      try {
        // A draft's filename settles to its title BEFORE the commit records
        // it — afterwards would leave a rename as instant new dirtiness.
        await settleDraft();
        const result = await board.commit(
          message?.trim() || fallbackCommitMessage(boardRef.current.taskChanges),
        );
        // The redline baseline advanced: reseat an open editor so committed
        // work stops wearing marks (same lever revert/discard use). The
        // commit also ends any draft — the reseat must not replay its
        // focus intent.
        setDraftPath(null);
        draftFocusRef.current = undefined;
        if (searchTaskRef.current !== "") setEditorEpoch((current) => current + 1);
        return result;
      } catch (cause) {
        setCommitError(cause instanceof Error ? cause.message : String(cause));
        throw cause;
      } finally {
        setCommitPending(false);
      }
    },
    taskChangeSignature: board.taskChanges
      .map((change) => `${change.status}:${change.path}`)
      .join("|"),
    taskChanges: board.taskChanges,
  });

  const moveTask = useCallback(
    (task: BoardTask, state: string, folder: string, labels?: string[]) => {
      const transform = (current: string) => {
        let next =
          taskColumnState(task.state) === state ? current : setTaskCardState(current, state);
        if (labels !== undefined) next = setTaskCardLabels(next, labels);
        return next;
      };
      if (folder === task.folder) {
        mutateTask(task, transform);
        return;
      }
      // ONE rename at a time (same lock as the path input and the draft
      // timer): an overlapping drag would interleave write/delete sequences
      // and the first .finally would clear the lock under the second.
      if (renamingRef.current) return;
      // Never collapse onto an existing file in the target folder — suffix.
      const nextPath = claimPath(taskPathInFolder(task.path, folder));
      // Navigate only once the write LANDED: the sheet must never open a
      // path that doesn't exist yet (racing the create), and the old editor
      // keeps the user's text until then. The final-frame carry runs after
      // the navigation unmounts it.
      renamingRef.current = true;
      void board
        .renameTask(task.path, nextPath, transform(sourceOf(task)), transform, async () => {
          // Flush the still-mounted editor first (awaited by the hook), so
          // the carry read sees the final keystrokes.
          if (editorApiRef.current?.path === task.path) {
            await editorApiRef.current.flushPending();
          }
          // A moved draft is still the draft — title trailing keeps working.
          setDraftPath((current) => {
            if (current === task.path) draftFocusRef.current = undefined;
            return current === task.path ? nextPath : current;
          });
          // LIVE check: a sheet closed (or switched) mid-write stays put.
          if (searchTaskRef.current === task.path) patchSearch({ task: nextPath });
        })
        .finally(() => {
          renamingRef.current = false;
        });
    },
    [board, claimPath, mutateTask, patchSearch, sourceOf],
  );

  const addTaskRef = useRef<((state: string, folder: string | null) => void) | null>(null);
  const columnsRef = useRef<string[]>([]);
  // Keyboard: c creates a task in the first column (ignored while typing).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "c" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target !== null &&
        (target.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) ||
          target.closest(".cm-editor") !== null)
      ) {
        return;
      }
      if (search.task !== "") return;
      event.preventDefault();
      addTaskRef.current?.(columnsRef.current[0] ?? "todo", null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [search.task]);

  const addTask = useCallback(
    (state: string, folder: string | null, label?: string) => {
      // Rapid adds must not collapse: number the TITLE (New task 2, …) so
      // the path, the heading, and the later title-trailing rename all
      // stay distinct.
      let title = "New task";
      let file = newTaskFile({ state, title });
      let target = taskPathInFolder(file.path, folder ?? "tasks");
      for (let suffix = 2; isTaken(target); suffix++) {
        title = `New task ${suffix}`;
        file = newTaskFile({ state, title });
        target = taskPathInFolder(file.path, folder ?? "tasks");
      }
      claimedRef.current.set(target, Date.now());
      // Adding from a tag row: the task wears that tag from birth.
      const content = label === undefined ? file.content : setTaskCardLabels(file.content, [label]);
      draftFocusRef.current = "select";
      setDraftPath(target);
      // The card shows instantly (optimistic), but the SHEET opens only once
      // the create landed — the collab editor must never seed an empty doc
      // and have the arriving template splice over early keystrokes (same
      // rule as the rename lanes).
      void board.writeTask(target, content).then((ok) => {
        if (ok) patchSearch({ task: target });
      });
    },
    [board, isTaken, patchSearch],
  );

  useEffect(() => {
    addTaskRef.current = addTask;
    columnsRef.current = columns;
  });

  /** Settle a draft's title-trailing rename at a rest point. The live source
   * (read before the editor unmounted) wins over the board mirror, which
   * trails typing by up to 200ms. */
  const settleDraftRename = useCallback(
    async (path: string, liveSource: string | null): Promise<void> => {
      const current = boardRef.current;
      // Only an uncommitted add still trails its title; and never interleave
      // with another rename lane (a drag, a path-input edit).
      if (current.changes.get(path) !== "added" || renamingRef.current) return;
      const source = liveSource ?? current.files?.[path];
      if (source === undefined) return;
      const folder = path.split("/").slice(0, -1).join("/");
      const desired = taskPathInFolder(taskPathForTitle(parseTaskCard(path, source).title), folder);
      if (desired === path) return;
      // A sibling with this title already exists: suffix, never collapse.
      const target = claimPath(desired);
      renamingRef.current = true;
      try {
        await current.renameTask(path, target, source, (final) => final, () => {
          // A sheet still showing the source (commit keeps it open) follows
          // the moved file; a closed sheet stays closed.
          if (searchTaskRef.current === path) patchSearch({ task: target });
        });
      } finally {
        renamingRef.current = false;
      }
    },
    [claimPath, patchSearch],
  );

  /** The commit-side rest point: flush the open editor's final keystrokes,
   * then settle the filename, so the commit records the title's name. */
  const settleDraft = useCallback(async (): Promise<void> => {
    const path = draftPathRef.current;
    if (path === null) return;
    const api = editorApiRef.current;
    const liveSource = api !== null && api.path === path ? api.source() : null;
    if (api !== null && api.path === path) await api.flushPending().catch(() => {});
    await settleDraftRename(path, liveSource);
  }, [settleDraftRename]);

  // The sheet's path field: any rename the board can represent is allowed —
  // the file must stay a task (.md under a folder named "tasks").
  const renameTask = useCallback(
    async (task: BoardTask, nextPathRaw: string): Promise<string | null> => {
      const nextPath = nextPathRaw.split("/").filter(Boolean).join("/");
      if (nextPath === "") return "Path cannot be empty.";
      if (!isTaskFilePath(nextPath))
        return 'Path must be a .md file inside a folder named "tasks".';
      if (nextPath === task.path) return null;
      if (board.files?.[nextPath] !== undefined) return "A file already exists at that path.";
      if (renamingRef.current) return "A rename is already in progress — retry in a moment.";
      renamingRef.current = true;
      try {
        // The input's error line reports the REAL outcome — a failed create
        // must not read as accepted.
        return await board.renameTask(
          task.path,
          nextPath,
          sourceOf(task),
          (final) => final,
          async () => {
            if (editorApiRef.current?.path === task.path) {
              await editorApiRef.current.flushPending();
            }
            setDraftPath((current) => {
              if (current === task.path) draftFocusRef.current = undefined;
              return current === task.path ? nextPath : current;
            });
            // LIVE check — a closed sheet stays closed.
            if (searchTaskRef.current === task.path) patchSearch({ task: nextPath });
          },
        );
      } finally {
        renamingRef.current = false;
      }
    },
    [board, patchSearch, sourceOf],
  );

  return (
    <>
      <header className="flex h-11 shrink-0 items-center gap-2 border-b bg-background px-3">
        <SidebarTrigger className="-ml-1 md:hidden" />
        <CheckoutBreadcrumbs repoPath={repoPath} checkoutId={checkoutId} />
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <div className="hidden items-center gap-1.5 sm:flex">
            <WithTooltip label="Stream events">
              <Button
                variant="outline"
                size="sm"
                className="h-8 w-8 px-0"
                aria-label="Stream events"
                onClick={() => setEventsOpen(true)}
              >
                <ActivityIcon className="size-4" />
              </Button>
            </WithTooltip>
            <ShareButton />
            <FilterControl value={search.q} onChange={(q) => patchSearch({ q })} />
            <BoardSettings
              grouping={rowField}
              onChangeGrouping={(next) =>
                patchSearch({
                  group: next === null ? "none" : next === "label" ? "label" : "folder",
                })
              }
              trackChanges={trackChanges}
              onChangeTrackChanges={setTrackChanges}
            />
          </div>
          <div className="sm:hidden">
            <MobileOverflow
              filter={search.q}
              onChangeFilter={(q) => patchSearch({ q })}
              group={rowField}
              onChangeGroup={(next) =>
                patchSearch({
                  group: next === null ? "none" : next === "label" ? "label" : "folder",
                })
              }
            />
          </div>
          <CommitControls
            taskChanges={board.taskChanges}
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
            onDiscardAll={() => {
              // Discard ends every changed file's session — reseat the open
              // editor afterwards exactly like a single revert does.
              void board.discardAll().then((ok) => {
                if (ok && search.task !== "") setEditorEpoch((current) => current + 1);
              });
            }}
          />
        </div>
      </header>
      {board.error !== null && (
        <p className="border-b bg-amber-500/10 px-3 py-1 text-xs text-amber-800">{board.error}</p>
      )}
      {commitError !== null && (
        <p className="border-b bg-destructive/10 px-3 py-1 text-xs text-red-700">
          commit failed: {commitError}
        </p>
      )}
      <DeletedTasksStrip deletedChanges={deletedChanges} onRestore={board.revertTask} />
      {!board.ready ? (
        <p className="p-6 text-sm text-muted-foreground">Loading workspace…</p>
      ) : (
        <Board
          projection={projection}
          taskChangeByPath={board.changes}
          presenceByPath={new Map()}
          recentByPath={new Map()}
          onMove={moveTask}
          onAdd={addTask}
          onOpen={(path) => patchSearch({ task: path })}
        />
      )}
      <StreamEventsSheet
        open={eventsOpen}
        streamPath={`/workspaces/tasks/${checkoutId}~${repoPath.replace(/^\/+/, "").replaceAll("/", "--")}`}
        subscribe={board.subscribeEvents}
        onClose={() => setEventsOpen(false)}
      />
      <PointerOverlay
        pointers={pointers}
        onJumpToView={(view) =>
          patchSearch({ group: view.group === "none" || view.group === "label" ? view.group : "folder", q: view.q, task: view.task })
        }
      />
      <WorkspaceTaskSheet
        task={openTask}
        checkoutId={checkoutId}
        repoPath={repoPath}
        columns={columns}
        allTags={allTags}
        changeStatus={openTask === null ? undefined : board.changes.get(openTask.path)}
        onLiveContent={board.reflectLiveContent}
        onChangeState={(state) => {
          if (openTask !== null) mutateTask(openTask, (current) => setTaskCardState(current, state));
        }}
        onChangeLabels={(labels) => {
          if (openTask !== null)
            mutateTask(openTask, (current) => setTaskCardLabels(current, labels));
        }}
        onRename={(nextPath) =>
          openTask === null ? Promise.resolve(null) : renameTask(openTask, nextPath)
        }
        editorEpoch={editorEpoch}
        redline={trackChanges}
        editorApiRef={editorApiRef}
        focusHeadline={
          openTask !== null && openTask.path === draftPath ? draftFocusRef.current : undefined
        }
        liveSource={() => {
          // Read the ref AT CALL TIME — it fills after mount without a
          // re-render, so a render-time conditional would miss it.
          const api = editorApiRef.current;
          return api !== null && openTask !== null && api.path === openTask.path
            ? api.source()
            : null;
        }}
        onRevert={() => {
          if (openTask === null) return;
          // Remount only AFTER the revert RPC ended the old session — an
          // early remount would attach to the dying session and see it end.
          void board.revertTask(openTask.path).then((ok) => {
            if (ok) setEditorEpoch((current) => current + 1);
          });
        }}
        onDelete={() => {
          if (openTask !== null) {
            board.deleteTask(openTask.path);
            if (openTask.path === draftPath) {
              setDraftPath(null);
              draftFocusRef.current = undefined;
            }
            patchSearch({ task: "" });
          }
        }}
        onClose={() => {
          // Closing ends the draft ritual AND settles the filename to the
          // title — the rename runs now, with nothing mounted to flash, never
          // under the open editor. Reopening is an ordinary open.
          const path = draftPathRef.current;
          const api = editorApiRef.current;
          const liveSource = path !== null && api?.path === path ? api.source() : null;
          const flushed =
            path !== null && api?.path === path
              ? api.flushPending().catch(() => {})
              : Promise.resolve();
          setDraftPath(null);
          draftFocusRef.current = undefined;
          patchSearch({ task: "" });
          if (path !== null) void flushed.then(() => settleDraftRename(path, liveSource));
        }}
      />
    </>
  );
}
