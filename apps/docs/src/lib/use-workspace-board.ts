import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TaskChangeStatus, TaskChangeSummary } from "../state.ts";
import { isTaskFilePath, parseTaskCard } from "../tasks-model.ts";
import { withProject, workspaceFor } from "./project-rpc.ts";
import type { TasksWorkspace, WorkspaceStreamEvent } from "./tasks-api.ts";
import type { BoardAddress } from "./board-shared.ts";
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
 * The vessel already strips the repo mount prefix from everything it
 * returns; this guard drops stray leading slashes so mixed forms can't
 * silently split sessions or miss badges. */
export function boardKey(path: string): string {
  return path.replace(/^\/+/, "");
}

type WorkspaceStatusShape = {
  mounts?: { changes?: { change: string; path: string }[]; path?: string }[];
};

/** status() is workspace-wide — every project repo is a mount — but this
 * board is ONE repo: only the matching mount's changes count, and their
 * fully qualified paths become repo-relative board keys. `include` picks
 * the files a lens cares about (task files here; documents for the tree). */
export function changeMap(
  status: unknown,
  repoPath: string,
  include: (key: string) => boolean = isTaskFilePath,
): Map<string, TaskChangeStatus> {
  const map = new Map<string, TaskChangeStatus>();
  for (const mount of (status as WorkspaceStatusShape).mounts ?? []) {
    if (mount.path !== repoPath) continue;
    for (const entry of mount.changes ?? []) {
      const key = boardKey(entry.path.slice(repoPath.length));
      if (!include(key)) continue;
      const kind =
        entry.change === "added" ? "added" : entry.change === "deleted" ? "deleted" : "modified";
      map.set(key, kind);
    }
  }
  return map;
}

