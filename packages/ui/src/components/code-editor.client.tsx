"use client";

import { useEffect, useEffectEvent, useRef } from "react";
import { basicSetup } from "codemirror";
import { json } from "@codemirror/lang-json";
import { yaml } from "@codemirror/lang-yaml";
import { EditorView, keymap, placeholder as placeholderExt } from "@codemirror/view";
import { vsCodeLight } from "@fsegurai/codemirror-theme-bundle";
import { cn } from "@iterate-com/ui/lib/utils";

export interface CodeEditorProps {
  value: string;
  onValueChange: (value: string) => void;
  /** Fired on ⌘/Ctrl + Enter so the surrounding form can submit. */
  onSubmit?: () => void;
  language?: "yaml" | "json";
  placeholder?: string;
  className?: string;
  focusOnMount?: boolean;
}

/**
 * The editable sibling of `SerializedObjectCodeBlock`: a controlled CodeMirror
 * surface used as a composer input. The editor instance is created once and
 * kept alive — the callbacks reach it as Effect Events, so a parent re-render
 * never tears it down, and external `value` changes (e.g. loading an example)
 * are dispatched as edits rather than remounting the view.
 */
export function CodeEditor({
  value,
  onValueChange,
  onSubmit,
  language = "yaml",
  placeholder,
  className,
  focusOnMount = false,
}: CodeEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Effect Events: the view below calls whatever the latest render passed, without being rebuilt
  const emitValueChange = useEffectEvent(onValueChange);
  const emitSubmit = useEffectEvent(() => onSubmit?.());

  // Recreate only when the structural config (language, placeholder) changes —
  // not on every value/callback change, which would steal focus mid-edit.
  useEffect(() => {
    if (containerRef.current == null) return;
    const view = new EditorView({
      doc: value,
      parent: containerRef.current,
      extensions: [
        basicSetup,
        vsCodeLight,
        (language === "json" ? json : yaml)(),
        EditorView.lineWrapping,
        placeholder == null ? [] : placeholderExt(placeholder),
        keymap.of([
          {
            key: "Mod-Enter",
            run: () => {
              emitSubmit();
              return true;
            },
          },
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) emitValueChange(update.state.doc.toString());
        }),
        EditorView.theme({
          "&": { backgroundColor: "transparent", maxHeight: "12rem" },
          "&.cm-focused": { outline: "none" },
          ".cm-scroller": { fontFamily: "var(--font-mono, monospace)", overflow: "auto" },
          ".cm-content": { padding: "2px 0" },
          ".cm-gutters": { display: "none" },
          ".cm-activeLine, .cm-activeLineGutter, .cm-selectionMatch": {
            backgroundColor: "transparent",
          },
        }),
      ],
    });
    viewRef.current = view;
    if (focusOnMount) view.focus();
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- created once per config; the value syncs via a separate effect, the callbacks are Effect Events
  }, [language, placeholder, focusOnMount]);

  // Keep the document in sync when the value is driven from outside.
  useEffect(() => {
    const view = viewRef.current;
    if (view == null) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  return <div ref={containerRef} className={cn("text-xs", className)} />;
}
