import { EditorSelection, EditorState, Transaction } from "@codemirror/state";
import { applyReviewOperation, readReview } from "iterate/document-review";
import { expect, test } from "vitest";
import {
  pendingReviewPassage,
  rfmReview,
  setPendingReviewPassage,
} from "./rfm-review-extension.ts";

const callbacks = {
  selectedThreadId: null,
  onSelectThread: () => {},
  onComment: () => true,
  mountComposer: () => {},
};

test("a composing passage follows remote edits while the native selection moves elsewhere", () => {
  const source = "---\nowner: Alice\n---\n\n# Launch\n\nReview this passage.\n";
  const from = source.indexOf("this passage");
  const range = EditorSelection.range(from, from + "this passage".length);
  let state = EditorState.create({
    doc: source,
    selection: range,
    extensions: rfmReview(callbacks),
  });
  state = state.update({ effects: setPendingReviewPassage.of({ range, composing: true }) }).state;
  state = state.update({
    changes: {
      from: source.indexOf("Alice"),
      to: source.indexOf("Alice") + 5,
      insert: "Alice and Bob",
    },
    annotations: Transaction.remote.of(true),
    filter: false,
  }).state;
  state = state.update({ selection: { anchor: state.doc.length } }).state;
  const bookmark = state.field(pendingReviewPassage).range!;
  expect(state.sliceDoc(bookmark.from, bookmark.to)).toBe("this passage");
  expect(bookmark.from).toBe(from + 8);
  const review = readReview(state.doc.toString());
  const result = applyReviewOperation(state.doc.toString(), {
    type: "add-selected-comment",
    expectedSource: state.doc.toString(),
    range: {
      start: bookmark.from - review.body.range.start,
      end: bookmark.to - review.body.range.start,
    },
    body: "Make this concrete.",
    author: "Bob",
  });
  expect(result.ok).toBe(true);
});

test("authoritative review edits remove their controls through the ordinary transform path", () => {
  const original = "Discuss this passage.\n";
  const comment = applyReviewOperation(original, {
    type: "add-selected-comment",
    expectedSource: original,
    range: { start: 8, end: 20 },
    body: "Discuss",
    author: "Alice",
  });
  if (!comment.ok) throw new Error(comment.message);
  let state = EditorState.create({ doc: comment.source, extensions: rfmReview(callbacks) });
  state = state.update({
    changes: { from: 0, to: state.doc.length, insert: original },
    filter: false,
    userEvent: "transform",
  }).state;
  expect(state.doc.toString()).toBe(original);
  expect(readReview(state.doc.toString()).threads).toEqual([]);
});

test("deleting a bookmarked passage preserves the composer so its draft can be recovered", () => {
  const range = EditorSelection.range(0, 7);
  let state = EditorState.create({
    doc: "Passage.\n",
    selection: range,
    extensions: rfmReview(callbacks),
  });
  state = state.update({ effects: setPendingReviewPassage.of({ range, composing: true }) }).state;
  state = state.update({
    changes: { from: 0, to: 7 },
    filter: false,
    annotations: Transaction.remote.of(true),
  }).state;
  expect(state.field(pendingReviewPassage).composing).toBe(true);
  expect(state.field(pendingReviewPassage).range?.empty).toBe(true);
});

test("malformed review markup does not open a selected-text composer", () => {
  const state = EditorState.create({
    doc: "{==broken",
    selection: { anchor: 3, head: 9 },
    extensions: rfmReview(callbacks),
  });
  expect(state.field(pendingReviewPassage).range).toBeNull();
});
