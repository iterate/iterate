import { describe, expect, test } from "vitest";
import { parseAnnotatedMarkdown } from "./parse.ts";
import type { PlainDocument, StructuredDocument } from "./types.ts";

const md = (...lines: string[]): string => lines.join("\n");

const FIXTURE = md(
  "---",
  "title: Prevent stale search results",
  "state: in-progress",
  "---",
  "",
  "# Prevent stale search results",
  "",
  "Publishing must durably enqueue invalidation before returning. [T1](#thread-th_alpha)",
  "",
  "<!-- iterate-annotations:v1 -->",
  "",
  "## Discussion",
  "",
  "<!-- iterate-thread:v1 begin id=th_alpha status=open -->",
  '<a id="thread-th_alpha"></a>',
  "### T1 · Open",
  "",
  '<!-- iterate-anchor:v1 {"quote":{"exact":"durably enqueue","prefix":"must ","suffix":" invalidation"},"position":{"start":47,"end":62}} -->',
  "",
  "<!-- iterate-comment:v1 begin id=cm_one author=lee created=2026-07-28T08:30:00Z -->",
  "#### Lee · 2026-07-28 08:30 UTC",
  "",
  'Does "durably enqueue" require the queue write to finish?',
  "<!-- iterate-comment:v1 end id=cm_one -->",
  "",
  "<!-- iterate-comment:v1 begin id=cm_two author=sam created=2026-07-28T09:00:00Z in-reply-to=cm_one -->",
  "#### Sam · 2026-07-28 09:00 UTC",
  "",
  "Yes — the write must land before the 200.",
  "<!-- iterate-comment:v1 end id=cm_two -->",
  "",
  "<!-- iterate-thread:v1 end id=th_alpha -->",
  "",
);

function expectStructured(content: string): StructuredDocument {
  const result = parseAnnotatedMarkdown(content);
  expect(result.kind).toBe("structured");
  if (result.kind !== "structured") throw new Error("unreachable");
  expect(result.raw).toBe(content);
  expect(result.diagnostics).toEqual([]);
  return result;
}

function expectPlain(content: string): PlainDocument {
  const result = parseAnnotatedMarkdown(content);
  expect(result.kind).toBe("plain");
  if (result.kind !== "plain") throw new Error("unreachable");
  // The fail-open invariant: fallback is byte-identical, never repaired.
  expect(result.raw).toBe(content);
  expect(result.body).toBe(content);
  expect(result.diagnostics.length).toBeGreaterThan(0);
  return result;
}

describe("golden fixture", () => {
  test("parses fully structured", () => {
    const doc = expectStructured(FIXTURE);
    expect(doc.frontmatter?.data).toEqual({
      title: "Prevent stale search results",
      state: "in-progress",
    });
    expect(doc.raw.slice(doc.frontmatter?.range.start, doc.frontmatter?.range.end)).toBe(
      md("---", "title: Prevent stale search results", "state: in-progress", "---", ""),
    );
    expect(doc.body).toBe(
      md(
        "",
        "# Prevent stale search results",
        "",
        "Publishing must durably enqueue invalidation before returning. [T1](#thread-th_alpha)",
        "",
        "",
      ),
    );
    expect(doc.raw.slice(doc.bodyRange.start, doc.bodyRange.end)).toBe(doc.body);
    expect(doc.discussion?.threads).toHaveLength(1);
    const thread = doc.discussion?.threads[0];
    expect(thread).toMatchObject({ id: "th_alpha", status: "open", label: "T1" });
    expect(thread?.anchor?.selector).toEqual({
      quote: { exact: "durably enqueue", prefix: "must ", suffix: " invalidation" },
      position: { start: 47, end: 62 },
    });
    expect(thread?.comments).toHaveLength(2);
    expect(thread?.comments[0]).toMatchObject({
      id: "cm_one",
      author: "lee",
      createdAt: "2026-07-28T08:30:00Z",
      inReplyTo: null,
      deleted: false,
      displayName: "Lee",
      body: 'Does "durably enqueue" require the queue write to finish?',
    });
    expect(thread?.comments[1]).toMatchObject({
      id: "cm_two",
      author: "sam",
      createdAt: "2026-07-28T09:00:00Z",
      inReplyTo: "cm_one",
      displayName: "Sam",
      body: "Yes — the write must land before the 200.",
    });
    const two = thread?.comments[1];
    expect(doc.raw.slice(two?.bodyRange.start, two?.bodyRange.end)).toBe(two?.body);
    expect(doc.raw.slice(doc.discussion?.range.start, doc.discussion?.range.end)).toBe(
      doc.raw.slice(doc.raw.indexOf("<!-- iterate-annotations:v1 -->")),
    );
  });

  test.for([
    { name: "crlf line endings", transform: (s: string) => s.replace(/\n/g, "\r\n") },
    { name: "utf-8 bom", transform: (s: string) => `\uFEFF${s}` },
    { name: "no final newline", transform: (s: string) => s.slice(0, -1) },
    {
      name: "mixed line endings",
      transform: (s: string) => {
        const lines = s.split("\n");
        return lines
          .map((line, i) => (i % 3 === 0 && i < lines.length - 1 ? `${line}\r` : line))
          .join("\n");
      },
    },
    {
      name: "trailing whitespace on a comment line",
      transform: (s: string) => s.replace("the 200.", "the 200.   "),
    },
  ])("byte preservation: $name", ({ transform }) => {
    const content = transform(FIXTURE);
    const doc = expectStructured(content);
    expect(doc.discussion?.threads[0]?.comments).toHaveLength(2);
    expect(doc.discussion?.threads[0]?.comments[0]?.body).toBe(
      'Does "durably enqueue" require the queue write to finish?',
    );
  });
});

