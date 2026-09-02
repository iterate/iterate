import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { RangeSetBuilder, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  type DecorationSet,
} from "@codemirror/view";

/**
 * References: the things a document can point at — agents, notes, tasks,
 * people — written as PLAIN TEXT with a recognisable shape (`@/agents/x`,
 * `[[notes/ideas]]`) and drawn as pills over that text. The file's bytes are
 * never touched by the pill: a decoration is how peer carets are drawn too,
 * and it keeps every note hand-editable and agent-readable with any tool.
 * The host names the kinds it knows (one registry per app), answers
 * completion queries for `@` and `[[`, and handles a pill being opened.
 */
export type ReferenceTrigger = "@" | "[[";

/** One kind of thing a reference can point at. */
export type ReferenceKind = {
  /** Stable id, also the pill's CSS modifier (`cm-reference-<kind>`). */
  kind: string;
  /** The characters that open completion for this kind. */
  trigger: ReferenceTrigger;
  /** Matches ONE reference in text; capture group 1 is the target. Must be
   * global and without the sticky flag (it is run with lastIndex reset). */
  pattern: RegExp;
  /** What the pill says on hover. */
  label: (target: string) => string;
};

/** One reference found in the text. */
export type Reference = {
  kind: string;
  target: string;
  /** Character offsets of the whole reference text (syntax included). */
  from: number;
  to: number;
  text: string;
};

/** One completion candidate: what the list shows and what lands in the text. */
export type ReferenceCandidate = {
  kind: string;
  label: string;
  detail?: string;
  /** The exact text to insert in place of the trigger + query. */
  insert: string;
};

/** What a host provides to light references up in an editor. Must be
 * referentially stable for the editor's lifetime — the editor rebuilds
 * its extensions when it changes. */
export type ReferenceHost = {
  kinds: readonly ReferenceKind[];
  /** Candidates for the text typed after a trigger. The host filters. */
  complete(trigger: ReferenceTrigger, query: string): Promise<ReferenceCandidate[]>;
  /** A pill was clicked. */
  open(reference: Reference): void;
};

/** Every reference in `text`, in document order, non-overlapping (earliest
 * match wins; a later kind never claims text an earlier one took). */
export function parseReferences(text: string, kinds: readonly ReferenceKind[]): Reference[] {
  const found: Reference[] = [];
  for (const kind of kinds) {
    const pattern = new RegExp(
      kind.pattern.source,
      kind.pattern.flags.includes("g") ? kind.pattern.flags : `${kind.pattern.flags}g`,
    );
    for (const match of text.matchAll(pattern)) {
      const target = match[1];
      if (target === undefined || match.index === undefined) continue;
      found.push({
        from: match.index,
        kind: kind.kind,
        target,
        text: match[0],
        to: match.index + match[0].length,
      });
    }
  }
  found.sort((left, right) => left.from - right.from || right.to - left.to);
  const kept: Reference[] = [];
  let cursor = 0;
  for (const reference of found) {
    if (reference.from < cursor) continue;
    kept.push(reference);
    cursor = reference.to;
  }
  return kept;
}

/**
 * The trigger + query the caret sits after, or null. `@` queries run to the
 * next whitespace; `[[` queries run to the closing brackets.
 */
export function referenceQueryBefore(
  textBeforeCaret: string,
): { trigger: ReferenceTrigger; query: string; from: number } | null {
  const wiki = /\[\[([^\]\n]*)$/.exec(textBeforeCaret);
  if (wiki !== null) return { from: wiki.index, query: wiki[1] ?? "", trigger: "[[" };
  const at = /(?:^|[\s(])@([^\s@]*)$/.exec(textBeforeCaret);
  if (at !== null) {
    const from = at.index + at[0].length - (at[1]?.length ?? 0) - 1;
    return { from, query: at[1] ?? "", trigger: "@" };
  }
  return null;
}

/** Pills, completion, and click-to-open for one host's reference kinds. */
export function referencesExtension(host: ReferenceHost): Extension {
  const decorate = (view: EditorView): DecorationSet => {
    const builder = new RangeSetBuilder<Decoration>();
    const doc = view.state.doc;
    for (const { from, to } of view.visibleRanges) {
      // Widen to whole lines so a reference straddling the viewport edge is
      // still found in one piece.
      const start = doc.lineAt(from).from;
      const end = doc.lineAt(to).to;
      const text = doc.sliceString(start, end);
      for (const reference of parseReferences(text, host.kinds)) {
        const kind = host.kinds.find((candidate) => candidate.kind === reference.kind);
        builder.add(
          start + reference.from,
          start + reference.to,
          Decoration.mark({
            attributes: {
              "data-reference-kind": reference.kind,
              "data-reference-target": reference.target,
              title: `${kind?.label(reference.target) ?? reference.target} — click to open`,
            },
            class: `cm-reference cm-reference-${reference.kind}`,
          }),
        );
      }
    }
    return builder.finish();
  };

  const pills = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = decorate(view);
      }
      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged) this.decorations = decorate(update.view);
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );

  const openOnClick = EditorView.domEventHandlers({
    mousedown(event) {
      if (event.button !== 0) return false;
      const pill = event.target instanceof Element ? event.target.closest(".cm-reference") : null;
      if (!(pill instanceof HTMLElement)) return false;
      const kind = pill.dataset.referenceKind;
      const target = pill.dataset.referenceTarget;
      if (kind === undefined || target === undefined) return false;
      event.preventDefault();
      host.open({ from: 0, kind, target, text: pill.textContent ?? "", to: 0 });
      return true;
    },
  });

  const complete = async (context: CompletionContext): Promise<CompletionResult | null> => {
    const line = context.state.doc.lineAt(context.pos);
    const before = context.state.doc.sliceString(line.from, context.pos);
    const query = referenceQueryBefore(before);
    if (query === null) return null;
    if (query.query === "" && !context.explicit && query.trigger === "@") {
      // A bare "@" mid-sentence is common English; wait for a letter (or an
      // explicit request) before offering agents.
      return null;
    }
    const candidates = await host.complete(query.trigger, query.query);
    if (candidates.length === 0) return null;
    return {
      filter: false,
      from: line.from + query.from,
      options: candidates.map(
        (candidate): Completion => ({
          apply: candidate.insert,
          detail: candidate.detail,
          label: candidate.label,
          type: candidate.kind,
        }),
      ),
    };
  };

  const theme = EditorView.baseTheme({
    ".cm-reference": {
      background: "color-mix(in oklab, var(--primary) 10%, transparent)",
      border: "1px solid color-mix(in oklab, var(--primary) 25%, transparent)",
      borderRadius: "999px",
      cursor: "pointer",
      padding: "0 0.4em",
    },
    ".cm-reference:hover": {
      background: "color-mix(in oklab, var(--primary) 18%, transparent)",
    },
    ".cm-tooltip-autocomplete": {
      fontFamily: "var(--font-sans, system-ui)",
      fontSize: "13px",
    },
  });

  return [pills, openOnClick, theme, autocompletion({ icons: false, override: [complete] })];
}
