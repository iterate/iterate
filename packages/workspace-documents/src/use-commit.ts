import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { toast } from "@iterate-com/ui/components/sonner";
import { fallbackCommitMessage, type FileChangeSummary } from "./change-summary.ts";

/** Auto-commit delay once any change is pending. */
const AUTO_SAVE_MS = 60_000;

/** The slice of a host's api this hook needs: a commit-message writer. */
type CommitMessageApi = {
  generateCommitMessage(input: { changes: FileChangeSummary[] }): Promise<string>;
};

/**
 * Commit UX for one change set, ported from the apps/os tasks view: a
 * Commit action, a "write commit message" helper, and a 60s idle autosave
 * while the host is mounted with pending changes. Empty messages are
 * summarized deterministically inside the commit mutation (from the same
 * snapshot it sends), so the autosave path never waits on — or fails with —
 * a message writer.
 */
export function useCommit({
  api,
  changes,
  changeSignature,
  enabled = true,
  onCommit,
}: {
  api: CommitMessageApi | null;
  changes: readonly FileChangeSummary[];
  /** A string that changes whenever the change set does — restarts the idle window. */
  changeSignature: string;
  /** Auto-commit toggle: false parks the idle timer entirely. */
  enabled?: boolean;
  /** Pass a typed message, or `undefined` to let the commit path summarize its own snapshot. */
  onCommit: (message: string | undefined) => Promise<unknown>;
}) {
  const [commitMessage, setCommitMessage] = useState("");
  const [generatingMessage, setGeneratingMessage] = useState(false);
  const [autoSaveDueAt, setAutoSaveDueAt] = useState<number>();
  const commitInFlightRef = useRef(false);

  // 60s idle debounce: every change to the change set restarts the window,
  // an empty set cancels it (including right after a commit clears the
  // committed overlays).
  useEffect(() => {
    setAutoSaveDueAt(!enabled || changeSignature === "" ? undefined : Date.now() + AUTO_SAVE_MS);
  }, [changeSignature, enabled]);

  const commitChanges = useCallback(
    async (manualMessage?: string) => {
      if (commitInFlightRef.current || changes.length === 0) return;
      commitInFlightRef.current = true;
      try {
        const typed = (manualMessage ?? "").trim();
        await onCommit(typed === "" ? undefined : typed);
        setCommitMessage("");
      } catch (cause) {
        // A failed publish needs attention; never retry it forever in the background.
        setAutoSaveDueAt(undefined);
        toast.error("Commit failed. Auto-commit paused.", {
          description: cause instanceof Error ? cause.message : String(cause),
        });
      } finally {
        commitInFlightRef.current = false;
      }
    },
    [onCommit, changes.length],
  );

  // One timer per due-at, not a ticking effect: the countdown display
  // subscribes to its own clock inside a leaf component, so the host never
  // re-renders on ticks.
  const fireAutoSave = useEffectEvent(() => void commitChanges());
  useEffect(() => {
    if (autoSaveDueAt === undefined) return;
    const timer = setTimeout(fireAutoSave, Math.max(0, autoSaveDueAt - Date.now()));
    return () => clearTimeout(timer);
  }, [autoSaveDueAt]);

  const writeCommitMessage = useCallback(async () => {
    if (changes.length === 0 || generatingMessage || api === null) return;
    setGeneratingMessage(true);
    try {
      const generated = await api.generateCommitMessage({
        changes: changes.map(({ path, status, title }) => ({ path, status, title })),
      });
      setCommitMessage(generated.trim() || fallbackCommitMessage(changes));
    } catch {
      setCommitMessage(fallbackCommitMessage(changes));
    } finally {
      setGeneratingMessage(false);
    }
  }, [api, generatingMessage, changes]);

  return {
    commitMessage,
    setCommitMessage,
    generatingMessage,
    autoSaveDueAt,
    makeCommit: () => void commitChanges(commitMessage),
    writeCommitMessage: () => void writeCommitMessage(),
  };
}