export function useWorkspaceBoard(address: BoardAddress) {
  const { boardId, workspacePath, repoPath } = address;
  const [files, setFiles] = useState<Record<string, string> | null>(null);
  const [changes, setChanges] = useState<Map<string, TaskChangeStatus>>(new Map());
  // Fresh caret presence per path — "who has this card open" (clientIds).
  const [viewers, setViewers] = useState<Map<string, string[]>>(new Map());
  // Everyone with the BOARD open (heartbeats), self included once announced.
  const [boardClients, setBoardClients] = useState<{ clientId: string; name: string }[]>([]);
  const [self, setSelf] = useState<{ clientId: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  const lane = useCallback(
    <T>(operation: (ws: TasksWorkspace) => Promise<T>) =>
      withProject((project) =>
        operation(workspaceFor(project, { boardId, workspacePath, repoPath })),
      ),
    [boardId, workspacePath, repoPath],
  );

  // Initial seed: the whole task file set + dirty state, in parallel.
  useEffect(() => {
    const mine = ++generation.current;
    setFiles(null);
    setError(null);
    void Promise.all([lane((ws) => ws.files()), lane((ws) => ws.status())])
      .then(([seeded, status]) => {
        if (generation.current !== mine) return;
        setFiles(
          Object.fromEntries(Object.entries(seeded).map(([path, c]) => [boardKey(path), c])),
        );
        setChanges(changeMap(status, repoPath));
      })
      .catch((cause: unknown) => {
        if (generation.current !== mine) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      generation.current++;
    };
  }, [lane, repoPath]);

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
  // react-doctor-disable-next-line react-doctor/rerender-lazy-ref-init -- empty-container allocation per render is the rule's concern; trivial here, and the ??= lazy idiom trips exhaustive-deps instead
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
        // Cheap in-memory reads; failures just keep the previous dots.
        lane((ws) => ws.presenceSummary()).catch(() => null),
        lane((ws) => ws.boardViewers()).catch(() => null),
      ])
        .then(async ([rawVersions, status, presence, board]) => {
          if (presence !== null && generation.current === mine) {
            setViewers(
              new Map(Object.entries(presence).map(([path, ids]) => [boardKey(path), ids])),
            );
          }
          if (board !== null && generation.current === mine) {
            setBoardClients(Object.entries(board).map(([clientId, name]) => ({ clientId, name })));
          }
          if (generation.current !== mine) return;
          const changes = changesRef.current;
          const next = status === null ? changes : changeMap(status, repoPath);
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
              async (path) =>
                [boardKey(path), await lane((ws) => ws.read(`/${boardKey(path)}`))] as const,
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
  }, [lane, repoPath]);

  // Board-viewer heartbeat: announce on join (and every 25s — the server
  // ages entries at 45s), clear on leave. Identity via whoami; the clientId
  // wears the display slug so colors/labels match redlines and carets.
  // react-doctor-disable-next-line react-doctor/effect-needs-cleanup
  useEffect(() => {
    // (The interval IS cleaned up: it is allocated inside the whoami .then,
    // and the cleanup below clears it — the rule cannot see through the
    // promise.)
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    let clientId: string | null = null;
    void withProject((project) =>
      (
        project as {
          whoami(): Promise<{ name: string | null; email: string | null; userId: string | null }>;
        }
      ).whoami(),
    )
      .then((me) => {
        if (stopped) return;
        const name = me.name ?? me.email ?? me.userId ?? "someone";
        const slug =
          name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 24) || "someone";
        clientId = `u-${slug}-${Math.random().toString(36).slice(2, 8)}`;
        setSelf({ clientId, name });
        const announce = () => void lane((ws) => ws.boardPresent(clientId!, name)).catch(() => {});
        announce();
        timer = setInterval(announce, 25_000);
      })
      .catch(() => {});
    return () => {
      stopped = true;
      if (timer !== null) clearInterval(timer);
      if (clientId !== null) void lane((ws) => ws.boardPresent(clientId!, null)).catch(() => {});
    };
  }, [lane]);

  // Per-file parse cache: a poll refetch or one live keystroke must cost
  // O(changed files), never a reparse of the whole board.
  // react-doctor-disable-next-line react-doctor/rerender-lazy-ref-init -- empty-container allocation per render is the rule's concern; trivial here, and the ??= lazy idiom trips exhaustive-deps instead
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
  const tracked = useCallback(async <T>(work: Promise<T>): Promise<T> => {
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
      // DELIBERATE impurity (react-doctor flags it): the rollback snapshot
      // and the add-vs-modify decision must read the files map AT APPLY
      // TIME, atomically with the optimistic write — a render-time closure
      // would be stale under rapid mutations. The nested updaters are
      // idempotent, so React double-invoking them is harmless.
      // react-doctor-disable-next-line react-doctor/no-impure-state-updater
      setFiles((current) => {
        priorContent = current?.[path];
        // The transition needs to know if the path existed BEFORE this write
        // (unknown path = an ADD, not a modification), so status updates
        // inside the same setter that sees the pre-write files.
        // react-doctor-disable-next-line react-doctor/no-impure-state-updater, react-doctor/no-side-effect-in-state-updater-function
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
      // Same deliberate apply-time capture as writeTask.
      // react-doctor-disable-next-line react-doctor/no-impure-state-updater
      setFiles((current) => {
        if (current === null) return current;
        priorContent = current[path];
        const { [path]: _gone, ...rest } = current;
        return rest;
      });
      // Deleted cards belong on the Deleted strip immediately — and deleting
      // an uncommitted add erases the change instead of leaving a phantom.
      // react-doctor-disable-next-line react-doctor/no-impure-state-updater
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
    // Same deliberate shape: arming the commit controls must see the same
    // files snapshot the reflect applies onto (idempotent inner updater).
    // react-doctor-disable-next-line react-doctor/no-impure-state-updater
    setFiles((current) => {
      // Reflect only onto paths the mirror still holds — an unmount flush
      // arriving after a rename/delete must not resurrect a phantom card.
      if (current === null || current[path] === undefined || current[path] === content)
        return current;
      // A live edit IS dirtiness: commit controls must arm on the first
      // keystroke, not on the next status poll.
      // react-doctor-disable-next-line react-doctor/no-side-effect-in-state-updater-function
      setChanges((changes) =>
        changes.has(path)
          ? changes
          : new Map(changes).set(path, changeAfterWrite(undefined, current[path] !== undefined)),
      );
      return { ...current, [path]: content };
    });
  }, []);

  /** One file's merged-view content (the live head when a session is open). */
  const readTask = useCallback((path: string) => lane((ws) => ws.read(`/${path}`)), [lane]);

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
  const discardAll = useCallback(async (): Promise<boolean> => {
    const results = await Promise.all([...changes.keys()].map((path) => revertTask(path)));
    return results.every(Boolean);
  }, [changes, revertTask]);

  /** Full reseed (files + status) — the fresh truth after a server-side
   * mutation outside the board's own lanes (a commit, an agent assignment).
   * The epoch bumps ensure a poll that started mid-mutation can't wipe it. */
  const refresh = useCallback(async (): Promise<void> => {
    mutationEpoch.current++;
    const [seeded, status] = await Promise.all([
      lane((ws) => ws.files()),
      lane((ws) => ws.status()),
    ]);
    mutationEpoch.current++;
    // Same key normalization as the seed — mixed-shape keys would orphan
    // badges and duplicate cards after the first commit.
    setFiles(Object.fromEntries(Object.entries(seeded).map(([path, c]) => [boardKey(path), c])));
    setChanges(changeMap(status, repoPath));
  }, [lane, repoPath]);

  const commit = useCallback(
    async (message: string) => {
      mutationEpoch.current++;
      const result = await lane((ws) => ws.commit(message));
      await refresh();
      return result;
    },
    [lane, refresh],
  );

  const subscribeEvents = useCallback(
    (onBatch: (events: WorkspaceStreamEvent[]) => void, afterOffset?: number) =>
      lane((ws) => ws.subscribeEvents((batch) => onBatch(batch.events), afterOffset)),
    [lane],
  );

  return {
    boardClients,
    changes,
    self,
    viewers,
    commit,
    deleteTask,
    discardAll,
    error,
    files,
    refresh,
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
