import { describe, expect, test } from "vitest";
import { createAnchorSelector } from "./anchors.ts";
import {
  addComment,
  addThread,
  AnnotatedMarkdownEditError,
  deleteComment,
  editComment,
  formatUtcTimestamp,
  removeThread,
  setThreadAnchor,
  setThreadStatus,
} from "./edits.ts";
import type { EditErrorCode } from "./edits.ts";
import { parseAnnotatedMarkdown } from "./parse.ts";
import type { EditResult, StructuredDocument } from "./types.ts";

const md = (...lines: string[]): string => lines.join("\n");

const BARE = md(
  "---",
  "state: todo",
  "---",
  "",
  "# Fix the flaky test",
  "",
  "The retry loop masks the real failure.",
  "",
);

const WHO = { author: "jonas", authorDisplay: "Jonas", createdAt: "2026-07-28T10:00:00Z" };

function structured(content: string): StructuredDocument {
  const result = parseAnnotatedMarkdown(content);
  if (result.kind !== "structured") {
    throw new Error(`fixture did not parse: ${result.diagnostics[0]?.message}`);
  }
  return result;
}

/** The splices must fully describe the change: bytes outside them are untouched. */
function expectMinimalDiff(before: string, result: EditResult): void {
  let out = "";
  let cursor = 0;
  for (const splice of result.splices) {
    expect(splice.range.start).toBeGreaterThanOrEqual(cursor);
    out += before.slice(cursor, splice.range.start) + splice.insert;
    cursor = splice.range.end;
  }
  out += before.slice(cursor);
  expect(out).toBe(result.raw);
}

function expectEditError(fn: () => unknown, code: EditErrorCode): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AnnotatedMarkdownEditError);
    expect((error as AnnotatedMarkdownEditError).code).toBe(code);
    return;
  }
  expect.unreachable(`expected AnnotatedMarkdownEditError ${code}`);
}

