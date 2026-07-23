import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TaskChangeStatus, TaskChangeSummary } from "../state.ts";
import { isTaskFilePath, parseTaskCard } from "../tasks-model.ts";
import { withProject } from "./use-checkout.ts";
import type { TasksWorkspace, WorkspaceStreamEvent } from "./tasks-api.ts";
import { changeAfterDelete, changeAfterWrite, toBoardTask, type BoardTask } from "./board-model.ts";

/**
 * The board's data layer on the WORKSPACE mechanism: the platform overlay is
 * the single source of truth (no Y.Doc, no base snapshot — `status()` IS the
 * diff). Reads seed from `files()`; liveness is a light status poll that
 * refetches only changed paths; every mutation is the same write an agent
 * would make, applied optimistically and confirmed by the poll.
 */

const POLL_MS = 3500;

/** ONE key form for everything the board holds: repo-relative, no leading
 * slash — the same shape the Yjs lane's task paths and isTaskFilePath use.
 * The platform returns absolute paths from glob/status; writes go back
 * absolute. Mixing forms silently splits sessions and misses badges. */
export function boardKey(path: string): string {
  return path.replace(/^\/+/, "");
}

type WorkspaceStatusShape = {
  mounts?: { changes?: { change: string; path: string }[] }[];
};

export function changeMap(status: unknown): Map<string, TaskChangeStatus> {
  const map = new Map<string, TaskChangeStatus>();
  for (const mount of (status as WorkspaceStatusShape).mounts ?? []) {
    for (const entry of mount.changes ?? []) {
      if (!isTaskFilePath(entry.path)) continue;
      const kind =
        entry.change === "added" ? "added" : entry.change === "deleted" ? "deleted" : "modified";
      map.set(boardKey(entry.path), kind);
    }
  }
  return map;
}

