"use client";
// apps/os's composer textarea without its mention layer: a CodeMirror editor that grows with the
// draft — Enter submits (never mid-IME-composition), Shift+Enter is a new line, ⌘/Ctrl+Enter
// submits too; 16px type so iOS does not zoom on focus.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap, placeholder as placeholderExtension } from "@codemirror/view";

export type ComposerTextareaProps = {
  value: string;
  onValueChange: (value: string) => void;
  onSubmit: () => void;
  placeholder: string;
  focusOnMount?: boolean;
};

export function ComposerTextareaClient({
  value,
  onValueChange,
  onSubmit,
  placeholder,
  focusOnMount = false,
}: ComposerTextareaProps) {
  const [initial] = useState(value);
  const [initialFocusOnMount] = useState(focusOnMount);
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const syncingExternalValueRef = useRef(false);
  const onValueChangeRef = useRef(onValueChange);
  const onSubmitRef = useRef(onSubmit);

  useLayoutEffect(() => {
    onValueChangeRef.current = onValueChange;
    onSubmitRef.current = onSubmit;
  });

  useEffect(() => {
    if (!containerRef.current) return;
    const view = new EditorView({
      parent: containerRef.current,
      state: EditorState.create({
        doc: initial,
        selection: { anchor: initial.length },
        extensions: [
          placeholderExtension(placeholder),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({
            "aria-label": placeholder,
            "aria-placeholder": placeholder,
            placeholder,
          }),
          Prec.high(
            keymap.of([
              {
                key: "Enter",
                run: (editor) => {
                  if (editor.composing) return false;
                  onSubmitRef.current();
                  return true;
                },
              },
              {
                key: "Mod-Enter",
                run: () => {
                  onSubmitRef.current();
                  return true;
                },
              },
            ]),
          ),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged || syncingExternalValueRef.current) return;
            onValueChangeRef.current(update.state.doc.toString());
          }),
          EditorView.theme({
            "&": {
              backgroundColor: "transparent",
              fontSize: "16px",
              maxHeight: "8rem",
              minHeight: "2.5rem",
            },
            "&.cm-focused": { outline: "none" },
            ".cm-scroller": { fontFamily: "inherit", overflow: "auto" },
            ".cm-content": { caretColor: "var(--foreground)", padding: "8px" },
            ".cm-line": { lineHeight: "1.375" },
            ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
              backgroundColor: "color-mix(in oklab, var(--primary) 20%, transparent) !important",
            },
            ".cm-cursor": { borderLeftColor: "var(--foreground)" },
          }),
        ],
      }),
    });
    viewRef.current = view;
    if (initialFocusOnMount) view.focus();
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // The editor is long-lived; controlled values synchronize below.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initial content and mount focus are captured once.
  }, [placeholder]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const currentText = view.state.doc.toString();
    if (currentText === value) return;
    syncingExternalValueRef.current = true;
    view.dispatch({
      changes: { from: 0, to: currentText.length, insert: value },
      selection: { anchor: value.length },
    });
    syncingExternalValueRef.current = false;
  }, [value]);

  return <div ref={containerRef} className="min-w-0 flex-1" />;
}