describe("addThread", () => {
  test("creates the store on first use", () => {
    const doc = structured(BARE);
    const result = addThread(doc, {
      ...WHO,
      body: "Is this the same flake as last week?",
      threadId: "th_1",
      commentId: "cm_1",
    });
    expect(result).toMatchObject({ threadId: "th_1", commentId: "cm_1", label: "T1" });
    expect(result.raw).toBe(
      md(
        "---",
        "state: todo",
        "---",
        "",
        "# Fix the flaky test",
        "",
        "The retry loop masks the real failure.",
        "",
        "<!-- task-discussions:v1 -->",
        "",
        "## Discussion",
        "",
        "<!-- task-thread:v1 begin id=th_1 status=open -->",
        '<a id="thread-th_1"></a>',
        "### T1 · Open",
        "",
        "<!-- task-comment:v1 begin id=cm_1 author=jonas created=2026-07-28T10:00:00Z -->",
        "#### Jonas · 2026-07-28 10:00 UTC",
        "",
        "Is this the same flake as last week?",
        "<!-- task-comment:v1 end id=cm_1 -->",
        "",
        "<!-- task-thread:v1 end id=th_1 -->",
        "",
      ),
    );
    expect(result.raw.startsWith(BARE)).toBe(true);
    expectMinimalDiff(BARE, result);
    expect(result.doc.discussion?.threads[0]?.comments[0]?.body).toBe(
      "Is this the same flake as last week?",
    );
  });

  test("a file without a final newline gets the same appended store", () => {
    const truncated = BARE.slice(0, -1);
    const result = addThread(structured(truncated), {
      ...WHO,
      body: "Is this the same flake as last week?",
      threadId: "th_1",
      commentId: "cm_1",
    });
    const fromNewline = addThread(structured(BARE), {
      ...WHO,
      body: "Is this the same flake as last week?",
      threadId: "th_1",
      commentId: "cm_1",
    });
    expect(result.raw).toBe(fromNewline.raw);
  });

  test("anchored thread writes the selector and an inline marker", () => {
    const doc = structured(md("Alpha beta gamma.", ""));
    const selector = createAnchorSelector(doc.body, 6, 10);
    expect(selector).toEqual({
      quote: { exact: "beta", prefix: "Alpha ", suffix: " gamma.\n" },
      position: { start: 6, end: 10 },
    });
    const result = addThread(doc, {
      ...WHO,
      body: "Looks wrong.",
      threadId: "th_1",
      commentId: "cm_1",
      anchor: selector,
    });
    expect(result.raw).toBe(
      md(
        "Alpha beta [T1](#thread-th_1) gamma.",
        "",
        "<!-- task-discussions:v1 -->",
        "",
        "## Discussion",
        "",
        "<!-- task-thread:v1 begin id=th_1 status=open -->",
        '<a id="thread-th_1"></a>',
        "### T1 · Open",
        "",
        '<!-- task-anchor:v1 {"quote":{"exact":"beta","prefix":"Alpha ","suffix":" gamma.\\n"},"position":{"start":6,"end":10}} -->',
        "",
        "<!-- task-comment:v1 begin id=cm_1 author=jonas created=2026-07-28T10:00:00Z -->",
        "#### Jonas · 2026-07-28 10:00 UTC",
        "",
        "Looks wrong.",
        "<!-- task-comment:v1 end id=cm_1 -->",
        "",
        "<!-- task-thread:v1 end id=th_1 -->",
        "",
      ),
    );
    expectMinimalDiff(md("Alpha beta gamma.", ""), result);
    expect(result.doc.discussion?.threads[0]?.anchor?.selector).toEqual(selector);
  });

  test("a quote ending an unterminated file keeps the marker beside it", () => {
    const doc = structured("Alpha beta");
    const result = addThread(doc, {
      ...WHO,
      body: "Note.",
      threadId: "th_1",
      commentId: "cm_1",
      anchor: createAnchorSelector(doc.body, 6, 10),
    });
    expect(result.raw).toBe(
      md(
        "Alpha beta [T1](#thread-th_1)",
        "",
        "<!-- task-discussions:v1 -->",
        "",
        "## Discussion",
        "",
        "<!-- task-thread:v1 begin id=th_1 status=open -->",
        '<a id="thread-th_1"></a>',
        "### T1 · Open",
        "",
        '<!-- task-anchor:v1 {"quote":{"exact":"beta","prefix":"Alpha ","suffix":""},"position":{"start":6,"end":10}} -->',
        "",
        "<!-- task-comment:v1 begin id=cm_1 author=jonas created=2026-07-28T10:00:00Z -->",
        "#### Jonas · 2026-07-28 10:00 UTC",
        "",
        "Note.",
        "<!-- task-comment:v1 end id=cm_1 -->",
        "",
        "<!-- task-thread:v1 end id=th_1 -->",
        "",
      ),
    );
    expectMinimalDiff("Alpha beta", result);
  });

  test("labels count up from existing threads and a second thread appends", () => {
    const first = addThread(structured(BARE), {
      ...WHO,
      body: "First.",
      threadId: "th_1",
      commentId: "cm_1",
    });
    const second = addThread(first.doc, {
      ...WHO,
      body: "Second.",
      threadId: "th_2",
      commentId: "cm_2",
    });
    expect(second.label).toBe("T2");
    expect(second.raw.startsWith(first.raw)).toBe(true);
    expect(second.doc.discussion?.threads.map((t) => t.label)).toEqual(["T1", "T2"]);
  });

  test("multi-line bodies are normalized to trimmed lines", () => {
    const result = addThread(structured(BARE), {
      ...WHO,
      body: "\n\nFirst line.\n\nSecond line.  \n\n",
      threadId: "th_1",
      commentId: "cm_1",
    });
    expect(result.doc.discussion?.threads[0]?.comments[0]?.body).toBe(
      "First line.\n\nSecond line.  ",
    );
  });

  test("crlf files get crlf blocks", () => {
    const crlf = BARE.replace(/\n/g, "\r\n");
    const result = addThread(structured(crlf), {
      ...WHO,
      body: "Same flake?",
      threadId: "th_1",
      commentId: "cm_1",
    });
    expect(result.raw).toBe(
      md(
        "---",
        "state: todo",
        "---",
        "",
        "# Fix the flaky test",
        "",
        "The retry loop masks the real failure.",
        "",
        "<!-- task-discussions:v1 -->",
        "",
        "## Discussion",
        "",
        "<!-- task-thread:v1 begin id=th_1 status=open -->",
        '<a id="thread-th_1"></a>',
        "### T1 · Open",
        "",
        "<!-- task-comment:v1 begin id=cm_1 author=jonas created=2026-07-28T10:00:00Z -->",
        "#### Jonas · 2026-07-28 10:00 UTC",
        "",
        "Same flake?",
        "<!-- task-comment:v1 end id=cm_1 -->",
        "",
        "<!-- task-thread:v1 end id=th_1 -->",
        "",
      ).replace(/\n/g, "\r\n"),
    );
  });
});