describe("structured documents without discussions", () => {
  test.for([
    { name: "empty file", content: "", frontmatter: null, body: "" },
    {
      name: "body only",
      content: md("# Title", "", "Text.", ""),
      frontmatter: null,
      body: md("# Title", "", "Text.", ""),
    },
    {
      name: "front matter only",
      content: md("---", "state: todo", "---", ""),
      frontmatter: { state: "todo" },
      body: "",
    },
    {
      name: "empty front matter",
      content: md("---", "---", "body", ""),
      frontmatter: {},
      body: "body\n",
    },
    {
      name: "dots close fence",
      content: md("---", "state: todo", "...", "body", ""),
      frontmatter: { state: "todo" },
      body: "body\n",
    },
    {
      name: "fence trailing spaces",
      content: md("---  ", "state: todo", "---\t", "body", ""),
      frontmatter: { state: "todo" },
      body: "body\n",
    },
    {
      name: "bom then body",
      content: "\uFEFF# Title\n",
      frontmatter: null,
      body: "# Title\n",
    },
    {
      name: "horizontal rule later in body is not front matter",
      content: md("# Title", "", "---", "", "After the rule.", ""),
      frontmatter: null,
      body: md("# Title", "", "---", "", "After the rule.", ""),
    },
    {
      name: "indented sentinel lookalike is plain content",
      content: md("# Title", "", "    <!-- iterate-thread:v1 begin id=x status=open -->", ""),
      frontmatter: null,
      body: md("# Title", "", "    <!-- iterate-thread:v1 begin id=x status=open -->", ""),
    },
  ])("$name", ({ content, frontmatter, body }) => {
    const doc = expectStructured(content);
    expect(doc.discussion).toBeNull();
    expect(doc.body).toBe(body);
    if (frontmatter === null) expect(doc.frontmatter).toBeNull();
    else expect(doc.frontmatter?.data).toEqual(frontmatter);
  });
});

