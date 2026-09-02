import { useEffect, useMemo, useRef } from "react";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { html } from "@codemirror/lang-html";
import { markdown } from "@codemirror/lang-markdown";
import { useCollabEditor } from "./use-collab-editor.ts";
import type { CollabEditorApi } from "./collab-editor-api.ts";
import type { WorkspaceDocumentTransport } from "./types.ts";
import { referencesExtension, type ReferenceHost } from "./references.ts";

/**
 * Shared source editor: CodeMirror 6 over the workspace collab lane.
 * Hosts keep it lazy so their document-list and shell bundles stay small.
 */
export function WorkspaceDocumentEditor({
  transport,
  displayName,
  path,
  workspacePath,
  mode = "markdown",
  redline,
  emptyPlaceholder = "Write in Markdown…",
  focusHeadline,
  onLiveContent,
  onPeers,
  onStatus,
  onRequestClose,
  apiRef,
  references,
}: {
  transport: WorkspaceDocumentTransport;
  /** Reference kinds to light up as pills (with `@` / `[[` completion).
   * Referentially stable, please — a new object rebuilds the editor. */
  references?: ReferenceHost;
  displayName?: string;
  /** Host-facing document identifier used in callbacks. */
  path: string;
  /** Path sent to the workspace collab lane. Defaults to `path`. */
  workspacePath?: string;
  mode?: "html" | "markdown";
  redline: boolean;
  emptyPlaceholder?: string;
  focusHeadline?: "select" | "end" | { caret: number };
  apiRef?: { current: CollabEditorApi | null };
  onLiveContent: (path: string, content: string) => void;
  /** Everyone with a live caret on this document (self included) — for host
   * chrome such as a presence avatar strip. Null when the session ended. */
  onPeers?: (input: { self: string; clientIds: string[] } | null) => void;
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
      mode === "html" ? html() : markdown(),
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
      placeholder(emptyPlaceholder),
      ...(references === undefined ? [] : [referencesExtension(references)]),
      EditorView.theme({
        "&": { fontSize: "14px", height: "100%" },
        ".cm-content": { fontFamily: "var(--font-mono, ui-monospace)", padding: "16px" },
      }),
    ],
    [emptyPlaceholder, mode, references],
  );
  const editor = useCollabEditor({
    apiRef,
    displayName,
    extensions,
    focusHeadline,
    onLiveContent,
    onPeers,
    onStatus,
    path,
    workspacePath,
    redline,
    transport,
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