describe("addComment", () => {
  test("inserts before the thread end with one blank line around", () => {
    const base = addThread(structured(BARE), {
      ...WHO,
      body: "First.",
      threadId: "th_1",
      commentId: "cm_1",
    });
    const result = addComment(base.doc, {
      threadId: "th_1",
      body: "A reply.",
      author: "sam",
      createdAt: "2026-07-28T11:15:00Z",
      inReplyTo: "cm_1",
      commentId: "cm_2",
    });
    expect(result.commentId).toBe("cm_2");
    expect(result.raw).toBe(
      base.raw.replace(
        md("<!-- task-comment:v1 end id=cm_1 -->", "", "<!-- task-thread:v1 end id=th_1 -->"),
        md(
          "<!-- task-comment:v1 end id=cm_1 -->",
          "",
          "<!-- task-comment:v1 begin id=cm_2 author=sam created=2026-07-28T11:15:00Z in-reply-to=cm_1 -->",
          "#### sam · 2026-07-28 11:15 UTC",
          "",
          "A reply.",
          "<!-- task-comment:v1 end id=cm_2 -->",
          "",
          "<!-- task-thread:v1 end id=th_1 -->",
        ),
      ),
    );
    expectMinimalDiff(base.raw, result);
    expect(result.doc.discussion?.threads[0]?.comments.map((c) => c.id)).toEqual(["cm_1", "cm_2"]);
  });
});

describe("setThreadStatus", () => {
  test("updates the sentinel attribute and the visible heading", () => {
    const base = addThread(structured(BARE), {
      ...WHO,
      body: "First.",
      threadId: "th_1",
      commentId: "cm_1",
    });
    const result = setThreadStatus(base.doc, "th_1", "resolved");
    expect(result.raw).toBe(
      base.raw
        .replace(
          "<!-- task-thread:v1 begin id=th_1 status=open -->",
          "<!-- task-thread:v1 begin id=th_1 status=resolved -->",
        )
        .replace("### T1 · Open", "### T1 · Resolved"),
    );
    expect(result.splices).toHaveLength(2);
    expectMinimalDiff(base.raw, result);
    expect(result.doc.discussion?.threads[0]?.status).toBe("resolved");

    const reopened = setThreadStatus(result.doc, "th_1", "open");
    expect(reopened.raw).toBe(base.raw);
  });

  test("no-op when the status already matches", () => {
    const base = addThread(structured(BARE), {
      ...WHO,
      body: "First.",
      threadId: "th_1",
      commentId: "cm_1",
    });
    const result = setThreadStatus(base.doc, "th_1", "open");
    expect(result.raw).toBe(base.raw);
    expect(result.splices).toEqual([]);
  });

  test("thread without a heading only touches the sentinel", () => {
    const content = md(
      "<!-- task-discussions:v1 -->",
      "<!-- task-thread:v1 begin id=th_a status=open -->",
      "<!-- task-comment:v1 begin id=cm_a author=lee created=2026-07-28T08:30:00Z -->",
      "Hi.",
      "<!-- task-comment:v1 end id=cm_a -->",
      "<!-- task-thread:v1 end id=th_a -->",
      "",
    );
    const result = setThreadStatus(structured(content), "th_a", "resolved");
    expect(result.raw).toBe(content.replace("status=open", "status=resolved"));
    expect(result.splices).toHaveLength(1);
  });
});