describe("discussion store shapes", () => {
  test("empty store", () => {
    const doc = expectStructured(
      md("# T", "", "<!-- iterate-annotations:v1 -->", "", "## Discussion", ""),
    );
    expect(doc.discussion?.threads).toEqual([]);
    expect(doc.body).toBe("# T\n\n");
  });

  test("interstitial prose at store level is preserved and tolerated", () => {
    const doc = expectStructured(
      md(
        "# T",
        "",
        "<!-- iterate-annotations:v1 -->",
        "",
        "## Discussion",
        "",
        "A stray human note between threads.",
        "",
        "<!-- iterate-thread:v1 begin id=th_a status=resolved -->",
        "<!-- iterate-comment:v1 begin id=cm_a author=lee created=2026-07-28T08:30:00Z -->",
        "Hi.",
        "<!-- iterate-comment:v1 end id=cm_a -->",
        "<!-- iterate-thread:v1 end id=th_a -->",
        "",
      ),
    );
    expect(doc.discussion?.threads).toHaveLength(1);
    expect(doc.discussion?.threads[0]).toMatchObject({
      id: "th_a",
      status: "resolved",
      label: null,
    });
    expect(doc.discussion?.threads[0]?.comments[0]?.body).toBe("Hi.");
  });

  test("thread with no comments and no heading", () => {
    const doc = expectStructured(
      md(
        "<!-- iterate-annotations:v1 -->",
        "<!-- iterate-thread:v1 begin id=th_a status=open -->",
        "<!-- iterate-thread:v1 end id=th_a -->",
        "",
      ),
    );
    expect(doc.discussion?.threads[0]).toMatchObject({
      id: "th_a",
      comments: [],
      label: null,
      anchor: null,
    });
  });

  test("comment with empty content has an empty body", () => {
    const doc = expectStructured(
      md(
        "<!-- iterate-annotations:v1 -->",
        "<!-- iterate-thread:v1 begin id=th_a status=open -->",
        "<!-- iterate-comment:v1 begin id=cm_a author=lee created=2026-07-28T08:30:00Z -->",
        "<!-- iterate-comment:v1 end id=cm_a -->",
        "<!-- iterate-thread:v1 end id=th_a -->",
        "",
      ),
    );
    const comment = doc.discussion?.threads[0]?.comments[0];
    expect(comment?.body).toBe("");
    expect(comment?.bodyRange.start).toBe(comment?.bodyRange.end);
  });

  test("heading is presentation: only the first content line is stripped", () => {
    const doc = expectStructured(
      md(
        "<!-- iterate-annotations:v1 -->",
        "<!-- iterate-thread:v1 begin id=th_a status=open -->",
        "<!-- iterate-comment:v1 begin id=cm_a author=lee created=2026-07-28T08:30:00Z -->",
        "#### Lee · 2026-07-28 08:30 UTC",
        "",
        "First paragraph.",
        "",
        "#### A markdown heading inside the body",
        "",
        "Second paragraph.",
        "<!-- iterate-comment:v1 end id=cm_a -->",
        "<!-- iterate-thread:v1 end id=th_a -->",
        "",
      ),
    );
    expect(doc.discussion?.threads[0]?.comments[0]?.body).toBe(
      md(
        "First paragraph.",
        "",
        "#### A markdown heading inside the body",
        "",
        "Second paragraph.",
      ),
    );
  });

  test("comment without a heading keeps its whole content as body", () => {
    const doc = expectStructured(
      md(
        "<!-- iterate-annotations:v1 -->",
        "<!-- iterate-thread:v1 begin id=th_a status=open -->",
        "<!-- iterate-comment:v1 begin id=cm_a author=lee created=2026-07-28T08:30:00Z -->",
        "Just text, no heading.",
        "<!-- iterate-comment:v1 end id=cm_a -->",
        "<!-- iterate-thread:v1 end id=th_a -->",
        "",
      ),
    );
    expect(doc.discussion?.threads[0]?.comments[0]?.body).toBe("Just text, no heading.");
    expect(doc.discussion?.threads[0]?.comments[0]?.displayName).toBeNull();
  });

  test("tombstone comment", () => {
    const doc = expectStructured(
      md(
        "<!-- iterate-annotations:v1 -->",
        "<!-- iterate-thread:v1 begin id=th_a status=open -->",
        "<!-- iterate-comment:v1 begin id=cm_a author=lee created=2026-07-28T08:30:00Z deleted=true -->",
        "*Deleted.*",
        "<!-- iterate-comment:v1 end id=cm_a -->",
        "<!-- iterate-comment:v1 begin id=cm_b author=sam created=2026-07-28T09:00:00Z in-reply-to=cm_a -->",
        "A reply that keeps the tombstone alive.",
        "<!-- iterate-comment:v1 end id=cm_b -->",
        "<!-- iterate-thread:v1 end id=th_a -->",
        "",
      ),
    );
    expect(doc.discussion?.threads[0]?.comments[0]?.deleted).toBe(true);
    expect(doc.discussion?.threads[0]?.comments[1]?.inReplyTo).toBe("cm_a");
  });

  test("descriptive labels parse from the heading", () => {
    const doc = expectStructured(
      md(
        "<!-- iterate-annotations:v1 -->",
        "<!-- iterate-thread:v1 begin id=th_a status=resolved -->",
        "### Perf question · Resolved",
        "",
        "<!-- iterate-thread:v1 end id=th_a -->",
        "",
      ),
    );
    expect(doc.discussion?.threads[0]?.label).toBe("Perf question");
  });

  test("unicode survives verbatim", () => {
    const doc = expectStructured(
      md(
        "# Émoji 🎉 und Ümlaute",
        "",
        "<!-- iterate-annotations:v1 -->",
        "<!-- iterate-thread:v1 begin id=th_a status=open -->",
        "<!-- iterate-comment:v1 begin id=cm_a author=lee created=2026-07-28T08:30:00Z -->",
        "日本語のコメント 🚀 with emoji.",
        "<!-- iterate-comment:v1 end id=cm_a -->",
        "<!-- iterate-thread:v1 end id=th_a -->",
        "",
      ),
    );
    expect(doc.discussion?.threads[0]?.comments[0]?.body).toBe("日本語のコメント 🚀 with emoji.");
  });

  test("anchor json with escaped double hyphens round-trips", () => {
    const doc = expectStructured(
      md(
        "<!-- iterate-annotations:v1 -->",
        "<!-- iterate-thread:v1 begin id=th_a status=open -->",
        '<!-- iterate-anchor:v1 {"quote":{"exact":"a-\\u002d-b","prefix":"","suffix":""}} -->',
        "<!-- iterate-thread:v1 end id=th_a -->",
        "",
      ),
    );
    expect(doc.discussion?.threads[0]?.anchor?.selector.quote.exact).toBe("a---b");
  });
});

