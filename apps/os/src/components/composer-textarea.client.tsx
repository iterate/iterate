"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { skipToken, useQuery } from "@tanstack/react-query";
import {
  agentRichContentFromEditorDocument,
  agentRichContentToEditorDocument,
  type AgentRichContentReferenceRange,
  type AgentRichContentV1,
} from "@iterate-com/shared/agent-rich-content";
import { EditorState, Prec, StateEffect, StateField, type Transaction } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  keymap,
  placeholder as placeholderExtension,
  type DecorationSet,
} from "@codemirror/view";
import { Button } from "@iterate-com/ui/components/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@iterate-com/ui/components/command";
import { Popover, PopoverContent, PopoverTrigger } from "@iterate-com/ui/components/popover";
import { Spinner } from "@iterate-com/ui/components/spinner";
import { isItxTransportError } from "iterate/sdk/itx/react";
import {
  activeComposerSuggestion,
  applyComposerSuggestion,
  type ActiveComposerSuggestion,
  type ComposerSuggestion,
  type ComposerSuggestionProvider,
} from "~/components/composer-suggestions.ts";

export type ComposerTextareaProps = {
  value: AgentRichContentV1;
  onValueChange: (value: AgentRichContentV1) => void;
  onSubmit: () => void;
  placeholder: string;
  providers?: readonly ComposerSuggestionProvider[];
  focusOnMount?: boolean;
};

type ReferenceFieldValue = {
  decorations: DecorationSet;
  references: AgentRichContentReferenceRange[];
};

const setReferences = StateEffect.define<AgentRichContentReferenceRange[]>();
const addReference = StateEffect.define<AgentRichContentReferenceRange>();

function referenceDecorations(
  references: readonly AgentRichContentReferenceRange[],
): DecorationSet {
  return Decoration.set(
    references.map((reference) =>
      Decoration.mark({
        class: "cm-agent-reference",
        attributes: {
          "aria-label": `File reference ${reference.target.path}`,
          "data-reference-kind": reference.target.kind,
          title: reference.target.path,
        },
      }).range(reference.from, reference.to),
    ),
    true,
  );
}

function mapReferences(
  references: readonly AgentRichContentReferenceRange[],
  transaction: Transaction,
): AgentRichContentReferenceRange[] {
  if (!transaction.docChanged) return [...references];
  const text = transaction.newDoc.toString();
  return references.flatMap((reference): AgentRichContentReferenceRange[] => {
    // Opposite associations keep typing at either pill boundary outside it.
    const from = transaction.changes.mapPos(reference.from, 1);
    const to = transaction.changes.mapPos(reference.to, -1);
    if (to <= from || text.slice(from, to) !== reference.display) return [];
    return [{ ...reference, from, to }];
  });
}

const referenceField = StateField.define<ReferenceFieldValue>({
  create: () => ({ decorations: Decoration.none, references: [] }),
  update(value, transaction) {
    let references = mapReferences(value.references, transaction);
    for (const effect of transaction.effects) {
      if (effect.is(setReferences)) references = effect.value;
      if (effect.is(addReference)) references = [...references, effect.value];
    }
    return { decorations: referenceDecorations(references), references };
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.decorations),
    EditorView.atomicRanges.of((view) => view.state.field(field).decorations),
  ],
});

function sameReferences(
  left: readonly AgentRichContentReferenceRange[],
  right: readonly AgentRichContentReferenceRange[],
): boolean {
  return (
    left.length === right.length &&
    left.every((reference, index) => {
      const candidate = right[index];
      return (
        candidate !== undefined &&
        reference.from === candidate.from &&
        reference.to === candidate.to &&
        reference.occurrenceId === candidate.occurrenceId &&
        reference.display === candidate.display &&
        reference.target.kind === candidate.target.kind &&
        reference.target.repoPath === candidate.target.repoPath &&
        reference.target.path === candidate.target.path
      );
    })
  );
}