describe("editComment", () => {
  test("replaces exactly the body extent", () => {
    const base = addThread(structured(BARE), {
      ...WHO,
      body: "First.",
      threadId: "th_1",
      commentId: "cm_1",
    });
    const comment = base.doc.discussion?.threads[0]?.comments[0];
    const result = editComment(base.doc, "cm_1", "Rewritten.\n\nWith a second paragraph.");
    expect(result.splices).toEqual([
      { range: comment?.bodyRange, insert: "Rewritten.\n\nWith a second paragraph." },
    ]);
    expect(result.raw).toBe(
      base.raw.replace("First.", md("Rewritten.", "", "With a second paragraph.")),
    );
    expectMinimalDiff(base.raw, result);
    expect(result.doc.discussion?.threads[0]?.comments[0]?.body).toBe(
      "Rewritten.\n\nWith a second paragraph.",
    );
  });

  test("fills an empty comment body", () => {
    const content = md(
      "<!-- task-discussions:v1 -->",
      "<!-- task-thread:v1 begin id=th_a status=open -->",
      "<!-- task-comment:v1 begin id=cm_a author=lee created=2026-07-28T08:30:00Z -->",
      "<!-- task-comment:v1 end id=cm_a -->",
      "<!-- task-thread:v1 end id=th_a -->",
      "",
    );
    const result = editComment(structured(content), "cm_a", "Now with text.");
    expect(result.doc.discussion?.threads[0]?.comments[0]?.body).toBe("Now with text.");
    expectMinimalDiff(content, result);
  });
});

describe("deleteComment", () => {
  const THREADED = md(
    "# T",
    "",
    "<!-- task-discussions:v1 -->",
    "",
    "## Discussion",
    "",
    "<!-- task-thread:v1 begin id=th_a status=open -->",
    "### T1 · Open",
    "",
    "<!-- task-comment:v1 begin id=cm_a author=lee created=2026-07-28T08:30:00Z -->",
    "Root comment.",
    "<!-- task-comment:v1 end id=cm_a -->",
    "",
    "<!-- task-comment:v1 begin id=cm_b author=sam created=2026-07-28T09:00:00Z in-reply-to=cm_a -->",
    "A reply.",
    "<!-- task-comment:v1 end id=cm_b -->",
    "",
    "<!-- task-thread:v1 end id=th_a -->",
    "",
  );

  test("a leaf comment is removed with its separating blank line", () => {
    const result = deleteComment(structured(THREADED), "cm_b");
    expect(result.raw).toBe(
      THREADED.replace(
        md(
          "<!-- task-comment:v1 begin id=cm_b author=sam created=2026-07-28T09:00:00Z in-reply-to=cm_a -->",
          "A reply.",
          "<!-- task-comment:v1 end id=cm_b -->",
          "",
          "",
        ),
        "",
      ),
    );
    expectMinimalDiff(THREADED, result);
    expect(result.doc.discussion?.threads[0]?.comments.map((c) => c.id)).toEqual(["cm_a"]);
  });

  test("a comment with replies becomes a tombstone", () => {
    const result = deleteComment(structured(THREADED), "cm_a");
    expect(result.raw).toBe(
      THREADED.replace(
        "<!-- task-comment:v1 begin id=cm_a author=lee created=2026-07-28T08:30:00Z -->",
        "<!-- task-comment:v1 begin id=cm_a author=lee created=2026-07-28T08:30:00Z deleted=true -->",
      ).replace("Root comment.", "*Deleted.*"),
    );
    expectMinimalDiff(THREADED, result);
    expect(result.doc.discussion?.threads[0]?.comments[0]).toMatchObject({
      deleted: true,
      body: "*Deleted.*",
    });
  });

  test("deleting the last live comment sweeps a tombstone-only thread", () => {
    const tombstoned = deleteComment(structured(THREADED), "cm_a");
    const result = deleteComment(tombstoned.doc, "cm_b");
    expect(result.raw).toBe("# T\n");
    expect(result.doc.discussion).toBeNull();
  });

  test("a tombstone survives while a live sibling keeps the thread alive", () => {
    const tombstoned = deleteComment(structured(THREADED), "cm_a");
    const withThird = addComment(tombstoned.doc, {
      ...WHO,
      threadId: "th_a",
      body: "Still discussing.",
      commentId: "cm_c",
    });
    const afterReplyGone = deleteComment(withThird.doc, "cm_b");
    expect(
      afterReplyGone.doc.discussion?.threads[0]?.comments.map((c) => ({
        id: c.id,
        deleted: c.deleted,
      })),
    ).toEqual([
      { id: "cm_a", deleted: true },
      { id: "cm_c", deleted: false },
    ]);
    const cleared = deleteComment(afterReplyGone.doc, "cm_c");
    expect(cleared.doc.discussion).toBeNull();
  });

  test("deleting the only comment removes thread, marker, and empty store", () => {
    const original = md("Alpha beta gamma.", "");
    const added = addThread(structured(original), {
      ...WHO,
      body: "Looks wrong.",
      threadId: "th_1",
      commentId: "cm_1",
      anchor: createAnchorSelector(structured(original).body, 6, 10),
    });
    const result = deleteComment(added.doc, "cm_1");
    expect(result.raw).toBe(original);
  });
});

