import { describe, expect, it } from "vitest";
import { applyReviewOperation, readReview, sourceRangeForDisplayRange } from "./index.ts";

const anchoredSource = [
  "---",
  "title: Review",
  "---",
  "",
  "The {==incorrect text==}{>>Use the signed plan.<<}{#c1} needs changing.",
  "",
  "---",
  "comments:",
  "  c1:",
  "    by: Jonas",
  '    at: "2026-09-08T10:00:00.000Z"',
  "  c2:",
  "    body: I will fix it.",
  "    by: AI",
  '    at: "2026-09-08T10:01:00.000Z"',
  "    re: c1",
  "  c3:",
  "    body: Name an owner too.",
  "    by: Jonas",
  '    at: "2026-09-08T10:02:00.000Z"',
  "",
].join("\n");

describe("readReview", () => {
  it("projects frontmatter, CriticMarkup and endmatter away from ordinary Markdown", () => {
    const review = readReview(anchoredSource);

    expect(review.body.source).toContain("{==incorrect text==}");
    expect(review.body.source).not.toContain("title: Review");
    expect(review.projection.markdown).toBe("\nThe incorrect text needs changing.\n");
    expect(review.threads).toHaveLength(2);
    expect(review.threads[0]).toMatchObject({
      id: "c1",
      anchor: { source: { start: 8, end: 22 }, display: { start: 5, end: 19 } },
      comments: [
        { id: "c1", body: "Use the signed plan.", parentId: null },
        { id: "c2", body: "I will fix it.", parentId: "c1" },
      ],
    });
    expect(review.threads[1]).toMatchObject({ id: "c3", anchor: null });
    expect(sourceRangeForDisplayRange(review.projection, { start: 5, end: 19 })).toEqual({
      start: 8,
      end: 22,
    });
  });

  it("reports malformed referenced endmatter and leaves it unwriteable", () => {
    const source = "Text {>>Comment<<}{#c1}\n\n---\ncomments: [broken\n";
    const review = readReview(source);
    expect(review.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "missing-endmatter-entry",
    );
    expect(
      applyReviewOperation(source, {
        type: "add-document-comment",
        body: "Cannot write",
        author: "Jonas",
      }),
    ).toMatchObject({ ok: false, code: "invalid-document" });
  });

  it("rejects malformed reserved tail YAML even without an inline RFM reference", () => {
    const review = readReview("# Doc\n\n---\ncomments: [broken\n");
    expect(review.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "invalid-endmatter-yaml",
    );
  });

  it("leaves CriticMarkup examples in code literal and does not hide an ordinary YAML footer", () => {
    const source =
      "```markdown\n{==example==}{>>note<<}{#c1}\n```\n\n---\ncomments: ordinary prose\n";
    const review = readReview(source);
    expect(review.diagnostics).toEqual([]);
    expect(review.projection.markdown).toBe(source);
  });
});

