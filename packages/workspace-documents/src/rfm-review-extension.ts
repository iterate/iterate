import {
  EditorState,
  Facet,
  StateEffect,
  StateField,
  type SelectionRange,
  type Range,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  keymap,
  showTooltip,
  WidgetType,
  type TooltipView,
} from "@codemirror/view";
import type { ReviewSuggestion } from "iterate/document-review";
import type { EditorReviewConfig } from "./collab-editor-api.ts";
import { authorColor } from "./collab-author.ts";
import { rfmControlRanges, rfmInputFilter } from "./rfm-controls.ts";
import { reviewForDocument } from "./rfm-document.ts";

/** A CodeMirror-positioned container whose draft is owned by the host's React composer. */
export interface ReviewComposerMount {
  element: HTMLElement;
  submit(body: string): boolean;
  cancel(): void;
}

/** Host callbacks plus the single portal mount required by the review tooltip. */
export interface RfmReviewConfig extends EditorReviewConfig {
  mountComposer(mount: ReviewComposerMount | null): void;
}

const config = Facet.define<RfmReviewConfig, RfmReviewConfig | undefined>({
  combine: (values) => values[0],
});

/** A passage held in source coordinates while focus moves into a comment draft. */
interface PendingPassage {
  range: SelectionRange | null;
  composing: boolean;
}

export const setPendingReviewPassage = StateEffect.define<PendingPassage>();

function selectedPassage(state: EditorState): SelectionRange | null {
  const range = state.selection.main;
  if (range.empty || !state.facet(config)?.onComment || state.facet(EditorState.readOnly))
    return null;
  const review = reviewForDocument(state.doc);
  if (review.diagnostics.some((d) => d.severity === "error")) return null;
  if (
    review.threads.some(
      (thread) =>
        thread.anchor &&
        thread.anchor.source.start + review.body.range.start < range.to &&
        thread.anchor.source.end + review.body.range.start > range.from,
    )
  )
    return null;
  if (
    rfmControlRanges(review, state.doc.length).some(
      (control) => control.from < range.to && control.to > range.from,
    )
  )
    return null;
  return range;
}

export const pendingReviewPassage = StateField.define<PendingPassage>({
  create: (state) => ({ range: selectedPassage(state), composing: false }),
  update(value, transaction) {
    let next = value;
    if (transaction.docChanged && value.range)
      next = { ...value, range: value.range.map(transaction.changes) };
    for (const effect of transaction.effects)
      if (effect.is(setPendingReviewPassage)) return effect.value;
    if (
      !value.composing &&
      (transaction.selection || transaction.docChanged || transaction.reconfigured)
    ) {
      return { range: selectedPassage(transaction.state), composing: false };
    }
    return next;
  },
  provide: (field) =>
    showTooltip.from(field, (value) =>
      value.range
        ? {
            pos: value.range.to,
            above: true,
            arrow: true,
            create: createReviewTooltip,
          }
        : null,
    ),
});

function createReviewTooltip(view: EditorView): TooltipView {
  const dom = document.createElement("div");
  let composing: boolean | null = null;
  let unmount: (() => void) | null = null;
  const cancel = () => {
    view.dispatch({ effects: setPendingReviewPassage.of({ range: null, composing: false }) });
    view.focus();
  };
  const update = () => {
    const pending = view.state.field(pendingReviewPassage);
    if (pending.composing === composing) return;
    composing = pending.composing;
    unmount?.();
    unmount = null;
    dom.replaceChildren();
    dom.className = composing ? "cm-review-composer" : "cm-review-comment-action";
    if (composing) {
      const element = document.createElement("div");
      dom.appendChild(element);
      const mount = view.state.facet(config)?.mountComposer;
      mount?.({
        element,
        submit(body) {
          const range = view.state.field(pendingReviewPassage).range;
          if (!range || range.empty)
            throw new Error(
              "The selected passage was deleted. Copy your draft and select another passage.",
            );
          const accepted =
            view.state.facet(config)?.onComment?.({ from: range.from, to: range.to }, body) ??
            false;
          if (accepted) cancel();
          return accepted;
        },
        cancel,
      });
      unmount = () => mount?.(null);
    } else {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Comment";
      button.setAttribute("aria-label", "Comment on selected text");
      button.title = "Comment on selected text (Mod+Alt+M)";
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () =>
        view.dispatch({
          effects: setPendingReviewPassage.of({
            ...view.state.field(pendingReviewPassage),
            composing: true,
          }),
        }),
      );
      dom.appendChild(button);
    }
  };
  update();
  return { dom, update, destroy: () => unmount?.() };
}