describe("removeThread", () => {
  test("removes one thread and keeps its neighbours byte-identical", () => {
    const first = addThread(structured(BARE), {
      ...WHO,
      body: "First.",
      threadId: "th_1",
      commentId: "cm_1",
    });
    const second = addThread(first.doc, {
      ...WHO,
      body: "Second.",
      threadId: "th_2",
      commentId: "cm_2",
    });
    const result = removeThread(second.doc, "th_1");
    expect(result.doc.discussion?.threads.map((t) => t.id)).toEqual(["th_2"]);
    expect(result.raw).toBe(
      second.raw.replace(
        md(
          "<!-- task-thread:v1 begin id=th_1 status=open -->",
          '<a id="thread-th_1"></a>',
          "### T1 · Open",
          "",
          "<!-- task-comment:v1 begin id=cm_1 author=jonas created=2026-07-28T10:00:00Z -->",
          "#### Jonas · 2026-07-28 10:00 UTC",
          "",
          "First.",
          "<!-- task-comment:v1 end id=cm_1 -->",
          "",
          "<!-- task-thread:v1 end id=th_1 -->",
          "",
          "",
        ),
        "",
      ),
    );
    expectMinimalDiff(second.raw, result);
  });
});

describe("setThreadAnchor", () => {
  test("adds, replaces, and removes the anchor line", () => {
    const base = addThread(structured(md("Alpha beta gamma.", "")), {
      ...WHO,
      body: "Note.",
      threadId: "th_1",
      commentId: "cm_1",
    });
    const withAnchor = setThreadAnchor(base.doc, "th_1", {
      quote: { exact: "beta", prefix: "Alpha ", suffix: " gamma.\n" },
    });
    expect(withAnchor.doc.discussion?.threads[0]?.anchor?.selector.quote.exact).toBe("beta");
    expectMinimalDiff(base.raw, withAnchor);

    const replaced = setThreadAnchor(withAnchor.doc, "th_1", {
      quote: { exact: "gamma", prefix: "beta ", suffix: ".\n" },
    });
    expect(replaced.doc.discussion?.threads[0]?.anchor?.selector.quote.exact).toBe("gamma");

    const removed = setThreadAnchor(replaced.doc, "th_1", null);
    expect(removed.doc.discussion?.threads[0]?.anchor).toBeNull();
    expect(removed.raw).toBe(base.raw);
  });

  test("double hyphens in quotes are escaped and round-trip", () => {
    const base = addThread(structured(md("A --strange-- token.", "")), {
      ...WHO,
      body: "Note.",
      threadId: "th_1",
      commentId: "cm_1",
    });
    const result = setThreadAnchor(base.doc, "th_1", {
      quote: { exact: "--strange--", prefix: "A ", suffix: " token.\n" },
    });
    const anchorLine = result.raw.split("\n").find((l) => l.startsWith("<!-- task-anchor:v1"));
    expect(anchorLine).toBeDefined();
    expect(anchorLine?.includes("--strange--")).toBe(false);
    expect(result.doc.discussion?.threads[0]?.anchor?.selector.quote.exact).toBe("--strange--");
  });
});