describe("applyReviewOperation", () => {
  it("adds a selected comment with a source revision guard and rejects overlap", () => {
    const source = "A document with selected words.\n";
    const range = { start: 16, end: 30 };
    const added = applyReviewOperation(source, {
      type: "add-selected-comment",
      range,
      expectedSource: source,
      body: "This is not correct.",
      author: "Jonas",
      createdAt: "2026-09-08T10:00:00.000Z",
    });

    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.source).toContain("{==selected words==}{>>This is not correct.<<}{#c_");
    expect(added.review.threads[0]?.comments[0]).toMatchObject({
      body: "This is not correct.",
      author: "Jonas",
    });
    expect(
      applyReviewOperation(added.source, {
        type: "add-selected-comment",
        range,
        expectedSource: source,
        body: "Stale",
        author: "Jonas",
      }),
    ).toMatchObject({ ok: false, code: "stale-selection" });
    expect(
      applyReviewOperation(added.source, {
        type: "add-selected-comment",
        range: { start: 17, end: 21 },
        expectedSource: added.source,
        body: "Overlap",
        author: "Jonas",
      }),
    ).toMatchObject({ ok: false, code: "overlapping-selection" });
  });

  it("edits, resolves, reopens and deletes YAML-only comments", () => {
    const added = applyReviewOperation("# Doc\n", {
      type: "add-document-comment",
      body: "First thought",
      author: "Jonas",
      createdAt: "2026-09-08T10:00:00.000Z",
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const id = added.review.threads[0]?.id;
    expect(id).toBeDefined();
    if (id === undefined) return;

    const edited = applyReviewOperation(added.source, { type: "edit", id, body: "Edited thought" });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    const resolved = applyReviewOperation(edited.source, {
      type: "set-status",
      id,
      status: "resolved",
      summary: "Done",
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.review.threads[0]?.comments[0]?.status).toBe("resolved");
    const reopened = applyReviewOperation(resolved.source, {
      type: "set-status",
      id,
      status: "open",
    });
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    expect(reopened.review.threads[0]?.comments[0]).toMatchObject({
      body: "Edited thought",
      status: "open",
    });
    const deleted = applyReviewOperation(reopened.source, { type: "delete", id });
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) return;
    expect(deleted.review.threads).toEqual([]);
    expect(deleted.source).toBe("# Doc\n");
  });

  it("adds replies to anchored comments as YAML-only RFM comments", () => {
    const replied = applyReviewOperation(anchoredSource, {
      type: "reply",
      parentId: "c1",
      body: "A second reply.",
      author: "Lee",
      createdAt: "2026-09-08T10:03:00.000Z",
    });

    expect(replied.ok).toBe(true);
    if (!replied.ok) return;
    expect(replied.source).toContain("body: A second reply.");
    expect(replied.review.threads[0]?.comments).toMatchObject([
      { id: "c1" },
      { id: "c2", parentId: "c1" },
      { parentId: "c1", body: "A second reply.", author: "Lee" },
    ]);
  });

  it("keeps a root comment first when the index lists YAML replies before it", () => {
    const review = readReview(anchoredSource);
    expect(review.threads[0]?.comments.map((comment) => comment.id)).toEqual(["c1", "c2"]);
  });

  it("unwraps an anchored root when deleting its whole thread", () => {
    const deleted = applyReviewOperation(anchoredSource, { type: "delete", id: "c1" });
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) return;
    expect(deleted.source).toContain("The incorrect text needs changing.");
    expect(deleted.source).not.toContain("{==");
    expect(deleted.source).not.toContain("c1:");
    expect(deleted.source).not.toContain("c2:");
  });

  it("unwraps every inline descendant without skipping later review controls", () => {
    const source = [
      'First {==one==}{>>root<<}{id="c1" by="Jonas" at="2026-09-08T10:00:00.000Z"}; second {==two==}{>>child<<}{id="c2" by="AI" at="2026-09-08T10:01:00.000Z" re="c1"}.',
      "",
    ].join("\n");
    const deleted = applyReviewOperation(source, { type: "delete", id: "c1" });
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) return;
    expect(deleted.source).toBe("First one; second two.\n");
  });

  it("removes inline replies when deleting their canonical parent", () => {
    const source =
      'Text {==passage==}{>>root<<}{id="c1" by="Jonas" at="2026-09-08T10:00:00.000Z"}.\n';
    const replied = applyReviewOperation(source, {
      type: "reply",
      parentId: "c1",
      body: "Inline reply",
      author: "AI",
      createdAt: "2026-09-08T10:01:00.000Z",
    });
    expect(replied.ok).toBe(true);
    if (!replied.ok) return;
    expect(replied.source).toContain('re="c1"');

    const deleted = applyReviewOperation(replied.source, { type: "delete", id: "c1" });
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) return;
    expect(deleted.source).toBe("Text passage.\n");
  });

  it("rejects selections Roughdraft would treat as literal code", () => {
    const source = "```markdown\nselected text\n```\n";
    const result = applyReviewOperation(source, {
      type: "add-selected-comment",
      range: { start: 12, end: 25 },
      expectedSource: source,
      body: "Comment",
      author: "Jonas",
    });
    expect(result).toMatchObject({ ok: false, code: "invalid-operation" });
  });

  it("accepts and rejects suggestions when they have no replies", () => {
    const source = [
      "Add {++an example++}{#s1}; remove {--vague text--}{#s2}.",
      "",
      "---",
      "suggestions:",
      "  s1:",
      "    by: AI",
      '    at: "2026-09-08T10:00:00.000Z"',
      "  s2:",
      "    by: AI",
      '    at: "2026-09-08T10:00:00.000Z"',
      "",
    ].join("\n");
    const resolved = applyReviewOperation(source, {
      type: "set-status",
      id: "s1",
      status: "resolved",
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const reopened = applyReviewOperation(resolved.source, {
      type: "set-status",
      id: "s1",
      status: "open",
    });
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    expect(reopened.review.suggestions.find((suggestion) => suggestion.id === "s1")?.status).toBe(
      "open",
    );

    const accepted = applyReviewOperation(reopened.source, { type: "accept-suggestion", id: "s1" });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.source).toContain("Add an example");
    const rejected = applyReviewOperation(accepted.source, { type: "reject-suggestion", id: "s2" });
    expect(rejected.ok).toBe(true);
    if (!rejected.ok) return;
    expect(rejected.source).toBe("Add an example; remove vague text.\n");
  });

  it("removes suggestion replies when accepting a suggestion and keeps a substitution visible", () => {
    const source = [
      "Use {~~old~>new~~}{#s1}.",
      "",
      "---",
      "comments:",
      "  c1:",
      "    body: Why?",
      "    by: Jonas",
      '    at: "2026-09-08T10:00:00.000Z"',
      "    re: s1",
      "suggestions:",
      "  s1:",
      "    by: AI",
      '    at: "2026-09-08T10:00:00.000Z"',
      "",
    ].join("\n");
    const review = readReview(source);
    expect(review.threads).toMatchObject([{ id: "s1", comments: [{ id: "c1", parentId: "s1" }] }]);
    expect(review.projection.markdown).toBe("Use old → new.\n");
    const accepted = applyReviewOperation(source, { type: "accept-suggestion", id: "s1" });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.source).toBe("Use new.\n");
    expect(accepted.review.threads).toEqual([]);
  });

  it("removes inline suggestion replies and can reopen a suggestion", () => {
    const source = 'Use {++new text++}{id="s1" by="AI" at="2026-09-08T10:00:00.000Z"}.\n';
    const replied = applyReviewOperation(source, {
      type: "reply",
      parentId: "s1",
      body: "Why this change?",
      author: "Jonas",
      createdAt: "2026-09-08T10:01:00.000Z",
    });
    expect(replied.ok).toBe(true);
    if (!replied.ok) return;
    expect(replied.source).toContain('re="s1"');

    const resolved = applyReviewOperation(replied.source, {
      type: "set-status",
      id: "s1",
      status: "resolved",
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const reopened = applyReviewOperation(resolved.source, {
      type: "set-status",
      id: "s1",
      status: "open",
    });
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    expect(reopened.review.suggestions[0]?.status).toBe("open");

    const accepted = applyReviewOperation(replied.source, { type: "accept-suggestion", id: "s1" });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.source).toBe("Use new text.\n");
  });
});
