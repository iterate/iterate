"use client";

import { useEffect, useEffectEvent, useRef } from "react";
import { basicSetup } from "codemirror";
import { acceptCompletion, autocompletion, type Completion } from "@codemirror/autocomplete";
import { json } from "@codemirror/lang-json";
import { yaml } from "@codemirror/lang-yaml";
import { Prec } from "@codemirror/state";
import { EditorView, keymap, placeholder as placeholderExt } from "@codemirror/view";
import { vsCodeLight } from "@fsegurai/codemirror-theme-bundle";
import { cn } from "cn";

/** What `complete` offers at the caret: CodeMirror filters and ranks `options` by what is typed
 *  from `from` on, and keeps the list while the typed text matches `validFor`. */
export type CodeEditorCompletions = {
  from: number;
  validFor?: RegExp;
  options: Pick<Completion, "label" | "displayLabel" | "detail" | "section" | "apply" | "boost">[];
};

export interface CodeEditorProps {
  value: string;
  onValueChange: (value: string) => void;
  /** Fired on ⌘/Ctrl + Enter so the surrounding form can submit. */
  onSubmit?: () => void;
  language?: "yaml" | "json";
  placeholder?: string;
  /** The editor's accessible name (its content is the textbox). */
  label?: string;
  className?: string;
  focusOnMount?: boolean;
  /** Completions as you type (and on Ctrl+Space): the whole text, the caret, whether it was asked
   *  for. Tab or Enter takes the one selected. Read at each keystroke, so it may close over fresh
   *  data; given or not is fixed for the editor's life. */
  complete?: (text: string, pos: number, explicit: boolean) => CodeEditorCompletions | null;
}

/**
 * The editable sibling of `CodeBlock`: a controlled CodeMirror
 * surface used as a composer input. The editor instance is created once and
 * kept alive — the callbacks reach it as Effect Events, so a parent re-render
 * never tears it down, and external `value` changes (e.g. loading an example)
 * are dispatched as edits rather than remounting the view, the caret at the end.
 * The old platform's composer niceties (apps/os `composer-textarea.client.tsx`):
 * completions styled with the page's tokens, Tab accepts one, 16px text on a
 * phone (iOS zooms into a smaller focused field), the page's selection colour.
 */
export function CodeEditor({
  value,
  onValueChange,
  onSubmit,
  language = "yaml",
  placeholder,
  label,
  className,
  focusOnMount = false,
  complete,
}: CodeEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Effect Events: the view below calls whatever the latest render passed, without being rebuilt
  const emitValueChange = useEffectEvent(onValueChange);
  const emitSubmit = useEffectEvent(() => onSubmit?.());
  const completeAt = useEffectEvent((text: string, pos: number, explicit: boolean) =>
    complete ? complete(text, pos, explicit) : null,
  );
  const completes = Boolean(complete);

  // Recreate only when the structural config (language, placeholder) changes —
  // not on every value/callback change, which would steal focus mid-edit.
  useEffect(() => {
    if (!containerRef.current) return;
    const view = new EditorView({
      doc: value,
      parent: containerRef.current,
      extensions: [
        // before basicSetup: at one precedence the earlier keymap wins, and the default keymap
        // binds Mod-Enter to insertBlankLine
        keymap.of([
          {
            key: "Mod-Enter",
            run: () => {
              emitSubmit();
              return true;
            },
          },
        ]),
        basicSetup,
        vsCodeLight,
        (language === "json" ? json : yaml)(),
        EditorView.lineWrapping,
        placeholder ? placeholderExt(placeholder) : [],
        label ? EditorView.contentAttributes.of({ "aria-label": label }) : [],
        completes
          ? [
              autocompletion({
                activateOnTyping: true,
                interactionDelay: 0,
                icons: false,
                maxRenderedOptions: 100,
                override: [
                  (context) =>
                    completeAt(context.state.doc.toString(), context.pos, context.explicit),
                ],
              }),
              // over the indent Tab binds when a completion is open, and only then
              Prec.high(keymap.of([{ key: "Tab", run: acceptCompletion }])),
            ]
          : [],
        EditorView.updateListener.of((update) => {
          if (update.docChanged) emitValueChange(update.state.doc.toString());
        }),
        // over vsCodeLight, whose active line and completion colours would otherwise win
        Prec.highest(
          EditorView.theme({
            "&": {
              backgroundColor: "transparent",
              fontSize: "inherit",
              maxHeight: "12rem",
              minHeight: "3.5rem",
            },
            "&.cm-focused": { outline: "none" },
            ".cm-scroller": {
              fontFamily: "var(--font-mono, monospace)",
              fontSize: "inherit",
              overflow: "auto",
            },
            ".cm-content": { padding: "2px 0", caretColor: "var(--foreground)" },
            ".cm-gutters": { display: "none" },
            ".cm-activeLine, .cm-activeLineGutter, .cm-selectionMatch": {
              backgroundColor: "transparent",
            },
            ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
              backgroundColor: "color-mix(in oklab, var(--primary) 20%, transparent) !important",
            },
            ".cm-tooltip.cm-tooltip-autocomplete": {
              backgroundColor: "var(--popover)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-md)",
              color: "var(--popover-foreground)",
              maxWidth: "min(42rem, calc(100vw - 1rem))",
              overflow: "hidden",
              zIndex: "50",
            },
            ".cm-tooltip-autocomplete > ul": {
              backgroundColor: "var(--popover)",
              fontFamily: "var(--font-mono, monospace)",
              maxHeight: "min(18rem, 50svh)",
            },
            ".cm-tooltip-autocomplete > ul > li": {
              backgroundColor: "transparent",
              padding: "3px 8px",
            },
            ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
              backgroundColor: "color-mix(in oklab, var(--primary) 10%, transparent)",
              color: "var(--foreground)",
            },
            ".cm-tooltip-autocomplete completion-section": {
              color: "var(--muted-foreground)",
              fontFamily: "var(--font-sans, sans-serif)",
              fontSize: "0.7rem",
              padding: "4px 8px 2px",
            },
            ".cm-tooltip-autocomplete .cm-completionDetail": {
              color: "var(--muted-foreground)",
              fontFamily: "var(--font-sans, sans-serif)",
              fontStyle: "normal",
              marginLeft: "1.5em",
            },
            ".cm-completionMatchedText": { textDecoration: "none", fontWeight: "600" },
          }),
        ),
      ],
    });
    viewRef.current = view;
    if (focusOnMount) view.focus();
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- created once per config; the value syncs via a separate effect, the callbacks are Effect Events
  }, [language, placeholder, label, focusOnMount, completes]);

  // Keep the document in sync when the value is driven from outside; the caret goes to the end.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
      selection: { anchor: value.length },
    });
  }, [value]);

  // 16px on a phone: iOS zooms the page into a focused field whose text is smaller
  return <div ref={containerRef} className={cn("text-base sm:text-xs", className)} />;
}
