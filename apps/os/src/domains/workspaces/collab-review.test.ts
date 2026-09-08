import { ChangeSet } from "@codemirror/state";
import { createFailing } from "@iterate-com/shared/test-support/failing-test";
import { textEdits } from "@iterate-com/workspace-documents/text-edits";
import { applyReviewOperation, readReview } from "iterate/document-review";
import { expect, test } from "vitest";
import { CollabHost } from "./collab-host.ts";
import { fakeSessionStore } from "./collab-store.fixtures.ts";

const path = "/notes.md";
const source = "First paragraph.\n\nSecond paragraph.\n";

function commentChanges(word: string, initial = source) {
  const start = initial.indexOf(word);
  const result = applyReviewOperation(initial, {
    type: "add-selected-comment",
    expectedSource: initial,
    range: { start, end: start + word.length },
    body: `Check ${word}.`,
    author: word,
    createdAt: "2026-09-08T13:00:00.000Z",
  });
  if (!result.ok) throw new Error(result.message);
  return ChangeSet.of(textEdits(initial, result.source), initial.length);
}

async function session(initial = source) {
  const { store } = fakeSessionStore();
  const host = new CollabHost({
    store,
    fs: { readFile: async () => initial, writeFile: async () => {} },
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

const overlappingCommentsFail = createFailing(test, /CONCURRENT COMMENT OVERLAP/);
for (const wordFirst of [true, false]) {
  overlappingCommentsFail(
    `concurrent word and paragraph comments preserve the preview (word first: ${wordFirst})`,
    async () => {
      const seeded = applyReviewOperation(source, {
        type: "add-document-comment",
        body: "File comment.",
        author: "reviewer",
      });
      if (!seeded.ok) throw new Error(seeded.message);
      const { host, push } = await session(seeded.source);
      const passages = wordFirst ? ["First", "First paragraph."] : ["First paragraph.", "First"];
      for (const passage of passages) {
        expect((await push(commentChanges(passage, seeded.source), passage)).status).toBe(
          "accepted",
        );
      }
      const saved = (await host.readFile(path))!;
      const review = readReview(saved);
      expect(review.diagnostics).toEqual([]);
      expect(review.threads).toHaveLength(3);
      if (saved.startsWith("{=={==First") && review.projection.markdown.startsWith("{==First")) {
        throw new Error("CONCURRENT COMMENT OVERLAP: nested highlights leak RFM into the preview");
      }
      expect(review.projection.markdown.trimEnd()).toBe(source.trimEnd());
    },
  );
}

const rewriteFails = createFailing(test, /UNRELATED COMMENT REWRITE/);
rewriteFails("adding a comment leaves existing metadata byte-for-byte intact", () => {
  const body =
    "A long comment with words that should keep their original source formatting. ".repeat(2);
  const initial = `# Doc\n\n---\ncomments:\n  c_old:\n    by: Alice\n    at: "2026-09-08T10:00:00Z"\n    body: ${body}\n`;
  const result = applyReviewOperation(initial, {
    type: "add-document-comment",
    body: "A new comment.",
    author: "Bob",
  });
  if (!result.ok) throw new Error(result.message);
  expect(result.review.diagnostics).toEqual([]);
  expect(result.review.threads).toHaveLength(2);
  expect(result.review.threads[0]?.comments[0]?.body).toBe(body.trimEnd());
  const edits = textEdits(initial, result.source);
  if (edits.some((edit) => edit.from < initial.trimEnd().length)) {
    throw new Error(
      "UNRELATED COMMENT REWRITE: adding a comment reformats another author's metadata",
    );
  }
});

const orphanedEndmatterFails = createFailing(test, /ORPHANED COMMENT ENDMATTER/);
orphanedEndmatterFails(
  "typing away an anchor leaves one hidden endmatter for subsequent comments",
  () => {
    // The inline comment was removed by ordinary typing; its metadata remains.
    const initial =
      '# Doc\n\n---\ncomments:\n  c_old:\n    by: Alice\n    at: "2026-09-08T10:00:00Z"\n';
    const result = applyReviewOperation(initial, {
      type: "add-document-comment",
      body: "A new comment.",
      author: "Bob",
    });
    if (!result.ok) throw new Error(result.message);
    expect(result.review.diagnostics).toEqual([]);
    if (
      [...result.source.matchAll(/\n---\ncomments:/g)].length === 2 &&
      readReview(initial).projection.markdown.includes("comments:")
    ) {
      throw new Error(
        "ORPHANED COMMENT ENDMATTER: dangling metadata renders as prose and spawns a second footer",
      );
    }
    expect(result.review.projection.markdown.trimEnd()).toBe("# Doc");
  },
);
