import {
  ChangeSet,
  Annotation,
  EditorSelection,
  EditorState,
  findClusterBreak,
  RangeSet,
  RangeValue,
  StateEffect,
  Transaction,
  type Extension,
} from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { DocumentReview } from "iterate/document-review";
import { reviewForDocument } from "./rfm-document.ts";

interface RfmControlRange {
  from: number;
  to: number;
  kind: "open" | "suffix" | "hidden" | "atomic" | "frontmatter" | "endmatter";
}

class AtomicRange extends RangeValue {}

const atomicRange = new AtomicRange();

/**
 * Source ranges that rich review projection does not expose as editable prose.
 * Their positions are absolute CodeMirror document offsets.
 */
export function rfmControlRanges(
  review: DocumentReview,
  sourceLength: number,
): readonly RfmControlRange[] {
  if (review.diagnostics.some((diagnostic) => diagnostic.severity === "error")) return [];

  const bodyStart = review.body.range.start;
  const bodyEnd = review.body.range.end;
  const anchors = new Set(
    review.threads.flatMap((thread) =>
      thread.anchor
        ? [`${bodyStart + thread.anchor.source.start}:${bodyStart + thread.anchor.source.end}`]
        : [],
    ),
  );
  const ranges: RfmControlRange[] = [];
  const add = (from: number, to: number, kind: RfmControlRange["kind"]) => {
    if (from < to) ranges.push({ from, to, kind });
  };

  add(0, bodyStart, "frontmatter");
  let cursor = bodyStart;
  let previousWasAnchor = false;
  for (let index = 0; index < review.projection.segments.length; index += 1) {
    const segment = review.projection.segments[index]!;
    const from = bodyStart + segment.source.start;
    const to = bodyStart + segment.source.end;
    const isAnchor = anchors.has(`${from}:${to}`);
    if (cursor < from) {
      const openStart =
        isAnchor && review.body.source.slice(from - bodyStart - 3, from - bodyStart) === "{=="
          ? from - 3
          : from;
      add(cursor, openStart, previousWasAnchor ? "suffix" : "hidden");
      add(openStart, from, isAnchor ? "open" : "hidden");
    }
    if (segment.atomic) add(from, to, "atomic");
    cursor = Math.max(cursor, to);
    previousWasAnchor = isAnchor;
  }
  if (cursor < bodyEnd) add(cursor, bodyEnd, previousWasAnchor ? "suffix" : "hidden");
  add(bodyEnd, sourceLength, "endmatter");

  const normalized: RfmControlRange[] = [];
  for (const range of ranges.sort((left, right) => left.from - right.from || left.to - right.to)) {
    const previous = normalized.at(-1);
    if (previous && range.from < previous.to) {
      if (range.to > previous.to) previous.to = range.to;
      continue;
    }
    normalized.push({ ...range });
  }
  return normalized;
}

function controlAt(ranges: readonly RfmControlRange[], position: number) {
  const interior = ranges.find((range) => range.from < position && position < range.to);
  if (interior) return interior;
  return ranges.find(
    (range) =>
      (range.kind === "frontmatter" && position === range.from) ||
      (range.kind === "endmatter" && position === range.to),
  );
}

function visibleFragments(ranges: readonly RfmControlRange[], from: number, to: number) {
  const fragments: { from: number; to: number }[] = [];
  let cursor = from;
  for (const range of ranges) {
    if (range.from >= to) break;
    if (range.to <= from) continue;
    if (cursor < range.from) fragments.push({ from: cursor, to: range.from });
    cursor = Math.max(cursor, range.to);
  }
  if (cursor < to) fragments.push({ from: cursor, to });
  return fragments;
}

function previousEditable(source: string, ranges: readonly RfmControlRange[], position: number) {
  let cursor = position;
  while (cursor > 0) {
    const range = ranges.find((candidate) => candidate.from < cursor && cursor <= candidate.to);
    if (range) {
      cursor = range.from;
      continue;
    }
    const from = findClusterBreak(source, cursor, false);
    if (!ranges.some((range) => range.from <= from && range.to >= cursor)) {
      return { from, to: cursor };
    }
    cursor = from;
  }
  return null;
}

function nextEditable(source: string, ranges: readonly RfmControlRange[], position: number) {
  let cursor = position;
  while (cursor < source.length) {
    const range = ranges.find((candidate) => candidate.from <= cursor && cursor < candidate.to);
    if (range) {
      cursor = range.to;
      continue;
    }
    const to = findClusterBreak(source, cursor);
    if (!ranges.some((range) => range.from <= cursor && range.to >= to)) {
      return { from: cursor, to };
    }
    cursor = to;
  }
  return null;
}

function normalizePosition(ranges: readonly RfmControlRange[], position: number) {
  const range = controlAt(ranges, position);
  if (!range) return position;
  if (range.kind === "frontmatter") return range.to;
  if (range.kind === "endmatter") return range.from;
  if (range.kind === "open") return range.to;
  if (range.kind === "suffix") return range.from;
  return position - range.from <= range.to - position ? range.from : range.to;
}