export function useWorkspaceBoard(checkoutId: string, repoPath: string) {
  const [files, setFiles] = useState<Record<string, string> | null>(null);
  const [changes, setChanges] = useState<Map<string, TaskChangeStatus>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  const lane = useCallback(
    <T,>(operation: (ws: TasksWorkspace) => Promise<T>) =>
      withProject((project) =>
        operation(
          (project as { workspace(c: string, r?: string): unknown }).workspace(
            checkoutId,
            repoPath,
          ) as TasksWorkspace,
        ),
      ),
    [checkoutId, repoPath],
  );

  // Initial seed: the whole task file set + dirty state, in parallel.
  useEffect(() => {
    const mine = ++generation.current;
    setFiles(null);
    setError(null);
    void Promise.all([lane((ws) => ws.files()), lane((ws) => ws.status())])
      .then(([seeded, status]) => {
        if (generation.current !== mine) return;
        setFiles(Object.fromEntries(Object.entries(seeded).map(([path, c]) => [boardKey(path), c])));
        setChanges(changeMap(status));
      })
      .catch((cause: unknown) => {
        if (generation.current !== mine) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      generation.current++;
    };
  }, [lane]);

  // Liveness: the collab VERSION map is the change cursor — a path whose
  // head advanced gets refetched even when its status kind is unchanged
  // (modified → modified was invisible to a kind-only diff). Status refreshes
  // badges on the same tick; poll errors surface instead of vanishing.
  const versionsRef = useRef<Record<string, number>>({});
  const tickRef = useRef(0);
  // The tick reads changes through a ref: depending on the map would tear
  // the interval down on every badge change and reset the status cadence.
  const changesRef = useRef(changes);
  useEffect(() => {
    changesRef.current = changes;
  });
  // Bumped by EVERY local mutation (writes, deletes, live keystrokes,
  // reverts, commits): an in-flight poll response from before the mutation
  // must not overwrite newer local state — badges OR file content. The next
  // tick reconciles with server truth.
  const mutationEpoch = useRef(0);
  // In-flight mutation RPCs: the poll discards while any are mid-air — an
  // epoch only marks transitions; this covers the whole window (e.g. a
  // rename's source living on server-side through onWritten/carry/delete).
  const pendingMutations = useRef(0);
  // Live keystrokes bump PER-PATH epochs, not the global one: typing must
  // only shield its own file from stale poll fetches — remote updates to
  // other cards keep flowing while someone types.
  const pathEpochs = useRef(new Map<string, number>());
  useEffect(() => {
    const mine = generation.current;
    const timer = setInterval(() => {
      // versions() is a cheap map read; status() runs the settle barrier and
      // git classification — polling THAT every tick makes the whole page
      // pay a platform barrier per few seconds. Badges refresh on a slower
      // cadence and after mutations/commits.
      const wantStatus = tickRef.current++ % 4 === 0;
      const epochBefore = mutationEpoch.current;
      const pathEpochsBefore = new Map(pathEpochs.current);
      void Promise.all([
        lane((ws) => ws.versions()),
        wantStatus ? lane((ws) => ws.status()) : Promise.resolve(null),
      ])
        .then(async ([rawVersions, status]) => {
          if (generation.current !== mine) return;
          const changes = changesRef.current;
          const next = status === null ? changes : changeMap(status);
          const versions = Object.fromEntries(
            Object.entries(rawVersions).map(([path, version]) => [boardKey(path), version]),
          );
          const moved = new Set<string>();
          for (const [path, version] of Object.entries(versions)) {
            if (versionsRef.current[path] !== version) moved.add(path);
          }
          // A path that VANISHED from the version map was removed remotely
          // (deleted, or committed away) — refetch clears the phantom card.
          for (const path of Object.keys(versionsRef.current)) {
            if (!(path in versions)) moved.add(path);
          }
          if (status !== null) {
            for (const [path, kind] of next) if (changes.get(path) !== kind) moved.add(path);
            for (const path of changes.keys()) if (!next.has(path)) moved.add(path);
          }
          if (moved.size === 0) {
            versionsRef.current = versions;
            return;
          }
          const fetched = await Promise.all(
            [...moved].map(
              async (path) => [boardKey(path), await lane((ws) => ws.read(`/${boardKey(path)}`))] as const,
            ),
          );
          if (generation.current !== mine) return;
          // One epoch check for BOTH maps: fetched content that started
          // before a local mutation is as stale as its badges. Bail BEFORE
          // recording versions — a skipped tick must leave the cursor
          // behind so the next tick re-detects (and re-fetches) the paths.
          // Also bail while any mutation RPC is mid-air: the epoch marks
          // transitions, the counter covers the whole window.
          if (mutationEpoch.current !== epochBefore || pendingMutations.current > 0) return;
          versionsRef.current = versions;
          if (status !== null) setChanges(next);
          setFiles((current) => {
            if (current === null) return current;
            const merged = { ...current };
            for (const [path, content] of fetched) {
              // A keystroke landed on this path mid-poll: its fetch is stale.
              if (pathEpochs.current.get(path) !== pathEpochsBefore.get(path)) continue;
              if (content === null) delete merged[path];
              else merged[path] = content;
            }
            return merged;
          });
        })
        .catch((cause: unknown) =>
          setError(cause instanceof Error ? cause.message : String(cause)),
        );
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [lane]);

  // Per-file parse cache: a poll refetch or one live keystroke must cost
  // O(changed files), never a reparse of the whole board.
  const parseCache = useRef(new Map<string, { source: string; task: BoardTask }>());
  const tasks = useMemo<BoardTask[]>(() => {
    if (files === null) return [];
    const cache = parseCache.current;
    const next: BoardTask[] = [];
    for (const [path, source] of Object.entries(files)) {
      if (!isTaskFilePath(path)) continue;
      const cached = cache.get(path);
      if (cached !== undefined && cached.source === source) {
        next.push(cached.task);
        continue;
      }
      const task = toBoardTask(path, source);
      cache.set(path, { source, task });
      next.push(task);
    }
    if (cache.size > next.length * 2) {
      for (const key of cache.keys()) if (files[key] === undefined) cache.delete(key);
    }
    return next.sort((left, right) => left.path.localeCompare(right.path));
  }, [files]);

  /** Roll one path's optimistic files+changes state back to what a failed
   * RPC left behind on the server (shared by write and delete). */
  /** Run one mutation RPC with the in-flight counter held. */
  const tracked = useCallback(async <T,>(work: Promise<T>): Promise<T> => {
    pendingMutations.current++;
    try {
      return await work;
    } finally {
      pendingMutations.current--;
    }
  }, []);

  const restoreOnFailure = useCallback(
    (path: string, priorContent: string | undefined, priorChange: TaskChangeStatus | undefined) =>
      (cause: unknown) => {
        mutationEpoch.current++;
        setError(cause instanceof Error ? cause.message : String(cause));
        setFiles((current) => {
          if (current === null) return current;
          if (priorContent === undefined) {
            const { [path]: _gone, ...rest } = current;
            return rest;
          }
          return { ...current, [path]: priorContent };
        });
        setChanges((current) => {
          const next = new Map(current);
          if (priorChange === undefined) next.delete(path);
          else next.set(path, priorChange);
          return next;
        });
      },
    [],
  );

  /** Optimistic local write + the same platform write an agent would make;
   * an RPC failure restores the prior card and badge (no phantom adds or
   * stale edits waiting on a poll to reconcile). */
  const writeTask = useCallback(
    (path: string, content: string) => {
      mutationEpoch.current++;
      let priorContent: string | undefined;
      let priorChange: TaskChangeStatus | undefined;
      setFiles((current) => {
        priorContent = current?.[path];
        // The transition needs to know if the path existed BEFORE this write
        // (unknown path = an ADD, not a modification), so status updates
        // inside the same setter that sees the pre-write files.
        setChanges((changes) => {
          priorChange = changes.get(path);
          return new Map(changes).set(
            path,
            changeAfterWrite(changes.get(path), current?.[path] !== undefined),
          );
        });
        return current === null ? current : { ...current, [path]: content };
      });
      return tracked(lane((ws) => ws.write(`/${path}`, content))).then(
        () => {
          // Close the race window: a poll that STARTED during this RPC read
          // pre-write state — the landing bump makes its apply-time check
          // fail instead of wiping the optimistic card.
          mutationEpoch.current++;
          return true;
        },
        (cause: unknown) => {
          restoreOnFailure(path, priorContent, priorChange)(cause);
          return false;
        },
      );
    },
    [lane, restoreOnFailure, tracked],
  );

  const deleteTask = useCallback(
    (path: string) => {
      mutationEpoch.current++;
      let priorContent: string | undefined;
      let priorChange: TaskChangeStatus | undefined;
      setFiles((current) => {
        if (current === null) return current;
        priorContent = current[path];
        const { [path]: _gone, ...rest } = current;
        return rest;
      });
      // Deleted cards belong on the Deleted strip immediately — and deleting
      // an uncommitted add erases the change instead of leaving a phantom.
      setChanges((current) => {
        priorChange = current.get(path);
        const next = new Map(current);
        const transitioned = changeAfterDelete(current.get(path));
        if (transitioned === null) next.delete(path);
        else next.set(path, transitioned);
        return next;
      });
      // The workspace still has the file on failure — put the card (and its
      // badge) back instead of pretending the delete happened.
      void tracked(lane((ws) => ws.delete(`/${path}`))).then(
        () => {
          mutationEpoch.current++; // see writeTask — cover the whole window
        },
        (cause: unknown) => restoreOnFailure(path, priorContent, priorChange)(cause),
      );
    },
    [lane, restoreOnFailure, tracked],
  );

  /** Live content from an open editor session — keeps the card current
   * while typing without waiting for the flush + poll round trip. */
  const reflectLiveContent = useCallback((path: string, content: string) => {
    pathEpochs.current.set(path, (pathEpochs.current.get(path) ?? 0) + 1);
    setFiles((current) => {
      // Reflect only onto paths the mirror still holds — an unmount flush
      // arriving after a rename/delete must not resurrect a phantom card.
      if (current === null || current[path] === undefined || current[path] === content)
        return current;
      // A live edit IS dirtiness: commit controls must arm on the first
      // keystroke, not on the next status poll.
      setChanges((changes) =>
        changes.has(path)
          ? changes
          : new Map(changes).set(path, changeAfterWrite(undefined, current[path] !== undefined)),
      );
      return { ...current, [path]: content };
    });
  }, []);

  /** One file's merged-view content (the live head when a session is open). */
  const readTask = useCallback(
    (path: string) => lane((ws) => ws.read(`/${path}`)),
    [lane],
  );

  /**
   * Rename: NOTHING moves locally until the write RPC lands — the open
   * sheet must keep its editor (and the user's text) mounted on the old
   * path until the target exists; a failed create then needs no rollback.
   * On success the local swap applies, `onWritten` fires (navigation), the
   * final-frame carry folds a last keystroke from the dying session onto
   * the new path, and only then is the source deleted.
   */
  const renameTask = useCallback(
    async (
      fromPath: string,
      toPath: string,
      content: string,
      carry: (finalSource: string) => string = (source) => source,
      /** Runs once the write RPC landed — the moment navigation is safe.
       * AWAITED before the carry read: lanes flush the old editor here so
       * the carry sees its final keystrokes. */
      onWritten?: () => void | Promise<void>,
    ): Promise<string | null> => {
      // The pre-write server head: the carry must only fire when the OLD
      // session genuinely advanced after this point — comparing against our
      // written content would let an older server head overwrite unpushed
      // local text that exists nowhere else.
      const baseline = await lane((ws) => ws.read(`/${fromPath}`)).catch(() => null);
      try {
        await tracked(lane((ws) => ws.write(`/${toPath}`, content)));
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        setError(message);
        return message;
      }
      mutationEpoch.current++;
      setChanges((current) => {
        const next = new Map(current);
        next.set(toPath, changeAfterWrite(current.get(toPath), false));
        const transitioned = changeAfterDelete(current.get(fromPath));
        if (transitioned === null) next.delete(fromPath);
        else next.set(fromPath, transitioned);
        return next;
      });
      setFiles((current) => {
        if (current === null) return current;
        const { [fromPath]: _gone, ...rest } = current;
        return { ...rest, [toPath]: content };
      });
      // The whole tail (navigate, carry, delete) keeps the counter held —
      // the source lives server-side until the delete lands, and a poll in
      // that window must not resurrect it beside the new card.
      pendingMutations.current++;
      try {
      await onWritten?.();
      try {
        const final = await lane((ws) => ws.read(`/${fromPath}`));
        if (final !== null && final !== baseline) {
          const carried = carry(final);
          if (carried !== content) {
            await lane((ws) => ws.write(`/${toPath}`, carried));
            mutationEpoch.current++;
            setFiles((current) =>
              current === null ? current : { ...current, [toPath]: carried },
            );
          }
        }
      } catch {
        // The carry is best-effort; the source still gets deleted below.
      }
      try {
        await lane((ws) => ws.delete(`/${fromPath}`));
        mutationEpoch.current++; // a poll mid-delete read fromPath alive
      } catch {
        // The delete failed — the server still HAS the source; the next
        // poll re-showing it is truthful reconciliation.
      }
      } finally {
        pendingMutations.current--;
      }
      return null;
    },
    [lane, tracked],
  );

  /** Change summaries in the shape the commit controls speak. */
  const taskChanges = useMemo<TaskChangeSummary[]>(
    () =>
      [...changes.entries()]
        .map(([path, status]) => ({
          path,
          status,
          title:
            files?.[path] !== undefined
              ? parseTaskCard(path, files[path]).title
              : (path.split("/").at(-1) ?? path),
        }))
        .sort((left, right) => left.path.localeCompare(right.path)),
    [changes, files],
  );

  /** Back to the mount's version — restore a delete, drop an add, undo edits. */
  /** Resolves once the revert RPC landed and local state reflects it — the
   * route remounts open editors AFTER this (the platform ended the file's
   * session; an early remount would attach to the dying one). */
  const revertTask = useCallback(
    (path: string): Promise<boolean> => {
      mutationEpoch.current++;
      return lane(async (ws) => {
        await ws.revert(`/${path}`);
        mutationEpoch.current++;
        const content = await ws.read(`/${path}`);
        setFiles((current) => {
          if (current === null) return current;
          const merged = { ...current };
          if (content === null) delete merged[path];
          else merged[path] = content;
          return merged;
        });
        setChanges((current) => {
          const next = new Map(current);
          next.delete(path);
          return next;
        });
        return true;
      }).catch((cause: unknown) => {
        // Failure must be VISIBLE to callers: a remount on a failed revert
        // would reseat the editor against a session that never ended.
        setError(cause instanceof Error ? cause.message : String(cause));
        return false;
      });
    },
    [lane],
  );

  /** True only when EVERY revert landed. */
  const discardAll = useCallback(
    async (): Promise<boolean> => {
      const results = await Promise.all([...changes.keys()].map((path) => revertTask(path)));
      return results.every(Boolean);
    },
    [changes, revertTask],
  );

  const commit = useCallback(
    async (message: string) => {
      mutationEpoch.current++;
      const result = await lane((ws) => ws.commit(message));
      const [seeded, status] = await Promise.all([
        lane((ws) => ws.files()),
        lane((ws) => ws.status()),
      ]);
      // The refetch is the fresh truth; bump again so a poll that started
      // mid-commit can't wipe the post-commit clean state.
      mutationEpoch.current++;
      // Same key normalization as the seed — mixed-shape keys would orphan
      // badges and duplicate cards after the first commit.
      setFiles(Object.fromEntries(Object.entries(seeded).map(([path, c]) => [boardKey(path), c])));
      setChanges(changeMap(status));
      return result;
    },
    [lane],
  );

  const subscribeEvents = useCallback(
    (onBatch: (events: WorkspaceStreamEvent[]) => void, afterOffset?: number) =>
      lane((ws) => ws.subscribeEvents((batch) => onBatch(batch.events), afterOffset)),
    [lane],
  );

  return {
    changes,
    commit,
    deleteTask,
    discardAll,
    error,
    files,
    subscribeEvents,
    ready: files !== null,
    readTask,
    reflectLiveContent,
    renameTask,
    revertTask,
    taskChanges,
    tasks,
    writeTask,
  };
}