describe("whole-file plain fallback", () => {
  test.for([
    {
      name: "unterminated front matter",
      content: md("---", "title: x", "", "body without a closing fence", ""),
      code: "frontmatter-unterminated",
    },
    {
      name: "malformed yaml",
      content: md("---", "title: [unclosed", "---", "body", ""),
      code: "frontmatter-yaml-error",
    },
    {
      name: "duplicate yaml key",
      content: md("---", "state: todo", "state: done", "---", ""),
      code: "frontmatter-yaml-error",
    },
    {
      name: "yaml alias",
      content: md("---", "a: &x 1", "b: *x", "---", ""),
      code: "frontmatter-alias",
    },
    {
      name: "yaml anchor without alias",
      content: md("---", "a: &x 1", "---", ""),
      code: "frontmatter-alias",
    },
    {
      name: "yaml core tag",
      content: md("---", "a: !!str hi", "---", ""),
      code: "frontmatter-tag",
    },
    {
      name: "yaml unknown tag",
      content: md("---", "a: !custom hi", "---", ""),
      code: "frontmatter-tag",
    },
    {
      name: "yaml merge key",
      content: md("---", "<<: {a: 1}", "---", ""),
      code: "frontmatter-merge-key",
    },
    {
      name: "yaml sequence root",
      content: md("---", "- 1", "- 2", "---", ""),
      code: "frontmatter-not-a-map",
    },
    {
      name: "yaml scalar root",
      content: md("---", "just a string", "---", ""),
      code: "frontmatter-not-a-map",
    },
    {
      name: "yaml numeric key",
      content: md("---", "1: x", "---", ""),
      code: "frontmatter-not-a-map",
    },
    {
      name: "yaml unsafe key",
      content: md("---", "__proto__: x", "---", ""),
      code: "frontmatter-yaml-error",
    },
    {
      name: "yaml directive",
      content: md("---", "%YAML 1.1", "---", "a: 1", "---", ""),
      code: "frontmatter-yaml-error",
    },
    {
      name: "yaml nested too deep",
      content: md("---", `a: ${"[".repeat(70)}${"]".repeat(70)}`, "---", ""),
      code: "frontmatter-depth",
    },
    {
      name: "sentinel missing terminator",
      content: md("<!-- iterate-annotations:v1", ""),
      code: "sentinel-malformed",
    },
    {
      name: "unknown sentinel kind",
      content: md("<!-- iterate-frobnicate:v1 -->", ""),
      code: "sentinel-malformed",
    },
    {
      name: "unsupported store version",
      content: md("<!-- iterate-annotations:v2 -->", ""),
      code: "sentinel-unsupported-version",
    },
    {
      name: "store with attributes",
      content: md("<!-- iterate-annotations:v1 extra -->", ""),
      code: "sentinel-malformed",
    },
    {
      name: "thread sentinel before the store",
      content: md(
        "<!-- iterate-thread:v1 begin id=th_a status=open -->",
        "<!-- iterate-thread:v1 end id=th_a -->",
        "",
      ),
      code: "sentinel-outside-store",
    },
    {
      name: "comment at store level",
      content: md(
        "<!-- iterate-annotations:v1 -->",
        "<!-- iterate-comment:v1 begin id=cm_a author=lee created=2026-07-28T08:30:00Z -->",
        "<!-- iterate-comment:v1 end id=cm_a -->",
        "",
      ),
      code: "sentinel-unexpected",
    },
    {
      name: "anchor at store level",
      content: md(
        "<!-- iterate-annotations:v1 -->",
        '<!-- iterate-anchor:v1 {"quote":{"exact":"x","prefix":"","suffix":""}} -->',
        "",
      ),
      code: "sentinel-unexpected",
    },
    {
      name: "nested thread begin",
      content: md(
        "<!-- iterate-annotations:v1 -->",
        "<!-- iterate-thread:v1 begin id=th_a status=open -->",
        "<!-- iterate-thread:v1 begin id=th_b status=open -->",
        "",
      ),
      code: "sentinel-unexpected",
    },
    {
      name: "mismatched thread end id",
      content: md(
        "<!-- iterate-annotations:v1 -->",
        "<!-- iterate-thread:v1 begin id=th_a status=open -->",
        "<!-- iterate-thread:v1 end id=th_b -->",
        "",
      ),
      code: "sentinel-mismatched",
    },
    {
      name: "mismatched comment end id",
      content: md(
        "<!-- iterate-annotations:v1 -->",
        "<!-- iterate-thread:v1 begin id=th_a status=open -->",
        "<!-- iterate-comment:v1 begin id=cm_a author=lee created=2026-07-28T08:30:00Z -->",
        "<!-- iterate-comment:v1 end id=cm_b -->",
        "",
      ),
      code: "sentinel-mismatched",
    },
    {
      name: "thread end while a comment is open (crossed pair)",
      content: md(
        "<!-- iterate-annotations:v1 -->",
        "<!-- iterate-thread:v1 begin id=th_a status=open -->",
        "<!-- iterate-comment:v1 begin id=cm_a author=lee created=2026-07-28T08:30:00Z -->",
        "<!-- iterate-thread:v1 end id=th_a -->",
        "",
      ),
      code: "sentinel-unexpected",
    },
    {
      name: "comment begin inside an open comment",
      content: md(
        "<!-- iterate-annotations:v1 -->",
        "<!-- iterate-thread:v1 begin id=th_a status=open -->",
        "<!-- iterate-comment:v1 begin id=cm_a author=lee created=2026-07-28T08:30:00Z -->",
        "<!-- iterate-comment:v1 begin id=cm_b author=lee created=2026-07-28T08:30:00Z -->",
        "",
      ),
      code: "sentinel-unexpected",
    },
    {
      name: "unterminated thread at eof",
      content: md(
        "<!-- iterate-annotations:v1 -->",
        "<!-- iterate-thread:v1 begin id=th_a status=open -->",
        "",
      ),
      code: "sentinel-unterminated",
    },
    {
      name: "unterminated comment at eof",
      content: md(
        "<!-- iterate-annotations:v1 -->",
        "<!-- iterate-thread:v1 begin id=th_a status=open -->",
        "<!-- iterate-comment:v1 begin id=cm_a author=lee created=2026-07-28T08:30:00Z -->",
        "dangling",
        "",
      ),
      code: "sentinel-unterminated",
    },
    {
      name: "second discussion store",
      content: md("<!-- iterate-annotations:v1 -->", "", "<!-- iterate-annotations:v1 -->", ""),
      code: "store-duplicate",
    },
    {
      name: "store sentinel inside a thread",
      content: md(
        "<!-- iterate-annotations:v1 -->",
        "<!-- iterate-thread:v1 begin id=th_a status=open -->",
        "<!-- iterate-annotations:v1 -->",
        "",
      ),
      code: "store-duplicate",
    },
    {
      name: "duplicate thread id",
      content: md(
        "<!-- iterate-annotations:v1 -->",
        "<!-- iterate-thread:v1 begin id=th_a status=open -->",
        "<!-- iterate-thread:v1 end id=th_a -->",
        "<!-- iterate-thread:v1 begin id=th_a status=open -->",
        "<!-- iterate-thread:v1 end id=th_a -->",
        "",
      ),
      code: "duplicate-id",
    },
    {
      name: "duplicate comment id across threads",
      content: md(
        "<!-- iterate-annotations:v1 -->",
        "<!-- iterate-thread:v1 begin id=th_a status=open -->",
        "<!-- iterate-comment:v1 begin id=cm_a author=lee created=2026-07-28T08:30:00Z -->",
        "<!-- iterate-comment:v1 end id=cm_a -->",
        "<!-- iterate-thread:v1 end id=th_a -->",
        "<!-- iterate-thread:v1 begin id=th_b status=open -->",
        "<!-- iterate-comment:v1 begin id=cm_a author=lee created=2026-07-28T08:30:00Z -->",
        "<!-- iterate-comment:v1 end id=cm_a -->",
        "<!-- iterate-thread:v1 end id=th_b -->",
        "",
      ),
      code: "duplicate-id",
    },
    {
      name: "comment id equals thread id",
      content: md(
        "<!-- iterate-annotations:v1 -->",
        "<!-- iterate-thread:v1 begin id=x status=open -->",
        "<!-- iterate-comment:v1 begin id=x author=lee created=2026-07-28T08:30:00Z -->",
        "<!-- iterate-comment:v1 end id=x -->",
        "<!-- iterate-thread:v1 end id=x -->",
        "",
      ),
      code: "duplicate-id",
    },
    {
      name: "reply to a missing comment",
      content: md(
        "<!-- iterate-annotations:v1 -->",
        "<!-- iterate-thread:v1 begin id=th_a status=open -->",
        "<!-- iterate-comment:v1 begin id=cm_a author=lee created=2026-07-28T08:30:00Z in-reply-to=cm_nope -->",
        "<!-- iterate-comment:v1 end id=cm_a -->",
        "<!-- iterate-thread:v1 end id=th_a -->",
        "",
      ),
      code: "invalid-reply",
    },
    {
      name: "reply to itself",
      content: md(
        "<!-- iterate-annotations:v1 -->",
        "<!-- iterate-thread:v1 begin id=th_a status=open -->",
        "<!-- iterate-comment:v1 begin id=cm_a author=lee created=2026-07-28T08:30:00Z in-reply-to=cm_a -->",
        "<!-- iterate-comment:v1 end id=cm_a -->",
        "<!-- iterate-thread:v1 end id=th_a -->",
        "",
      ),
      code: "invalid-reply",
    },
    {
      name: "reply across threads",
      content: md(
        "<!-- iterate-annotations:v1 -->",
        "<!-- iterate-thread:v1 begin id=th_a status=open -->",
        "<!-- iterate-comment:v1 begin id=cm_a author=lee created=2026-07-28T08:30:00Z -->",
        "<!-- iterate-comment:v1 end id=cm_a -->",
        "<!-- iterate-thread:v1 end id=th_a -->",
        "<!-- iterate-thread:v1 begin id=th_b status=open -->",
        "<!-- iterate-comment:v1 begin id=cm_b author=lee created=2026-07-28T08:30:00Z in-reply-to=cm_a -->",
        "<!-- iterate-comment:v1 end id=cm_b -->",
        "<!-- iterate-thread:v1 end id=th_b -->",
        "",
      ),
      code: "invalid-reply",
    },
    {
      name: "anchor after the first comment",
      content: md(
        "<!-- iterate-annotations:v1 -->",
        "<!-- iterate-thread:v1 begin id=th_a status=open -->",
        "<!-- iterate-comment:v1 begin id=cm_a author=lee created=2026-07-28T08:30:00Z -->",
        "<!-- iterate-comment:v1 end id=cm_a -->",
        '<!-- iterate-anchor:v1 {"quote":{"exact":"x","prefix":"","suffix":""}} -->',
        "<!-- iterate-thread:v1 end id=th_a -->",
        "",
      ),
      code: "anchor-misplaced",
    },
    {
      name: "two anchors in one thread",
      content: md(
        "<!-- iterate-annotations:v1 -->",
        "<!-- iterate-thread:v1 begin id=th_a status=open -->",
        '<!-- iterate-anchor:v1 {"quote":{"exact":"x","prefix":"","suffix":""}} -->',
        '<!-- iterate-anchor:v1 {"quote":{"exact":"y","prefix":"","suffix":""}} -->',
        "<!-- iterate-thread:v1 end id=th_a -->",
        "",
      ),
      code: "anchor-misplaced",
    },
    {
      name: "anchor json invalid",
      content: md(
        "<!-- iterate-annotations:v1 -->",
        "<!-- iterate-thread:v1 begin id=th_a status=open -->",
        "<!-- iterate-anchor:v1 {not json} -->",
        "<!-- iterate-thread:v1 end id=th_a -->",
        "",
      ),
      code: "anchor-invalid",
    },
    {
      name: "anchor json wrong shape",
      content: md(
        "<!-- iterate-annotations:v1 -->",
        "<!-- iterate-thread:v1 begin id=th_a status=open -->",
        '<!-- iterate-anchor:v1 {"quote":{"exact":"x","prefix":"","suffix":""},"extra":1} -->',
        "<!-- iterate-thread:v1 end id=th_a -->",
        "",
      ),
      code: "anchor-invalid",
    },
    {
      name: "double hyphen inside a sentinel",
      content: md(
        "<!-- iterate-annotations:v1 -->",
        "<!-- iterate-thread:v1 begin id=th_a status=open -->",
        "<!-- iterate-comment:v1 begin id=cm_a author=a--b created=2026-07-28T08:30:00Z -->",
        "<!-- iterate-comment:v1 end id=cm_a -->",
        "<!-- iterate-thread:v1 end id=th_a -->",
        "",
      ),
      code: "sentinel-malformed",
    },
    {
      name: "missing thread status",
      content: md(
        "<!-- iterate-annotations:v1 -->",
        "<!-- iterate-thread:v1 begin id=th_a -->",
        "",
      ),
      code: "sentinel-malformed",
    },
    {
      name: "invalid thread status",
      content: md(
        "<!-- iterate-annotations:v1 -->",
        "<!-- iterate-thread:v1 begin id=th_a status=maybe -->",
        "",
      ),
      code: "sentinel-malformed",
    },
    {
      name: "unknown attribute",
      content: md(
        "<!-- iterate-annotations:v1 -->",
        "<!-- iterate-thread:v1 begin id=th_a status=open color=red -->",
        "",
      ),
      code: "sentinel-malformed",
    },
    {
      name: "duplicate attribute",
      content: md(
        "<!-- iterate-annotations:v1 -->",
        "<!-- iterate-thread:v1 begin id=th_a id=th_b status=open -->",
        "",
      ),
      code: "sentinel-malformed",
    },
    {
      name: "double space between attributes",
      content: md(
        "<!-- iterate-annotations:v1 -->",
        "<!-- iterate-thread:v1 begin id=th_a  status=open -->",
        "",
      ),
      code: "sentinel-malformed",
    },
    {
      name: "invalid created timestamp",
      content: md(
        "<!-- iterate-annotations:v1 -->",
        "<!-- iterate-thread:v1 begin id=th_a status=open -->",
        "<!-- iterate-comment:v1 begin id=cm_a author=lee created=yesterday -->",
        "",
      ),
      code: "sentinel-malformed",
    },
    {
      name: "non-utc created timestamp",
      content: md(
        "<!-- iterate-annotations:v1 -->",
        "<!-- iterate-thread:v1 begin id=th_a status=open -->",
        "<!-- iterate-comment:v1 begin id=cm_a author=lee created=2026-07-28T08:30:00+02:00 -->",
        "",
      ),
      code: "sentinel-malformed",
    },
    {
      name: "deleted must be true",
      content: md(
        "<!-- iterate-annotations:v1 -->",
        "<!-- iterate-thread:v1 begin id=th_a status=open -->",
        "<!-- iterate-comment:v1 begin id=cm_a author=lee created=2026-07-28T08:30:00Z deleted=false -->",
        "",
      ),
      code: "sentinel-malformed",
    },
    {
      name: "comment end with extra attribute",
      content: md(
        "<!-- iterate-annotations:v1 -->",
        "<!-- iterate-thread:v1 begin id=th_a status=open -->",
        "<!-- iterate-comment:v1 begin id=cm_a author=lee created=2026-07-28T08:30:00Z -->",
        "<!-- iterate-comment:v1 end id=cm_a author=lee -->",
        "",
      ),
      code: "sentinel-malformed",
    },
  ] as const)("$name", ({ content, code }) => {
    const result = expectPlain(content);
    expect(result.diagnostics[0]?.code).toBe(code);
  });

  test("lone surrogate is rejected as invalid text", () => {
    const result = expectPlain("hello \ud800 world");
    expect(result.diagnostics[0]?.code).toBe("invalid-text");
  });

  test("fallback preserves crlf and missing final newline exactly", () => {
    const content = "---\r\ntitle: x\r\ntitle: y\r\n---\r\nbody without trailing newline";
    const result = expectPlain(content);
    expect(result.diagnostics[0]?.code).toBe("frontmatter-yaml-error");
  });
});

