import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { cn } from "cn";
import { editorExtensions, loadCodeMirror } from "./codemirror.ts";
import type { RepoFileLanguage } from "./repo-file-kinds.ts";

/** One file in CodeMirror: line numbers, search, folding, the language's highlighting, and the
 *  editor itself loaded when this first mounts. With a `baseline` (the text it is compared to) it
 *  marks changed lines in the gutter, or with `diff` shows the inline diff, whose chunk controls
 *  stage a chunk through `onAcceptChunk`. The view is made again when `language`, `readOnly`, the
 *  baseline or the diff mode change, from the latest `value`; edits come through `onChange`.
 *  Callers key it by file. */
export function RepoCodeEditor({
  value,
  language,
  label,
  readOnly = false,
  baseline,
  diff = false,
  onAcceptChunk,
  onChange,
  className,
}: {
  value: string;
  language: RepoFileLanguage;
  /** The editor's accessible name: the file's path. */
  label: string;
  readOnly?: boolean;
  baseline?: string;
  diff?: boolean;
  onAcceptChunk?: (baseline: string) => void;
  onChange?: (value: string) => void;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const emitChange = useEffectEvent((next: string) => onChange?.(next));
  const emitAcceptChunk = useEffectEvent((next: string) => onAcceptChunk?.(next));
  const initialValue = useEffectEvent(() => value);
  const acceptsChunks = Boolean(onAcceptChunk);

  useEffect(() => {
    let cancelled = false;
    let view: EditorView | undefined;
    loadCodeMirror(language).then(
      (cm) => {
        if (cancelled || !containerRef.current) return;
        view = new cm.view.EditorView({
          doc: initialValue(),
          parent: containerRef.current,
          extensions: editorExtensions(cm, {
            language,
            readOnly,
            label,
            baseline,
            diff,
            onAcceptChunk: acceptsChunks ? emitAcceptChunk : undefined,
            onChange: emitChange,
          }),
        });
        viewRef.current = view;
      },
      (error: unknown) => {
        if (!cancelled) setFailure(error instanceof Error ? error.message : String(error));
      },
    );
    return () => {
      cancelled = true;
      view?.destroy();
      viewRef.current = null;
    };
  }, [language, readOnly, label, baseline, diff, acceptsChunks]);

  // A value that changed from outside (a discard, a restore) is dispatched as an edit
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  if (failure) {
    return (
      <div role="alert" data-type="error" className="p-4 text-sm text-destructive">
        {failure}
      </div>
    );
  }
  return <div ref={containerRef} className={cn("min-h-0 overflow-hidden", className)} />;
}