function suggestionMenuContent({
  active,
  isPending,
  error,
  suggestions,
  onChoose,
  onRetry,
}: {
  active: ActiveComposerSuggestion;
  isPending: boolean;
  error: Error | null;
  suggestions: readonly ComposerSuggestion[];
  onChoose: (suggestion: ComposerSuggestion) => void;
  onRetry: () => void;
}) {
  const label = active.provider.label.toLocaleLowerCase();
  if (isPending) {
    return (
      <CommandEmpty className="flex items-center justify-center gap-2" role="status">
        <Spinner />
        Loading {label}…
      </CommandEmpty>
    );
  }
  if (error !== null) {
    return (
      <CommandEmpty className="flex flex-col items-center gap-2 px-4" role="alert">
        <span>
          Couldn’t load {label}: {error.message}
        </span>
        <Button
          variant="outline"
          size="sm"
          onPointerDown={(event) => event.preventDefault()}
          onClick={onRetry}
        >
          Try again
        </Button>
      </CommandEmpty>
    );
  }
  if (suggestions.length === 0) return <CommandEmpty>No matching {label}.</CommandEmpty>;
  return (
    <CommandGroup heading={active.provider.label}>
      {suggestions.map((suggestion) => (
        <CommandItem
          key={suggestion.id}
          value={suggestion.id}
          onPointerDown={(event) => event.preventDefault()}
          onSelect={() => onChoose(suggestion)}
        >
          {suggestion.icon}
          <span className="min-w-0 flex-1 truncate font-mono text-xs">{suggestion.label}</span>
          {suggestion.description === undefined ? null : (
            <span className="max-w-1/2 truncate text-xs text-muted-foreground">
              {suggestion.description}
            </span>
          )}
        </CommandItem>
      ))}
    </CommandGroup>
  );
}