describe("anchor selector spellings", () => {
  const store = (anchorLine: string): string =>
    md(
      "Alpha beta gamma.",
      "",
      "<!-- iterate-annotations:v1 -->",
      "",
      "<!-- iterate-thread:v1 begin id=th_a status=open -->",
      anchorLine,
      "<!-- iterate-comment:v1 begin id=cm_a author=lee created=2026-07-28T08:30:00Z -->",
      "Body.",
      "<!-- iterate-comment:v1 end id=cm_a -->",
      "<!-- iterate-thread:v1 end id=th_a -->",
      "",
    );

  test("the W3C spelling parses to the same selector as the legacy spelling", () => {
    const w3c = expectStructured(
      store(
        '<!-- iterate-anchor:v1 {"selector":[{"type":"TextQuoteSelector","exact":"beta","prefix":"Alpha ","suffix":" gamma."},{"type":"TextPositionSelector","start":6,"end":10}]} -->',
      ),
    );
    const legacy = expectStructured(
      store(
        '<!-- iterate-anchor:v1 {"quote":{"exact":"beta","prefix":"Alpha ","suffix":" gamma."},"position":{"start":6,"end":10}} -->',
      ),
    );
    const expected = {
      quote: { exact: "beta", prefix: "Alpha ", suffix: " gamma." },
      position: { start: 6, end: 10 },
    };
    expect(w3c.discussion?.threads[0]?.anchor?.selector).toEqual(expected);
    expect(legacy.discussion?.threads[0]?.anchor?.selector).toEqual(expected);
  });

  test("W3C prefix and suffix are optional and default to empty", () => {
    const result = expectStructured(
      store(
        '<!-- iterate-anchor:v1 {"selector":[{"type":"TextQuoteSelector","exact":"beta"}]} -->',
      ),
    );
    expect(result.discussion?.threads[0]?.anchor?.selector).toEqual({
      quote: { exact: "beta", prefix: "", suffix: "" },
    });
  });

  test.for([
    {
      name: "unknown selector type",
      json: '{"selector":[{"type":"CssSelector","value":"p"}]}',
    },
    {
      name: "two quote selectors",
      json: '{"selector":[{"type":"TextQuoteSelector","exact":"a"},{"type":"TextQuoteSelector","exact":"b"}]}',
    },
    {
      name: "position without a quote",
      json: '{"selector":[{"type":"TextPositionSelector","start":0,"end":4}]}',
    },
    {
      name: "unknown key inside a selector entry",
      json: '{"selector":[{"type":"TextQuoteSelector","exact":"a","refinedBy":{}}]}',
    },
    {
      name: "selector key mixed with the legacy quote key",
      json: '{"selector":[{"type":"TextQuoteSelector","exact":"a"}],"quote":{"exact":"a"}}',
    },
    {
      name: "empty selector list",
      json: '{"selector":[]}',
    },
  ] as const)("rejected W3C shape: $name", ({ json }) => {
    const result = expectPlain(store(`<!-- iterate-anchor:v1 ${json} -->`));
    expect(result.diagnostics[0]?.code).toBe("anchor-invalid");
  });
});