describe("edit errors", () => {
  const base = () =>
    addThread(structured(BARE), { ...WHO, body: "First.", threadId: "th_1", commentId: "cm_1" })
      .doc;

  test.for([
    {
      name: "author with whitespace",
      code: "invalid-author",
      run: (doc: StructuredDocument) => addThread(doc, { ...WHO, author: "two words", body: "x" }),
    },
    {
      name: "author with double hyphen",
      code: "invalid-author",
      run: (doc: StructuredDocument) => addThread(doc, { ...WHO, author: "a--b", body: "x" }),
    },
    {
      name: "non-utc createdAt",
      code: "invalid-created",
      run: (doc: StructuredDocument) =>
        addThread(doc, { ...WHO, createdAt: "2026-07-28T10:00:00+02:00", body: "x" }),
    },
    {
      name: "empty body",
      code: "invalid-body",
      run: (doc: StructuredDocument) => addThread(doc, { ...WHO, body: "  \n \n" }),
    },
    {
      name: "body containing a sentinel line",
      code: "invalid-body",
      run: (doc: StructuredDocument) =>
        addThread(doc, { ...WHO, body: "ok\n<!-- task-comment:v1 end id=x -->" }),
    },
    {
      name: "invalid thread id",
      code: "invalid-id",
      run: (doc: StructuredDocument) => addThread(doc, { ...WHO, body: "x", threadId: "bad id" }),
    },
    {
      name: "label containing the separator",
      code: "invalid-label",
      run: (doc: StructuredDocument) => addThread(doc, { ...WHO, body: "x", label: "a · b" }),
    },
    {
      name: "duplicate comment id",
      code: "duplicate-id",
      run: (doc: StructuredDocument) => addThread(doc, { ...WHO, body: "x", commentId: "cm_1" }),
    },
    {
      name: "comment on unknown thread",
      code: "unknown-thread",
      run: (doc: StructuredDocument) => addComment(doc, { ...WHO, threadId: "th_nope", body: "x" }),
    },
    {
      name: "reply to unknown comment",
      code: "invalid-reply-target",
      run: (doc: StructuredDocument) =>
        addComment(doc, { ...WHO, threadId: "th_1", body: "x", inReplyTo: "cm_nope" }),
    },
    {
      name: "edit unknown comment",
      code: "unknown-comment",
      run: (doc: StructuredDocument) => editComment(doc, "cm_nope", "x"),
    },
    {
      name: "delete unknown comment",
      code: "unknown-comment",
      run: (doc: StructuredDocument) => deleteComment(doc, "cm_nope"),
    },
    {
      name: "status on unknown thread",
      code: "unknown-thread",
      run: (doc: StructuredDocument) => setThreadStatus(doc, "th_nope", "resolved"),
    },
    {
      name: "remove unknown thread",
      code: "unknown-thread",
      run: (doc: StructuredDocument) => removeThread(doc, "th_nope"),
    },
    {
      name: "invalid anchor selector",
      code: "invalid-anchor",
      run: (doc: StructuredDocument) =>
        setThreadAnchor(doc, "th_1", { quote: { exact: "", prefix: "", suffix: "" } }),
    },
  ] as const)("$name", ({ code, run }) => {
    expectEditError(() => run(base()), code);
  });

  test("editing or re-deleting a tombstone is rejected", () => {
    const withReply = addComment(base(), {
      ...WHO,
      threadId: "th_1",
      body: "Reply.",
      inReplyTo: "cm_1",
      commentId: "cm_2",
    });
    const tombstoned = deleteComment(withReply.doc, "cm_1");
    expectEditError(() => editComment(tombstoned.doc, "cm_1", "resurrect"), "comment-deleted");
    expectEditError(() => deleteComment(tombstoned.doc, "cm_1"), "comment-deleted");
  });
});

describe("formatUtcTimestamp", () => {
  test.for([
    { iso: "2026-07-28T08:30:00Z", formatted: "2026-07-28 08:30 UTC" },
    { iso: "2026-07-28T08:30Z", formatted: "2026-07-28 08:30 UTC" },
    { iso: "not a date", formatted: "not a date" },
  ])("$iso -> $formatted", ({ iso, formatted }) => {
    expect(formatUtcTimestamp(iso)).toBe(formatted);
  });
});
