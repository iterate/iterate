import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import type { TaskChangeSummary } from "../state.ts";
import { fallbackCommitMessage } from "../tasks-model.ts";

/** The slice of the server api this hook needs — board sessions and checkout clients both fit. */
export type CommitMessageApi = {
  generateCommitMessage(input: { changes: TaskChangeSummary[] }): Promise<string>;
};

/** Board auto-commit delay once any task change is pending. */
const TASK_AUTO_SAVE_MS = 60_000;

/**
 * Commit UX for the board, ported from the apps/os tasks view: a Commit
 * action, an AI "write commit message" helper, and a 60s idle autosave while
 * the board is mounted with pending task changes. Empty messages are
 * summarized deterministically inside the commit mutation (from the same
 * snapshot it sends), so the autosave path never waits on — or fails with —
 * an AI call.
 */
export function useTaskCommit({
  api,
  taskChanges,
  taskChangeSignature,
  enabled = true,
  onCommit,
}: {
  api: CommitMessageApi | null;
  taskChanges: readonly TaskChangeSummary[];
  taskChangeSignature: string;
  /** Auto-commit toggle: false parks the idle timer entirely. */
  enabled?: boolean;
  /** Pass a typed message, or `undefined` to let the commit path summarize its own snapshot. */
  onCommit: (message: string | undefined) => Promise<unknown>;
}) {
  const [commitMessage, setCommitMessage] = useState("");
  const [generatingMessage, setGeneratingMessage] = useState(false);
  const [autoSaveDueAt, setAutoSaveDueAt] = useState<number>();
  const commitInFlightRef = useRef(false);

  // 60s idle debounce: every change to the task change set restarts the
  // window, an empty set cancels it (including right after a commit clears
  // the committed overlays).
  useEffect(() => {
    setAutoSaveDueAt(
      !enabled || taskChangeSignature === "" ? undefined : Date.now() + TASK_AUTO_SAVE_MS,
    );
  }, [taskChangeSignature, enabled]);

  const commitTasks = useCallback(
    async (manualMessage?: string) => {
      if (commitInFlightRef.current || taskChanges.length === 0) return;
      commitInFlightRef.current = true;
      try {
        const typed = (manualMessage ?? "").trim();
        await onCommit(typed === "" ? undefined : typed);
        setCommitMessage("");
      } catch {
        // Push the next autosave attempt out so a hard failure does not spin.
        setAutoSaveDueAt(Date.now() + TASK_AUTO_SAVE_MS);
      } finally {
        commitInFlightRef.current = false;
      }
    },
    [onCommit, taskChanges.length],
  );

  // One timer per due-at, not a ticking effect: the countdown display
  // subscribes to its own clock inside a leaf component, so the board never
  // re-renders on ticks.
  const fireAutoSave = useEffectEvent(() => void commitTasks());
  useEffect(() => {
    if (autoSaveDueAt === undefined) return;
    const timer = setTimeout(fireAutoSave, Math.max(0, autoSaveDueAt - Date.now()));
    return () => clearTimeout(timer);
  }, [autoSaveDueAt]);

  const writeCommitMessage = useCallback(async () => {
    if (taskChanges.length === 0 || generatingMessage || api === null) return;
    setGeneratingMessage(true);
    try {
      const generated = await api.generateCommitMessage({
        changes: taskChanges.map(({ path, status, title }) => ({ path, status, title })),
      });
      setCommitMessage(generated.trim() || fallbackCommitMessage(taskChanges));
    } catch {
      setCommitMessage(fallbackCommitMessage(taskChanges));
    } finally {
      setGeneratingMessage(false);
    }
  }, [api, generatingMessage, taskChanges]);

  return {
    commitMessage,
    setCommitMessage,
    generatingMessage,
    autoSaveDueAt,
    makeCommit: () => void commitTasks(commitMessage),
    writeCommitMessage: () => void writeCommitMessage(),
  };
}