describe("comment modified attribute", () => {
  test("modified parses onto the comment and survives round-trip", () => {
    const content = md(
      "Body.",
      "",
      "<!-- iterate-annotations:v1 -->",
      "",
      "<!-- iterate-thread:v1 begin id=th_a status=open -->",
      "<!-- iterate-comment:v1 begin id=cm_a author=lee created=2026-07-28T08:30:00Z modified=2026-07-29T09:00:00Z -->",
      "Edited body.",
      "<!-- iterate-comment:v1 end id=cm_a -->",
      "<!-- iterate-thread:v1 end id=th_a -->",
      "",
    );
    const result = expectStructured(content);
    expect(result.discussion?.threads[0]?.comments[0]?.modifiedAt).toBe("2026-07-29T09:00:00Z");
  });

  test("an invalid modified value is a fatal sentinel diagnostic", () => {
    const content = md(
      "<!-- iterate-annotations:v1 -->",
      "<!-- iterate-thread:v1 begin id=th_a status=open -->",
      "<!-- iterate-comment:v1 begin id=cm_a author=lee created=2026-07-28T08:30:00Z modified=yesterday -->",
      "<!-- iterate-comment:v1 end id=cm_a -->",
      "<!-- iterate-thread:v1 end id=th_a -->",
      "",
    );
    const result = expectPlain(content);
    expect(result.diagnostics[0]?.code).toBe("sentinel-malformed");
  });
});
