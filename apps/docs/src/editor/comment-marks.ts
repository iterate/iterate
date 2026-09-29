// The doc's comments in the editor: each open thread's quote highlighted where it's found in the
// text (@iterate-com/docs/anchor), then kept on its text through every edit, typed here or arriving
// from another tab, by mapping it through the changes. A thread's quote is searched for again only
// when the quote itself changes (a new thread, or the doc's processor re-anchoring one after a
// save), or while it's found nowhere: an edit that brings its text back (an undo) brings it back.
import { StateEffect, StateField, type ChangeDesc, type Text } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import { findQuote, type Quote } from "@iterate-com/docs/anchor";

/** A thread to highlight: its id and what it quotes. */
export type Marked = { id: string; quote: Quote };

export type MarkRange = { from: number; to: number };

type Marks = {
  threads: Marked[];
  /** Where each thread is now, by id; a thread missing here is found nowhere in the text. */
  ranges: Map<string, MarkRange>;
  active: string | null;
};

/** The threads to highlight, and which one is selected: the panel's choice, until the cursor moves
 *  (below). */
export const setMarked = StateEffect.define<{ threads: Marked[]; active: string | null }>();

export const commentMarks = StateField.define<Marks>({
  create: () => ({ threads: [], ranges: new Map(), active: null }),
  update(marks, transaction) {
    let next = marks;
    if (transaction.docChanged) {
      const ranges = mapRanges(marks.ranges, transaction.changes);
      next = { ...marks, ranges: findMissing(transaction.state.doc, marks.threads, ranges) };
    }
    for (const effect of transaction.effects)
      if (effect.is(setMarked)) {
        const doc = transaction.state.doc;
        const ranges = new Map<string, MarkRange>();
        for (const thread of effect.value.threads) {
          const before = next.threads.find((each) => each.id === thread.id);
          const kept = next.ranges.get(thread.id);
          // the same quote: its range has followed the text since it was found
          const same =
            before &&
            before.quote.exact === thread.quote.exact &&
            before.quote.prefix === thread.quote.prefix &&
            before.quote.suffix === thread.quote.suffix;
          if (kept && same) ranges.set(thread.id, kept);
        }
        next = {
          threads: effect.value.threads,
          ranges: findMissing(doc, effect.value.threads, ranges),
          active: effect.value.active,
        };
      }
    // the cursor moved by a click or a key: the thread it's in is selected, or none
    if (transaction.isUserEvent("select"))
      next = { ...next, active: threadAt(next.ranges, transaction.state.selection.main.head) };
    return next;
  },
  provide: (field) =>
    EditorView.decorations.from(field, ({ ranges, active }) =>
      Decoration.set(
        [...ranges].map(([id, range]) =>
          Decoration.mark({
            class: id === active ? "cm-comment cm-comment-active" : "cm-comment",
            attributes: { "data-thread": id },
          }).range(range.from, range.to),
        ),
        true,
      ),
    ),
});

/** The thread under `pos`, the shortest when several overlap. */
function threadAt(ranges: Map<string, MarkRange>, pos: number) {
  let found: [string, MarkRange] | null = null;
  for (const entry of ranges) {
    const [, range] = entry;
    if (range.from > pos || range.to < pos) continue;
    if (!found || range.to - range.from < found[1].to - found[1].from) found = entry;
  }
  return found && found[0];
}

export const commentTheme = EditorView.baseTheme({
  ".cm-comment": {
    backgroundColor: "color-mix(in oklab, #ffc53d 28%, transparent)",
    borderBottom: "2px solid color-mix(in oklab, #ffc53d 80%, transparent)",
  },
  ".cm-comment-active": { backgroundColor: "color-mix(in oklab, #ffc53d 60%, transparent)" },
});

/** Each range through the edit; typing just before or after a quote stays outside it, and a range
 *  whose text was all deleted is gone. */
function mapRanges(ranges: Map<string, MarkRange>, changes: ChangeDesc) {
  const mapped = new Map<string, MarkRange>();
  for (const [id, range] of ranges) {
    const from = changes.mapPos(range.from, 1);
    const to = changes.mapPos(range.to, -1);
    if (to > from) mapped.set(id, { from, to });
  }
  return mapped;
}

function findMissing(doc: Text, threads: Marked[], ranges: Map<string, MarkRange>) {
  const missing = threads.filter((thread) => !ranges.has(thread.id));
  if (missing.length === 0) return ranges;
  const text = doc.toString();
  for (const thread of missing) {
    const found = findQuote(text, thread.quote);
    if (found) ranges.set(thread.id, { from: found.from, to: found.to });
  }
  return ranges;
}
