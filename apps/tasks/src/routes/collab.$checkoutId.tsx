import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { useCollabEditor } from "../lib/use-collab-editor.ts";
import { DEFAULT_REPO_PATH, normalizeRepoPath } from "../lib/checkout-shared.ts";

/**
 * PoC page for the no-Yjs collab lane: one file, one CodeMirror editor over
 * the shared collab-editor state machine, with the redline layers (merge
 * view + attribution over ONE baseline) behind a toggle.
 *   /collab/<checkoutId>?path=/tasks/foo.md&repo=/repos/config
 */
export const Route = createFileRoute("/collab/$checkoutId")({
  validateSearch: (search: Record<string, unknown>) => ({
    path: typeof search.path === "string" ? search.path : "/tasks/design-review.md",
    repo: typeof search.repo === "string" ? search.repo : DEFAULT_REPO_PATH,
  }),
  component: CollabPage,
});

function CollabPage() {
  const { checkoutId } = Route.useParams();
  const search = Route.useSearch();
  const [redline, setRedline] = useState(true);
  const extensions = useMemo(
    () => [
      lineNumbers(),
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorView.lineWrapping,
    ],
    [],
  );
  const editor = useCollabEditor({
    checkoutId,
    extensions,
    path: search.path.replace(/^\/+/, ""),
    redline,
    repoPath: normalizeRepoPath(search.repo) ?? DEFAULT_REPO_PATH,
  });

  return (
    <div className="flex h-dvh flex-col">
      <div className="flex items-center gap-3 border-b px-4 py-2 font-mono text-xs text-muted-foreground">
        <span className="font-semibold text-foreground">collab poc</span>
        <span>{checkoutId}</span>
        <span>{search.path}</span>
        <span data-testid="collab-status">{editor.status}</span>
        <button
          type="button"
          className={`ml-auto rounded border px-2 py-0.5 ${redline ? "bg-foreground text-background" : ""}`}
          onClick={() => {
            const next = !redline;
            setRedline(next);
            editor.toggle(next);
          }}
        >
          redline
        </button>
      </div>
      {editor.recovery !== null && (
        <div className="border-b bg-amber-500/10 px-4 py-2 text-xs text-amber-900">
          <div className="flex items-center gap-2">
            <span>
              Re-synced past retained history — this text of yours was not yet accepted and is NOT
              in the document (copy it back in if you still want it):
            </span>
            <button type="button" className="ml-auto underline" onClick={editor.dismissRecovery}>
              dismiss
            </button>
          </div>
          <pre className="mt-1 rounded bg-white/60 p-2 whitespace-pre-wrap">{editor.recovery}</pre>
        </div>
      )}
      <div ref={editor.host} className="min-h-0 flex-1 overflow-auto [&_.cm-editor]:h-full" />
    </div>
  );
}