class SuggestionWidget extends WidgetType {
  constructor(readonly suggestion: ReviewSuggestion) {
    super();
  }
  override eq(other: SuggestionWidget) {
    return JSON.stringify(this.suggestion) === JSON.stringify(other.suggestion);
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-review-suggestion";
    span.dataset.reviewThread = this.suggestion.id;
    for (const [tag, text] of [
      ["del", this.suggestion.originalText],
      ["ins", this.suggestion.replacementText],
    ]) {
      if (!text) continue;
      const part = document.createElement(tag);
      part.textContent = text;
      span.appendChild(part);
    }
    span.title = "Select to review this suggestion";
    return span;
  }
  override ignoreEvent() {
    return false;
  }
}

function reviewDecorations(state: EditorState) {
  const review = reviewForDocument(state.doc);
  if (review.diagnostics.some((d) => d.severity === "error")) return Decoration.none;
  const ranges: Range<Decoration>[] = [];
  for (const control of rfmControlRanges(review, state.doc.length)) {
    const suggestion =
      control.kind === "atomic"
        ? review.suggestions.find((s) => s.source.start + review.body.range.start === control.from)
        : undefined;
    ranges.push(
      Decoration.replace({
        block: control.kind === "frontmatter" || control.kind === "endmatter",
        widget: suggestion ? new SuggestionWidget(suggestion) : undefined,
      }).range(control.from, control.to),
    );
  }
  for (const thread of review.threads) {
    if (!thread.anchor || thread.anchor.source.start === thread.anchor.source.end) continue;
    ranges.push(
      Decoration.mark({
        class:
          "cm-review-anchor" +
          (state.facet(config)?.selectedThreadId === thread.id ? " cm-review-anchor-selected" : ""),
        attributes: {
          "data-review-thread": thread.id,
          style: `--review-color: ${authorColor(thread.comments[0]?.author ?? "someone", 1)}`,
        },
      }).range(
        thread.anchor.source.start + review.body.range.start,
        thread.anchor.source.end + review.body.range.start,
      ),
    );
  }
  const pending = state.field(pendingReviewPassage);
  if (pending.composing && pending.range && !pending.range.empty) {
    ranges.push(
      Decoration.mark({ class: "cm-review-passage" }).range(pending.range.from, pending.range.to),
    );
  }
  return Decoration.set(ranges, true);
}

const reviewField = StateField.define({
  create: reviewDecorations,
  update: (value, transaction) =>
    transaction.docChanged ||
    transaction.reconfigured ||
    transaction.effects.some((e) => e.is(setPendingReviewPassage))
      ? reviewDecorations(transaction.state)
      : value,
  provide: (field) => EditorView.decorations.from(field),
});

/** Review UI is derived from the current file; only the temporary passage lives outside it. */
export function rfmReview(options: RfmReviewConfig) {
  return [
    config.of(options),
    pendingReviewPassage,
    reviewField,
    rfmInputFilter(),
    keymap.of([
      {
        key: "Mod-Alt-m",
        run(view) {
          const range = selectedPassage(view.state);
          if (!range) return false;
          view.dispatch({ effects: setPendingReviewPassage.of({ range, composing: true }) });
          return true;
        },
      },
    ]),
    EditorView.domEventHandlers({
      click(event, view) {
        const target =
          event.target instanceof Element
            ? event.target.closest<HTMLElement>("[data-review-thread]")
            : null;
        if (target) view.state.facet(config)?.onSelectThread(target.dataset.reviewThread ?? null);
        return false;
      },
    }),
    EditorState.transactionExtender.of((transaction) => {
      const id = transaction.state.facet(config)?.selectedThreadId;
      if (!id || id === transaction.startState.facet(config)?.selectedThreadId) return null;
      const review = reviewForDocument(transaction.newDoc);
      const anchor = review.threads.find((thread) => thread.id === id)?.anchor;
      if (!anchor) return null;
      return {
        effects: EditorView.scrollIntoView(anchor.source.start + review.body.range.start, {
          y: "nearest",
        }),
      };
    }),
    EditorView.baseTheme({
      ".cm-review-anchor": { boxShadow: "inset 0 -2px var(--review-color)", cursor: "text" },
      ".cm-review-anchor-selected": {
        backgroundColor: "color-mix(in srgb, var(--review-color) 16%, transparent)",
      },
      ".cm-review-passage": { backgroundColor: "var(--accent)" },
      ".cm-review-comment-action button": {
        padding: "5px 10px",
        fontSize: "12px",
        cursor: "pointer",
      },
      ".cm-review-composer": { padding: "12px", width: "min(320px, calc(100vw - 32px))" },
      ".cm-review-suggestion del": {
        backgroundColor: "color-mix(in srgb, #ef4444 15%, transparent)",
        textDecoration: "line-through",
      },
      ".cm-review-suggestion ins": {
        backgroundColor: "color-mix(in srgb, #22c55e 15%, transparent)",
        textDecoration: "none",
      },
    }),
  ];
}