export function ComposerTextareaClient({
  value,
  onValueChange,
  onSubmit,
  placeholder,
  providers = [],
  focusOnMount = false,
}: ComposerTextareaProps) {
  const listId = useId();
  const triggerId = useId();
  const [initial] = useState(() => agentRichContentToEditorDocument(value));
  const [initialFocusOnMount] = useState(focusOnMount);
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const syncingExternalValueRef = useRef(false);
  const onValueChangeRef = useRef(onValueChange);
  const onSubmitRef = useRef(onSubmit);
  const keyboardStateRef = useRef<{
    activeToken: string | null;
    choose: (suggestion: ComposerSuggestion) => void;
    open: boolean;
    selectedIndex: number;
    suggestions: readonly ComposerSuggestion[];
  }>({ activeToken: null, choose: () => {}, open: false, selectedIndex: 0, suggestions: [] });
  const [editorText, setEditorText] = useState(initial.text);
  const [caret, setCaret] = useState(initial.text.length);
  const [focused, setFocused] = useState(false);
  const [dismissedToken, setDismissedToken] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState("");

  const active = activeComposerSuggestion(editorText, caret, providers);
  const activeToken =
    active === null ? null : `${active.provider.id}:${active.from}:${active.query}`;
  const search = useQuery({
    queryKey: [
      "composer-suggestions",
      active?.provider.id,
      ...(active?.provider.cacheKey ?? []),
      active?.query,
    ],
    queryFn: active === null ? skipToken : () => active.provider.search(active.query),
    staleTime: 30_000,
    retry: (failureCount, queryError) => isItxTransportError(queryError) && failureCount < 3,
  });
  const suggestions = search.data ?? [];
  const availableSelectedId = suggestions.some((suggestion) => suggestion.id === selectedId)
    ? selectedId
    : (suggestions[0]?.id ?? "");
  const availableSelectedIndex = suggestions.findIndex(
    (suggestion) => suggestion.id === availableSelectedId,
  );
  const open = focused && active !== null && activeToken !== dismissedToken;

  function choose(suggestion: ComposerSuggestion) {
    const view = viewRef.current;
    if (active === null || view === null) return;
    const completion = applyComposerSuggestion(editorText, active, suggestion);
    const effects = completion.reference
      ? [
          addReference.of({
            type: "reference",
            occurrenceId: globalThis.crypto.randomUUID(),
            ...completion.reference,
          }),
        ]
      : [];
    view.dispatch({
      changes: {
        from: active.from,
        to: active.to,
        insert: completion.value.slice(
          active.from,
          completion.value.length - (editorText.length - active.to),
        ),
      },
      selection: { anchor: completion.caret },
      effects,
    });
    setDismissedToken(null);
    view.focus();
  }

  useLayoutEffect(() => {
    onValueChangeRef.current = onValueChange;
    onSubmitRef.current = onSubmit;
    keyboardStateRef.current = {
      activeToken,
      choose,
      open,
      selectedIndex: Math.max(0, availableSelectedIndex),
      suggestions,
    };
  });

  useEffect(() => {
    if (containerRef.current == null) return;
    const view = new EditorView({
      parent: containerRef.current,
      state: EditorState.create({
        doc: initial.text,
        selection: { anchor: initial.text.length },
        extensions: [
          referenceField,
          placeholderExtension(placeholder),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({
            "aria-autocomplete": "list",
            "aria-controls": listId,
            "aria-label": placeholder,
            "aria-placeholder": placeholder,
            placeholder,
            role: "combobox",
          }),
          EditorView.domEventHandlers({
            focus: () => setFocused(true),
            blur: () => setFocused(false),
          }),
          Prec.highest(
            keymap.of([
              {
                key: "Backspace",
                run: (editor) => deleteReferenceAtCursor(editor, -1),
              },
              {
                key: "Delete",
                run: (editor) => deleteReferenceAtCursor(editor, 1),
              },
              {
                key: "ArrowDown",
                run: () => moveSuggestionSelection(1, keyboardStateRef.current, setSelectedId),
              },
              {
                key: "ArrowUp",
                run: () => moveSuggestionSelection(-1, keyboardStateRef.current, setSelectedId),
              },
              {
                key: "Enter",
                run: (editor) => {
                  if (editor.composing) return false;
                  const current = keyboardStateRef.current;
                  const suggestion = current.suggestions[current.selectedIndex];
                  if (current.open && suggestion !== undefined) {
                    current.choose(suggestion);
                    return true;
                  }
                  onSubmitRef.current();
                  return true;
                },
              },
              {
                key: "Tab",
                run: () => {
                  const current = keyboardStateRef.current;
                  const suggestion = current.suggestions[current.selectedIndex];
                  if (!current.open || suggestion === undefined) return false;
                  current.choose(suggestion);
                  return true;
                },
              },
              {
                key: "Escape",
                run: () => {
                  const current = keyboardStateRef.current;
                  if (!current.open) return false;
                  setDismissedToken(current.activeToken);
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
            if (update.selectionSet || update.docChanged) {
              setCaret(update.state.selection.main.head);
              setDismissedToken(null);
            }
            if (!update.docChanged) return;
            const text = update.state.doc.toString();
            setEditorText(text);
            if (syncingExternalValueRef.current) return;
            const references = update.state.field(referenceField).references;
            onValueChangeRef.current(agentRichContentFromEditorDocument(text, references));
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
          }),
        ],
      }),
    });
    view.dispatch({ effects: setReferences.of(initial.references) });
    viewRef.current = view;
    if (initialFocusOnMount) view.focus();
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // The editor is long-lived; controlled values synchronize below.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `initial` and mount focus are deliberately captured once.
  }, [listId, placeholder]);

  useEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    const next = agentRichContentToEditorDocument(value);
    const currentText = view.state.doc.toString();
    const currentReferences = view.state.field(referenceField).references;
    if (currentText === next.text && sameReferences(currentReferences, next.references)) return;
    syncingExternalValueRef.current = true;
    view.dispatch({
      changes: { from: 0, to: currentText.length, insert: next.text },
      selection: { anchor: next.text.length },
      effects: setReferences.of(next.references),
    });
    syncingExternalValueRef.current = false;
    setEditorText(next.text);
  }, [value]);

  useEffect(() => {
    const content = viewRef.current?.contentDOM;
    if (content === undefined) return;
    content.setAttribute("aria-expanded", String(open));
  }, [open]);

  return (
    <Popover
      open={open}
      triggerId={triggerId}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) setDismissedToken(activeToken);
      }}
    >
      <PopoverTrigger
        id={triggerId}
        nativeButton={false}
        render={<div ref={containerRef} className="min-w-0 flex-1" />}
      />
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        initialFocus={false}
        finalFocus={false}
        className="w-(--anchor-width) max-w-(--available-width) gap-0 p-0"
      >
        {active === null ? null : (
          <Command shouldFilter={false} value={availableSelectedId} onValueChange={setSelectedId}>
            <CommandList id={listId} className="max-h-[min(18rem,50svh)]">
              {suggestionMenuContent({
                active,
                isPending: search.isPending,
                error: search.error,
                suggestions,
                onChoose: choose,
                onRetry: () => void search.refetch(),
              })}
            </CommandList>
          </Command>
        )}
      </PopoverContent>
    </Popover>
  );
}

function moveSuggestionSelection(
  direction: -1 | 1,
  current: {
    open: boolean;
    selectedIndex: number;
    suggestions: readonly ComposerSuggestion[];
  },
  setSelectedId: (id: string) => void,
): boolean {
  if (!current.open || current.suggestions.length === 0) return false;
  const nextIndex =
    (current.selectedIndex + direction + current.suggestions.length) % current.suggestions.length;
  const next = current.suggestions[nextIndex];
  if (next !== undefined) setSelectedId(next.id);
  return true;
}

function deleteReferenceAtCursor(editor: EditorView, direction: -1 | 1): boolean {
  const selection = editor.state.selection.main;
  if (!selection.empty) return false;
  const reference = editor.state
    .field(referenceField)
    .references.find((candidate) =>
      direction < 0 ? candidate.to === selection.head : candidate.from === selection.head,
    );
  if (reference === undefined) return false;
  editor.dispatch({
    changes: { from: reference.from, to: reference.to },
    selection: { anchor: reference.from },
  });
  return true;
}
