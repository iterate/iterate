import {
  collab,
  getSyncedVersion,
  rebaseUpdates,
  receiveUpdates,
  sendableUpdates,
  type Update,
} from "@codemirror/collab";
import { history, undo } from "@codemirror/commands";
import { EditorSelection, EditorState, type Transaction } from "@codemirror/state";
import { applyReviewOperation, readReview } from "iterate/document-review";
import { expect, test } from "vitest";
import {
  pendingReviewPassage,
  rfmReview,
  setPendingReviewPassage,
} from "./rfm-review-extension.ts";
import { textEdits } from "./text-edits.ts";

// This deliberately runs 750 edits and 750 rebases in one case, including RFM
// parsing after each update; allow 10s under the monorepo's parallel CPU load.
test(
  "three peers preserve Markdown, a comment draft, and local undo through 750 competing edits",
  { timeout: 10_000 },
  () => {
    const initial =
      "# Shared review\n\nAlice writes here.\n\nBob writes here.\n\nCharlie writes here.\n\nDiscuss the launch copy.\n";
    const seeded = applyReviewOperation(initial, {
      type: "add-document-comment",
      body: "Review together.",
      author: "Alice",
    });
    if (!seeded.ok) throw new Error(seeded.message);
    const callbacks = {
      selectedThreadId: null,
      onSelectThread: () => {},
      onComment: () => true,
      mountComposer: () => {},
    };
    const names = ["Alice", "Bob", "Charlie"];
    const peers = names.map((clientID) =>
      EditorState.create({
        doc: seeded.source,
        extensions: [history(), collab({ clientID }), rfmReview(callbacks)],
      }),
    );
    const from = seeded.source.indexOf("launch copy");
    peers[0] = peers[0]!.update({
      effects: setPendingReviewPassage.of({
        range: EditorSelection.range(from, from + "launch copy".length),
        composing: true,
      }),
    }).state;
    const accepted: Update[] = [];
    function synchronize() {
      for (const peer of peers) {
        accepted.push(
          ...rebaseUpdates(sendableUpdates(peer), accepted.slice(getSyncedVersion(peer))),
        );
        // Deliberately send all peers from the same old version, as simultaneous
        // keyboard edits do. Each receives the full accepted batch afterwards.
      }
      for (let i = 0; i < peers.length; i++) {
        peers[i] = peers[i]!.update(
          receiveUpdates(peers[i]!, accepted.slice(getSyncedVersion(peers[i]!))),
        ).state;
      }
    }
    for (let round = 0; round < 250; round++) {
      for (let i = 0; i < peers.length; i++) {
        const state = peers[i]!;
        const position =
          state.doc.toString().indexOf(`${names[i]} writes here`) +
          `${names[i]} writes here`.length;
        peers[i] = state.update({
          changes: { from: position, insert: `${i}` },
          userEvent: "input.type",
        }).state;
      }
      synchronize();
      expect(new Set(peers.map((peer) => peer.doc.toString())).size).toBe(1);
      expect(readReview(peers[0]!.doc.toString()).diagnostics).toEqual([]);
      const passage = peers[0]!.field(pendingReviewPassage).range!;
      expect(peers[0]!.sliceDoc(passage.from, passage.to)).toBe("launch copy");
    }
    const state = peers[0]!;
    const range = state.field(pendingReviewPassage).range!;
    const review = readReview(state.doc.toString());
    const comment = applyReviewOperation(state.doc.toString(), {
      type: "add-selected-comment",
      expectedSource: state.doc.toString(),
      range: {
        start: range.from - review.body.range.start,
        end: range.to - review.body.range.start,
      },
      body: "Make this concrete.",
      author: "Alice",
    });
    if (!comment.ok) throw new Error(comment.message);
    peers[0] = state.update({
      changes: textEdits(state.doc.toString(), comment.source),
      filter: false,
      userEvent: "transform",
    }).state;
    synchronize();
    expect(readReview(peers[2]!.doc.toString()).threads).toHaveLength(2);

    undo({
      state: peers[0],
      dispatch: (transaction: Transaction) => {
        peers[0] = transaction.state;
      },
    });
    synchronize();
    const saved = readReview(peers[2]!.doc.toString());
    expect(saved.diagnostics).toEqual([]);
    expect(saved.threads).toHaveLength(1);
    for (let i = 0; i < names.length; i++)
      expect(saved.projection.markdown).toContain(
        `${names[i]} writes here${String(i).repeat(250)}.`,
      );
  },
);
