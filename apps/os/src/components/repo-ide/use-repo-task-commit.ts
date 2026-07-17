import { useCallback, useEffect, useRef, useState } from "react";
import { useItx } from "iterate/react";
import {
  fallbackTaskCommitMessage,
  taskCommitMessagePrompt,
  type RepoTaskChange,
} from "./repo-tasks.ts";
import { useTickingNowMs } from "~/lib/use-ticking-now-ms.ts";

/** Tasks-view auto-commit delay once any task change is pending. */
const TASK_AUTO_SAVE_MS = 60_000;
const TASK_COMMIT_MODEL = "openai/gpt-5.5";

/**
 * Commit UX for the tasks board: optional AI commit messages, a Make Commit
 * action, and a 60s wall-clock autosave that only runs while the board is
 * mounted with pending task changes.
 */
export function useRepoTaskCommit({
  taskChanges,
  taskChangeSignature,
  commitPending,
  onCommitTaskChanges,
}: {
  taskChanges: readonly RepoTaskChange[];
  taskChangeSignature: string;
  commitPending: boolean;
  onCommitTaskChanges: (message: string) => Promise<unknown>;
}) {
  const itx = useItx();
  const [commitMessage, setCommitMessage] = useState("");
  const [generatingMessage, setGeneratingMessage] = useState(false);
  // Signature + due-at are adjusted during render when the task change set
  // mutates (React's "adjusting state when a prop changes" pattern).
  const [autoSave, setAutoSave] = useState<{ signature: string; dueAt: number } | null>(null);
  if (taskChangeSignature === "") {
    if (autoSave !== null) setAutoSave(null);
  } else if (autoSave?.signature !== taskChangeSignature) {
    setAutoSave({ signature: taskChangeSignature, dueAt: Date.now() + TASK_AUTO_SAVE_MS });
  }
  const autoSaveDueAt = autoSave?.dueAt;
  const nowMs = useTickingNowMs(250, autoSaveDueAt !== undefined, autoSaveDueAt ?? null);
  const autoSaveSecondsLeft =
    autoSaveDueAt === undefined
      ? undefined
      : Math.max(0, Math.ceil((autoSaveDueAt - nowMs) / 1000));
  const commitInFlightRef = useRef(false);

  const resolveCommitMessage = useCallback(
    async (manualMessage: string | undefined, changes: readonly RepoTaskChange[]) => {
      const typed = (manualMessage ?? "").trim();
      if (typed !== "") return typed;
      if (changes.length === 0) return fallbackTaskCommitMessage(changes);
      const prompt = taskCommitMessagePrompt(changes);
      try {
        const result = (await itx.ai.run(TASK_COMMIT_MODEL, {
          messages: [
            { role: "system", content: prompt.system },
            { role: "user", content: prompt.user },
          ],
        })) as { response?: string };
        const generated = result.response?.trim().replace(/^["']|["']$/g, "");
        if (generated) return generated.slice(0, 72);
      } catch {
        // Fall through to the deterministic summary.
      }
      return fallbackTaskCommitMessage(changes);
    },
    [itx],
  );

  const commitTasks = useCallback(
    async (manualMessage?: string) => {
      if (commitInFlightRef.current || taskChanges.length === 0) return;
      commitInFlightRef.current = true;
      try {
        const message = await resolveCommitMessage(manualMessage, taskChanges);
        await onCommitTaskChanges(message);
        setCommitMessage("");
        setAutoSave(null);
      } catch {
        // Push the next autosave attempt out so a hard failure does not spin.
        setAutoSave({
          signature: taskChangeSignature,
          dueAt: Date.now() + TASK_AUTO_SAVE_MS,
        });
      } finally {
        commitInFlightRef.current = false;
      }
    },
    [onCommitTaskChanges, resolveCommitMessage, taskChangeSignature, taskChanges],
  );

  const writeCommitMessage = useCallback(async () => {
    if (taskChanges.length === 0 || generatingMessage) return;
    setGeneratingMessage(true);
    try {
      const message = await resolveCommitMessage("", taskChanges);
      setCommitMessage(message);
    } finally {
      setGeneratingMessage(false);
    }
  }, [generatingMessage, resolveCommitMessage, taskChanges]);

  // Fire once the wall clock reaches the due-at. The shared ticker keeps
  // ticking in background tabs (throttled), so overdue commits still run.
  useEffect(() => {
    if (
      autoSaveDueAt === undefined ||
      commitPending ||
      taskChanges.length === 0 ||
      nowMs < autoSaveDueAt
    )
      return;
    void commitTasks();
  }, [autoSaveDueAt, commitPending, commitTasks, nowMs, taskChanges.length]);

  return {
    commitMessage,
    setCommitMessage,
    generatingMessage,
    autoSaveSecondsLeft,
    makeCommit: () => void commitTasks(commitMessage),
    writeCommitMessage: () => void writeCommitMessage(),
  };
}
