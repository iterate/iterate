"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { acceptCompletion, autocompletion } from "@codemirror/autocomplete";
import { EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap, placeholder as placeholderExtension } from "@codemirror/view";
import {
  agentRichContentFromEditorDocument,
  agentRichContentToEditorDocument,
  type AgentRichContentV1,
} from "@iterate-com/shared/agent-rich-content";
import { useQueryClient } from "@tanstack/react-query";
import { composerCompletionSource } from "~/components/composer-completions.ts";
import {
  composerReferenceExtension,
  composerReferences,
  deleteComposerReferenceAtCursor,
  sameComposerReferences,
  setComposerReferences,
} from "~/components/composer-references.ts";
import type { ComposerSuggestionProvider } from "~/components/composer-suggestions.ts";

export type ComposerTextareaProps = {
  value: AgentRichContentV1;
  onValueChange: (value: AgentRichContentV1) => void;
  onSubmit: () => void;
  placeholder: string;
  providers?: readonly ComposerSuggestionProvider[];
  focusOnMount?: boolean;
};

export function ComposerTextareaClient({
  value,
  onValueChange,
  onSubmit,
  placeholder,
  providers = [],
  focusOnMount = false,
}: ComposerTextareaProps) {
  const queryClient = useQueryClient();
  const [initial] = useState(() => agentRichContentToEditorDocument(value));
  const [initialFocusOnMount] = useState(focusOnMount);
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const providersRef = useRef(providers);
  const syncingExternalValueRef = useRef(false);
  const onValueChangeRef = useRef(onValueChange);
  const onSubmitRef = useRef(onSubmit);

  useLayoutEffect(() => {
    providersRef.current = providers;
    onValueChangeRef.current = onValueChange;
    onSubmitRef.current = onSubmit;
  });

  useEffect(() => {
    if (containerRef.current === null) return;
    const completionSource = composerCompletionSource({
      getProviders: () => providersRef.current,
      queryClient,
    });
    const view = new EditorView({
      parent: containerRef.current,
      state: EditorState.create({
        doc: initial.text,
        selection: { anchor: initial.text.length },
        extensions: [
          composerReferenceExtension,
          placeholderExtension(placeholder),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({
            "aria-label": placeholder,
            "aria-placeholder": placeholder,
            placeholder,
            role: "combobox",
          }),
          autocompletion({
            activateOnTyping: true,
            activateOnTypingDelay: 0,
            aboveCursor: true,
            interactionDelay: 0,
            maxRenderedOptions: 100,
            override: [completionSource],
          }),
          Prec.high(
            keymap.of([
              { key: "Tab", run: acceptCompletion },
              {
                key: "Backspace",
                run: (editor) => deleteComposerReferenceAtCursor(editor, -1),
              },
              {
                key: "Delete",
                run: (editor) => deleteComposerReferenceAtCursor(editor, 1),
              },
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
            const text = update.state.doc.toString();
            onValueChangeRef.current(
              agentRichContentFromEditorDocument(text, composerReferences(update.state)),
            );
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
            ".cm-agent-reference": {
              backgroundColor: "color-mix(in oklab, var(--primary) 12%, transparent)",
              border: "1px solid color-mix(in oklab, var(--primary) 25%, transparent)",
              borderRadius: "9999px",
              color: "var(--foreground)",
              fontFamily: "var(--font-mono, monospace)",
              fontSize: "0.75rem",
              padding: "2px 6px",
            },
            ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
              backgroundColor: "color-mix(in oklab, var(--primary) 20%, transparent) !important",
            },
            ".cm-cursor": { borderLeftColor: "var(--foreground)" },
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
              fontFamily: "inherit",
              maxHeight: "min(18rem, 50svh)",
            },
            ".cm-tooltip-autocomplete > ul > li": { padding: "6px 8px" },
            ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
              backgroundColor: "var(--accent)",
              color: "var(--accent-foreground)",
            },
            ".cm-completionLabel": {
              fontFamily: "var(--font-mono, monospace)",
              fontSize: "0.75rem",
            },
            ".cm-completionDetail": { color: "var(--muted-foreground)", fontStyle: "normal" },
            ".cm-completionIcon-file:after": { content: "'@'" },
          }),
        ],
      }),
    });
    view.dispatch({ effects: setComposerReferences.of(initial.references) });
    viewRef.current = view;
    if (initialFocusOnMount) view.focus();
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // The editor is long-lived; controlled values synchronize below.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initial content and mount focus are captured once.
  }, [placeholder, queryClient]);

  useEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    const next = agentRichContentToEditorDocument(value);
    const currentText = view.state.doc.toString();
    if (
      currentText === next.text &&
      sameComposerReferences(composerReferences(view.state), next.references)
    ) {
      return;
    }
    syncingExternalValueRef.current = true;
    view.dispatch({
      changes: { from: 0, to: currentText.length, insert: next.text },
      selection: { anchor: next.text.length },
      effects: setComposerReferences.of(next.references),
    });
    syncingExternalValueRef.current = false;
  }, [value]);

  return <div ref={containerRef} className="min-w-0 flex-1" />;
}
