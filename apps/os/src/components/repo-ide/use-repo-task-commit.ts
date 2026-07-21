import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { useItx } from "iterate/sdk/itx/react";
import {
  fallbackTaskCommitMessage,
  taskCommitMessagePrompt,
  type RepoTaskChange,
} from "./repo-tasks.ts";

/** Tasks-view auto-commit delay once any task change is pending. */
const TASK_AUTO_SAVE_MS = 60_000;
const TASK_COMMIT_MODEL = "openai/gpt-5.5";

/**
 * Commit UX for the tasks board: a Make Commit action, an AI "write commit
 * message" helper, and a 60s idle autosave while the board is mounted with
 * pending task changes. Empty messages are summarized deterministically inside
 * the commit mutation (from the same snapshot it sends), so the autosave path
 * never waits on — or fails with — an AI call.
 */
export function useRepoTaskCommit({
  taskChanges,
  taskChangeSignature,
  onCommitTaskChanges,
}: {
  taskChanges: readonly RepoTaskChange[];
  taskChangeSignature: string;
  /** Pass a typed message, or `undefined` to let the commit path summarize its own snapshot. */
  onCommitTaskChanges: (message: string | undefined) => Promise<unknown>;
}) {
  const itx = useItx();
  const [commitMessage, setCommitMessage] = useState("");
  const [generatingMessage, setGeneratingMessage] = useState(false);
  const [autoSaveDueAt, setAutoSaveDueAt] = useState<number>();
  const commitInFlightRef = useRef(false);

  // 60s idle debounce: every change to the task change set restarts the
  // window, an empty set cancels it (including right after a commit clears
  // the committed overlays).
  useEffect(() => {
    setAutoSaveDueAt(taskChangeSignature === "" ? undefined : Date.now() + TASK_AUTO_SAVE_MS);
  }, [taskChangeSignature]);

  const commitTasks = useCallback(
    async (manualMessage?: string) => {
      if (commitInFlightRef.current || taskChanges.length === 0) return;
      commitInFlightRef.current = true;
      try {
        const typed = (manualMessage ?? "").trim();
        await onCommitTaskChanges(typed === "" ? undefined : typed);
        setCommitMessage("");
      } catch {
        // Push the next autosave attempt out so a hard failure does not spin.
        setAutoSaveDueAt(Date.now() + TASK_AUTO_SAVE_MS);
      } finally {
        commitInFlightRef.current = false;
      }
    },
    [onCommitTaskChanges, taskChanges.length],
  );

  // One timer per due-at, not a ticking effect: the countdown display
  // subscribes to the shared clock inside its own leaf component, so the
  // board never re-renders on ticks.
  const fireAutoSave = useEffectEvent(() => void commitTasks());
  useEffect(() => {
    if (autoSaveDueAt === undefined) return;
    const timer = setTimeout(fireAutoSave, Math.max(0, autoSaveDueAt - Date.now()));
    return () => clearTimeout(timer);
  }, [autoSaveDueAt]);

  const writeCommitMessage = useCallback(async () => {
    if (taskChanges.length === 0 || generatingMessage) return;
    setGeneratingMessage(true);
    try {
      const prompt = taskCommitMessagePrompt(taskChanges);
      const result = (await itx.ai.run(TASK_COMMIT_MODEL, {
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
      })) as { response?: string };
      const generated = result.response?.trim().replace(/^["']|["']$/g, "");
      setCommitMessage(generated ? generated.slice(0, 72) : fallbackTaskCommitMessage(taskChanges));
    } catch {
      setCommitMessage(fallbackTaskCommitMessage(taskChanges));
    } finally {
      setGeneratingMessage(false);
    }
  }, [generatingMessage, itx, taskChanges]);

  return {
    commitMessage,
    setCommitMessage,
    generatingMessage,
    autoSaveDueAt,
    makeCommit: () => void commitTasks(commitMessage),
    writeCommitMessage: () => void writeCommitMessage(),
  };
}
