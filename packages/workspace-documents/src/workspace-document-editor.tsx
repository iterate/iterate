import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { html } from "@codemirror/lang-html";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { highlightMarkdown } from "@atomic-editor/editor";
import { ReviewComposer } from "@iterate-com/ui/components/document-comments";
import { useCollabEditor } from "./use-collab-editor.ts";
import type { CollabEditorApi, EditorReviewConfig } from "./collab-editor-api.ts";
import { richMarkdown } from "./rich-markdown.ts";
import type { ReviewComposerMount } from "./rfm-review-extension.ts";
import type { WorkspaceDocumentTransport } from "./types.ts";

/**
 * Shared live Markdown editor: CodeMirror 6 over the workspace collaboration session.
 * Hosts keep it lazy so their document-list and shell bundles stay small.
 */
export function WorkspaceDocumentEditor({
  transport,
  displayName,
  path,
  workspacePath,
  mode = "markdown",
  presentation = "source",
  review,
  redline,
  emptyPlaceholder = "Write in Markdown…",
  focusHeadline,
  onLiveContent,
  onPeers,
  onStatus,
  onRequestClose,
  apiRef,
}: {
  transport: WorkspaceDocumentTransport;
  displayName?: string;
  /** Host-facing document identifier used in callbacks. */
  path: string;
  /** Path sent to the workspace collaboration session. Defaults to `path`. */
  workspacePath?: string;
  mode?: "html" | "markdown";
  presentation?: "rich" | "source";
  review?: EditorReviewConfig;
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
  const reviewRef = useRef(review);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [composer, setComposer] = useState<ReviewComposerMount | null>(null);
  const [commentDraft, setCommentDraft] = useState("");
  useEffect(() => {
    requestCloseRef.current = onRequestClose;
  }, [onRequestClose]);
  useEffect(() => {
    reviewRef.current = review;
  }, [review]);
  useEffect(() => {
    composerTextareaRef.current?.focus();
  }, [composer?.element]);
  const extensions = useMemo(
    () => [
      history(),
      mode === "html"
        ? html()
        : markdown({ base: markdownLanguage, extensions: highlightMarkdown }),
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
      EditorView.theme({
        "&": { fontSize: "14px", height: "100%" },
        ".cm-content": { fontFamily: "var(--font-mono, ui-monospace)", padding: "16px" },
      }),
    ],
    [emptyPlaceholder, mode],
  );
  const canComment = review?.onComment !== undefined;
  const richPresentation = useMemo(
    () =>
      mode === "markdown" && presentation === "rich"
        ? richMarkdown({
            selectedThreadId: review?.selectedThreadId ?? null,
            onSelectThread: (id) => reviewRef.current?.onSelectThread(id),
            onComment: canComment
              ? (range, body) => reviewRef.current?.onComment?.(range, body) ?? false
              : undefined,
            mountComposer: setComposer,
          })
        : [],
    [canComment, mode, presentation, review?.selectedThreadId],
  );
  const editor = useCollabEditor({
    apiRef,
    displayName,
    extensions,
    presentation: richPresentation,
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
      {commentDraft && (!composer || presentation !== "rich") ? (
        <p role="status" className="border-t px-4 py-2 text-xs text-muted-foreground">
          Comment draft saved. Select text in rich mode to continue.
        </p>
      ) : null}
      {presentation === "rich" && composer
        ? createPortal(
            <ReviewComposer
              initialValue={commentDraft}
              onDraftChange={setCommentDraft}
              textareaRef={composerTextareaRef}
              placeholder="Comment on selected text…"
              submitLabel="Add comment"
              onSubmit={canComment ? composer.submit : undefined}
              onCancel={() => {
                setCommentDraft("");
                composer.cancel();
              }}
            />,
            composer.element,
          )
        : null}
    </>
  );
}
