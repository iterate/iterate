import { ChangeSet } from "@codemirror/state";
import { createFailing } from "@iterate-com/shared/test-support/failing-test";
import { textEdits } from "@iterate-com/workspace-documents/text-edits";
import { applyReviewOperation, readReview } from "iterate/document-review";
import { expect, test } from "vitest";
import { CollabHost } from "./collab-host.ts";
import { fakeSessionStore } from "./collab-store.fixtures.ts";

const path = "/notes.md";
const source = "First paragraph.\n\nSecond paragraph.\n";

function commentChanges(word: string) {
  const start = source.indexOf(word);
  const result = applyReviewOperation(source, {
    type: "add-selected-comment",
    expectedSource: source,
    range: { start, end: start + word.length },
    body: `Check ${word}.`,
    author: word,
    createdAt: "2026-09-08T13:00:00.000Z",
  });
  if (!result.ok) throw new Error(result.message);
  return ChangeSet.of(textEdits(source, result.source), source.length);
}

async function session() {
  const { store } = fakeSessionStore();
  const host = new CollabHost({
    store,
    fs: { readFile: async () => source, writeFile: async () => {} },
  });
  const opened = await host.open(path);
  return {
    host,
    push: (changes: ChangeSet, clientId: string) =>
      host.push({
        path,
        epoch: opened.epoch,
        baseVersion: 0,
        clientId,
        ops: [{ changes: changes.toJSON(), clientSeq: 0 }],
      }),
  };
}

for (const commentFirst of [true, false]) {
  test(`comment and concurrent prose typing survive (comment first: ${commentFirst})`, async () => {
    const { host, push } = await session();
    const comment = commentChanges("First");
    const typing = ChangeSet.of(
      { from: source.indexOf("Second") + 6, insert: " revised" },
      source.length,
    );
    const updates = commentFirst
      ? [
          { changes: comment, author: "reviewer" },
          { changes: typing, author: "writer" },
        ]
      : [
          { changes: typing, author: "writer" },
          { changes: comment, author: "reviewer" },
        ];
    for (const update of updates) {
      expect((await push(update.changes, update.author)).status).toBe("accepted");
    }
    // Retrying the same local comment update uses ordinary typing deduplication.
    expect((await push(comment, "reviewer")).status).toBe("accepted");
    const saved = (await host.readFile(path))!;
    const review = readReview(saved);
    expect(review.diagnostics).toEqual([]);
    expect(review.projection.markdown.trimEnd()).toBe(
      "First paragraph.\n\nSecond revised paragraph.",
    );
    expect(review.threads).toHaveLength(1);
    expect(review.threads[0]?.comments[0]?.body).toBe("Check First.");
    const changes = await host.changes(path);
    expect(changes.inserted.some((change) => change.clientId === "reviewer")).toBe(true);
    expect(changes.inserted.some((change) => change.clientId === "writer")).toBe(true);
  });
}

// Deliberately accepted for client-side RFM editing; see tasks/roughdraft-concurrent-endmatter.md.
const fails = createFailing(test, /FIRST COMMENT FOOTER RACE/);
fails("simultaneous first comments should share one valid endmatter", async () => {
  const { host, push } = await session();
  // Both clients see the same file without endmatter; each local edit is valid.
  const first = commentChanges("First");
  const second = commentChanges("Second");
  expect((await push(first, "alice")).status).toBe("accepted");
  expect((await push(second, "bob")).status).toBe("accepted");
  const saved = (await host.readFile(path))!;
  const review = readReview(saved);
  if (
    [...saved.matchAll(/\n---\ncomments:/g)].length === 2 &&
    review.diagnostics.some((diagnostic) => diagnostic.code === "missing-endmatter-entry")
  ) {
    throw new Error("FIRST COMMENT FOOTER RACE: two valid local edits created two endmatters");
  }
  expect(review.diagnostics).toEqual([]);
  expect(review.threads).toHaveLength(2);
  expect(review.projection.markdown.trimEnd()).toBe(source.trimEnd());
});
