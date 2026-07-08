"use client";

import { useEffect, useRef } from "react";
import { basicSetup, EditorView } from "codemirror";
import { MergeView } from "@codemirror/merge";
import { vsCodeLight } from "@fsegurai/codemirror-theme-bundle";
import { cn } from "@iterate-com/ui/lib/utils";
import {
  sourceCodeLanguageExtension,
  type SourceCodeLanguage,
} from "./source-code-block.client.tsx";

/**
 * A vscode-style side-by-side diff over CodeMirror's MergeView: `original`
 * (read-only, left) against `modified` (right). When `onModifiedChange` is
 * given the right side is editable — like vscode's diff editor — and chunk
 * revert arrows carry original hunks back into the modified document.
 */
export function CodeDiffBlock({
  original,
  modified,
  language = "text",
  onModifiedChange,
  className,
}: {
  original: string;
  modified: string;
  language?: SourceCodeLanguage;
  onModifiedChange?: (value: string) => void;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<MergeView | null>(null);
  const onModifiedChangeRef = useRef(onModifiedChange);
  onModifiedChangeRef.current = onModifiedChange;
  const editable = onModifiedChange !== undefined;

  // Created once per structural config (language, editability); doc updates
  // sync through dispatches below so re-renders never tear down the view.
  useEffect(() => {
    if (containerRef.current == null) return;
    const shared = [basicSetup, vsCodeLight, sourceCodeLanguageExtension(language)];
    const view = new MergeView({
      parent: containerRef.current,
      a: {
        doc: original,
        extensions: [...shared, EditorView.editable.of(false)],
      },
      b: {
        doc: modified,
        extensions: [
          ...shared,
          EditorView.editable.of(editable),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onModifiedChangeRef.current?.(update.state.doc.toString());
          }),
        ],
      },
      ...(editable ? { revertControls: "a-to-b" as const } : {}),
      collapseUnchanged: { margin: 3, minSize: 6 },
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- created once per config; docs sync via the effects below
  }, [language, editable]);

  useEffect(() => {
    const view = viewRef.current;
    if (view == null) return;
    const current = view.a.state.doc.toString();
    if (current === original) return;
    view.a.dispatch({ changes: { from: 0, to: current.length, insert: original } });
  }, [original]);

  useEffect(() => {
    const view = viewRef.current;
    if (view == null) return;
    const current = view.b.state.doc.toString();
    if (current === modified) return;
    view.b.dispatch({ changes: { from: 0, to: current.length, insert: modified } });
  }, [modified]);

  return <div ref={containerRef} className={cn("min-h-0 overflow-y-auto text-xs", className)} />;
}
