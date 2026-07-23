import { useEffect, useMemo, useRef } from "react";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { useCollabEditor } from "../lib/use-collab-editor.ts";

/**
 * The CodeMirror half of the workspace task sheet, split out so the editor
 * stack (CM6 + collab + merge) loads ON DEMAND when a sheet opens — the
 * board bundle stays light (same pattern as the Yjs sheet's TaskEditor).
 */
export function WorkspaceTaskEditor({
  checkoutId,
  repoPath,
  path,
  redline,
  focusHeadline,
  onLiveContent,
  onStatus,
  onRequestClose,
  apiRef,
}: {
  checkoutId: string;
  repoPath: string;
  path: string;
  redline: boolean;
  focusHeadline?: "select" | "end" | { caret: number };
  apiRef?: { current: import("../lib/collab-editor-api.ts").CollabEditorApi | null };
  onLiveContent: (path: string, content: string) => void;
  onStatus?: (status: string) => void;
  /** Cmd/Ctrl+Enter: done editing — close the sheet. */
  onRequestClose?: () => void;
}) {
  // Through a ref so the keymap (inside the deps-free extensions memo) always
  // sees the current handler without rebuilding the editor state.
  const requestCloseRef = useRef(onRequestClose);
  useEffect(() => {
    requestCloseRef.current = onRequestClose;
  }, [onRequestClose]);
  const extensions = useMemo(
    () => [
      history(),
      keymap.of([
        {
          key: "Mod-Enter",
          run: () => {
            requestCloseRef.current?.();
            return true;
          },
        },
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      EditorView.lineWrapping,
      placeholder("Write the task as markdown…"),
      EditorView.theme({
        "&": { fontSize: "14px", height: "100%" },
        ".cm-content": { fontFamily: "var(--font-mono, ui-monospace)", padding: "16px" },
      }),
    ],
    [],
  );
  const editor = useCollabEditor({
    apiRef,
    checkoutId,
    extensions,
    focusHeadline,
    onLiveContent,
    onStatus,
    path,
    redline,
    repoPath,
  });

  return (
    <>
      {editor.recovery !== null && (
        <div className="border-b bg-amber-500/10 px-4 py-2 text-xs text-amber-900">
          <div className="flex items-center gap-2">
            <span>Unaccepted text from before the re-sync (not in the document):</span>
            <button type="button" className="ml-auto underline" onClick={editor.dismissRecovery}>
              dismiss
            </button>
          </div>
          <pre className="mt-1 rounded bg-white/60 p-2 whitespace-pre-wrap">{editor.recovery}</pre>
        </div>
      )}
      <div ref={editor.host} className="min-h-0 flex-1 overflow-auto" />
    </>
  );
}