function normalizeSelection(ranges: readonly RfmControlRange[], selection: EditorSelection) {
  let changed = false;
  const normalized = selection.ranges.map((range) => {
    const anchor = normalizePosition(ranges, range.anchor);
    const head = normalizePosition(ranges, range.head);
    if (anchor === range.anchor && head === range.head) return range;
    changed = true;
    return range.empty
      ? EditorSelection.cursor(anchor, range.assoc)
      : EditorSelection.range(anchor, head);
  });
  return changed ? EditorSelection.create(normalized, selection.mainIndex) : selection;
}

function transactionAnnotations(transaction: Transaction) {
  // CodeMirror's public API exposes annotations by type, not as a collection.
  // Replacing a transaction must retain custom annotations, which the runtime
  // stores on this stable internal field.
  return (
    transaction as Transaction & {
      annotations: readonly Annotation<unknown>[];
    }
  ).annotations;
}

interface RewrittenChange {
  changes: { from: number; to: number; insert: string }[];
  cursor: number | null;
}

function rewriteChange(
  source: string,
  ranges: readonly RfmControlRange[],
  from: number,
  to: number,
  insert: string,
  userEvent: string | undefined,
): RewrittenChange | null {
  const intersects = ranges.some((range) => range.from < to && range.to > from);
  const insertionControl = from === to ? controlAt(ranges, from) : undefined;
  if (!intersects && !insertionControl) return null;

  let fragments = visibleFragments(ranges, from, to);
  if (fragments.length === 0 && insert.length === 0) {
    const adjacent =
      userEvent === "delete.backward"
        ? previousEditable(source, ranges, from)
        : userEvent === "delete.forward"
          ? nextEditable(source, ranges, to)
          : null;
    if (adjacent) fragments = [adjacent];
  }
  if (fragments.length === 0 && insert.length > 0 && insertionControl) {
    const point = normalizePosition(ranges, from);
    fragments = [{ from: point, to: point }];
  }
  if (fragments.length === 0) {
    return { changes: [], cursor: normalizePosition(ranges, from) };
  }

  const changes = fragments.map((fragment, index) => ({
    from: fragment.from,
    to: fragment.to,
    insert: index === 0 ? insert : "",
  }));
  const cursor =
    insert.length > 0
      ? fragments[0]!.from
      : userEvent === "delete.forward"
        ? normalizePosition(ranges, from)
        : fragments[0]!.from;
  return { changes, cursor };
}

/**
 * Motion treats projected-away RFM source as atomic. Local non-composition
 * edits that would alter it are rewritten to ordinary visible Markdown edits.
 */
export function rfmInputFilter(): Extension {
  return [
    EditorView.atomicRanges.of((view) => {
      const ranges = rfmControlRanges(reviewForDocument(view.state.doc), view.state.doc.length);
      return RangeSet.of(ranges.map((range) => atomicRange.range(range.from, range.to)));
    }),
    EditorState.transactionFilter.of((transaction) => {
      const review = reviewForDocument(transaction.startState.doc);
      const ranges = rfmControlRanges(review, transaction.startState.doc.length);
      if (
        transaction.annotation(Transaction.remote) ||
        transaction.isUserEvent("undo") ||
        transaction.isUserEvent("redo") ||
        transaction.isUserEvent("input.type.compose") ||
        ranges.length === 0
      ) {
        return transaction;
      }
      if (!transaction.docChanged) {
        const originalSelection = transaction.selection ?? transaction.startState.selection;
        const selection = normalizeSelection(ranges, originalSelection);
        if (selection === originalSelection) return transaction;
        return {
          selection,
          effects: transaction.effects,
          annotations: transactionAnnotations(transaction),
          scrollIntoView: transaction.scrollIntoView,
        };
      }

      const source = transaction.startState.doc.toString();
      const original: { from: number; to: number; insert: string }[] = [];
      transaction.changes.iterChanges((from, to, _newFrom, _newTo, inserted) => {
        original.push({ from, to, insert: inserted.toString() });
      });
      const rewritten = original.map((change) =>
        rewriteChange(
          source,
          ranges,
          change.from,
          change.to,
          change.insert,
          transaction.annotation(Transaction.userEvent),
        ),
      );
      if (rewritten.every((change) => change === null)) return transaction;

      const changes = ChangeSet.of(
        rewritten.flatMap((change, index) => change?.changes ?? [original[index]!]),
        source.length,
      );
      const selection =
        original.length === 1 && rewritten[0]?.cursor !== null
          ? EditorSelection.create([
              EditorSelection.cursor(
                original[0]!.insert.length > 0
                  ? changes.mapPos(rewritten[0]!.cursor!, -1) + original[0]!.insert.length
                  : changes.mapPos(rewritten[0]!.cursor!, -1),
              ),
            ])
          : transaction.startState.selection.map(changes);
      const nextDocument = changes.apply(transaction.startState.doc);
      const nextRanges = rfmControlRanges(reviewForDocument(nextDocument), nextDocument.length);
      const effects = StateEffect.mapEffects(
        StateEffect.mapEffects(transaction.effects, transaction.changes.invertedDesc),
        changes,
      );
      return {
        changes,
        selection: normalizeSelection(nextRanges, selection),
        effects,
        annotations: transactionAnnotations(transaction),
        scrollIntoView: transaction.scrollIntoView,
      };
    }),
  ];
}
