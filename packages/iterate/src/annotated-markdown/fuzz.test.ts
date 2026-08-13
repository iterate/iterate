import { describe, expect, test } from "vitest";
import { createAnchorSelector } from "./anchors.ts";
import {
  addComment,
  addThread,
  deleteComment,
  editComment,
  removeThread,
  setThreadStatus,
} from "./edits.ts";
import { parseAnnotatedMarkdown } from "./parse.ts";
import type { StructuredDocument } from "./types.ts";

// Deterministic fuzzing: random structural mutations must never crash the
// parser, never yield anything but structured|plain, and plain must always be
// byte-identical to its input; random valid edit sequences must always
// re-parse structured with the model matching what was written.

const md = (...lines: string[]): string => lines.join("\n");

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(rand: () => number, items: readonly T[]): T => {
  const item = items[Math.floor(rand() * items.length)];
  if (!item) throw new Error("pick from empty list");
  return item;
};

const CORPUS: readonly string[] = [
  md(
    "---",
    "title: Prevent stale search results",
    "state: in-progress",
    "tags: [search, correctness]",
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
  ),
  md(
    "---",
    "state: todo",
    "size: small",
    "---",
    "",
    "# A plain task",
    "",
    "No discussion store at all.",
    "",
  ),
  md(
    "# No front matter",
    "",
    "<!-- iterate-annotations:v1 -->",
    "<!-- iterate-thread:v1 begin id=th_a status=resolved -->",
    "<!-- iterate-comment:v1 begin id=cm_a author=lee created=2026-07-28T08:30:00Z -->",
    "Short.",
    "<!-- iterate-comment:v1 end id=cm_a -->",
    "<!-- iterate-thread:v1 end id=th_a -->",
    "",
  ),
];

type Mutation = (content: string, rand: () => number) => string;

const MUTATIONS: readonly { name: string; mutate: Mutation }[] = [
  {
    name: "insert char",
    mutate: (content, rand) => {
      const at = Math.floor(rand() * (content.length + 1));
      const char = pick(rand, ["-", "<", ">", "!", "=", " ", "\n", "x", ":", "\r", "\uFEFF"]);
      return content.slice(0, at) + char + content.slice(at);
    },
  },
  {
    name: "delete char",
    mutate: (content, rand) => {
      if (!content.length) return content;
      const at = Math.floor(rand() * content.length);
      return content.slice(0, at) + content.slice(at + 1);
    },
  },
  {
    name: "replace char",
    mutate: (content, rand) => {
      if (!content.length) return content;
      const at = Math.floor(rand() * content.length);
      return content.slice(0, at) + pick(rand, ["-", "q", "=", "9"]) + content.slice(at + 1);
    },
  },
  {
    name: "duplicate line",
    mutate: (content, rand) => {
      const lines = content.split("\n");
      const at = Math.floor(rand() * lines.length);
      lines.splice(at, 0, lines[at] ?? "");
      return lines.join("\n");
    },
  },
  {
    name: "delete line",
    mutate: (content, rand) => {
      const lines = content.split("\n");
      lines.splice(Math.floor(rand() * lines.length), 1);
      return lines.join("\n");
    },
  },
  {
    name: "swap lines",
    mutate: (content, rand) => {
      const lines = content.split("\n");
      if (lines.length < 2) return content;
      const a = Math.floor(rand() * lines.length);
      const b = Math.floor(rand() * lines.length);
      const [la, lb] = [lines[a] ?? "", lines[b] ?? ""];
      lines[a] = lb;
      lines[b] = la;
      return lines.join("\n");
    },
  },
  {
    name: "truncate",
    mutate: (content, rand) => content.slice(0, Math.floor(rand() * (content.length + 1))),
  },
  {
    name: "crlf a line",
    mutate: (content, rand) => {
      const lines = content.split("\n");
      const at = Math.floor(rand() * lines.length);
      lines[at] = `${lines[at] ?? ""}\r`;
      return lines.join("\n");
    },
  },
];

describe("mutation fuzz", () => {
  test("parser never throws, never loses bytes, stays deterministic", () => {
    const rand = mulberry32(20260728);
    for (let i = 0; i < 600; i++) {
      let content = pick(rand, CORPUS);
      const rounds = 1 + Math.floor(rand() * 3);
      const applied: string[] = [];
      for (let r = 0; r < rounds; r++) {
        const mutation = pick(rand, MUTATIONS);
        applied.push(mutation.name);
        content = mutation.mutate(content, rand);
      }
      const label = `iteration ${i} (${applied.join(", ")})`;
      const result = parseAnnotatedMarkdown(content);
      expect(result.raw, label).toBe(content);
      if (result.kind === "plain") {
        expect(result.body, label).toBe(content);
        expect(result.diagnostics.length, label).toBeGreaterThan(0);
      } else {
        expect(result.kind, label).toBe("structured");
        expect(result.diagnostics, label).toEqual([]);
      }
      const again = parseAnnotatedMarkdown(content);
      expect(again.kind, label).toBe(result.kind);
    }
  });
});

describe("edit-sequence fuzz", () => {
  test("random valid edit sequences keep the document structured and faithful", () => {
    const rand = mulberry32(31337);
    const BODY_WORDS = [
      "retry",
      "queue",
      "flake",
      "durable",
      "🚀",
      "naïve",
      "backtick`",
      "#tag",
      "*em*",
      "日本語",
    ];
    const randomBody = (): string => {
      const lineCount = 1 + Math.floor(rand() * 3);
      const lines: string[] = [];
      for (let l = 0; l < lineCount; l++) {
        const words = 1 + Math.floor(rand() * 5);
        lines.push(Array.from({ length: words }, () => pick(rand, BODY_WORDS)).join(" "));
        if (rand() < 0.3) lines.push("");
      }
      return lines.join("\n");
    };
    const isoAt = (n: number): string =>
      `2026-07-28T${String(10 + (n % 12)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}:00Z`;

    let doc: StructuredDocument = (() => {
      const parsed = parseAnnotatedMarkdown(
        md(
          "---",
          "state: todo",
          "---",
          "",
          "# Fuzz target",
          "",
          "Alpha beta gamma delta epsilon zeta.",
          "",
        ),
      );
      if (parsed.kind !== "structured") throw new Error("seed doc must parse");
      return parsed;
    })();

    // Model: what we believe each live comment's body is.
    const expectedBodies = new Map<string, string>();
    let counter = 0;

    for (let i = 0; i < 120; i++) {
      const threads = doc.discussion?.threads ?? [];
      const liveComments = threads.flatMap((t) => t.comments.filter((c) => !c.deleted));
      const op = pick(rand, [
        "addThread",
        "addComment",
        "editComment",
        "deleteComment",
        "setStatus",
        "removeThread",
      ] as const);
      counter++;
      try {
        if (op === "addThread" || !threads.length) {
          const body = randomBody();
          const anchored = rand() < 0.4 && doc.body.length > 12;
          const anchor = anchored
            ? (() => {
                const start = 1 + Math.floor(rand() * (doc.body.length - 8));
                const end = Math.min(doc.body.length, start + 1 + Math.floor(rand() * 6));
                return createAnchorSelector(doc.body, start, end);
              })()
            : undefined;
          const result = addThread(doc, {
            body,
            author: pick(rand, ["lee", "sam", "jonas@nustom.com"]),
            createdAt: isoAt(counter),
            ...(anchor && { anchor }),
          });
          doc = result.doc;
          expectedBodies.set(result.commentId, normalize(body));
        } else if (op === "addComment") {
          const thread = pick(rand, threads);
          const body = randomBody();
          const replyTo =
            thread.comments.length && rand() < 0.5 ? pick(rand, thread.comments).id : undefined;
          const result = addComment(doc, {
            threadId: thread.id,
            body,
            author: "lee",
            createdAt: isoAt(counter),
            ...(replyTo && { inReplyTo: replyTo }),
          });
          doc = result.doc;
          expectedBodies.set(result.commentId, normalize(body));
        } else if (op === "editComment" && liveComments.length) {
          const comment = pick(rand, liveComments);
          const body = randomBody();
          doc = editComment(doc, comment.id, body).doc;
          expectedBodies.set(comment.id, normalize(body));
        } else if (op === "deleteComment" && liveComments.length) {
          const comment = pick(rand, liveComments);
          doc = deleteComment(doc, comment.id).doc;
          expectedBodies.delete(comment.id);
        } else if (op === "setStatus") {
          const thread = pick(rand, threads);
          doc = setThreadStatus(doc, thread.id, rand() < 0.5 ? "open" : "resolved").doc;
        } else if (op === "removeThread") {
          const thread = pick(rand, threads);
          for (const comment of thread.comments) expectedBodies.delete(comment.id);
          doc = removeThread(doc, thread.id).doc;
        }
      } catch (error) {
        throw new Error(`op ${op} failed at iteration ${i}: ${String(error)}`);
      }

      // Full re-parse of the raw text must agree with the incremental doc.
      const reparsed = parseAnnotatedMarkdown(doc.raw);
      expect(reparsed.kind, `iteration ${i} after ${op}`).toBe("structured");
      if (reparsed.kind !== "structured") throw new Error("unreachable");
      for (const thread of reparsed.discussion?.threads ?? []) {
        for (const comment of thread.comments) {
          const expected = expectedBodies.get(comment.id);
          if (expected) {
            expect(comment.body, `body of ${comment.id} at iteration ${i}`).toBe(expected);
          }
        }
      }
      expect(reparsed.frontmatter?.data, `front matter at iteration ${i}`).toEqual({
        state: "todo",
      });
    }

    function normalize(body: string): string {
      const lines = body.split("\n");
      while (lines.length && lines[0]?.trim() === "") lines.shift();
      while (lines.length && lines[lines.length - 1]?.trim() === "") lines.pop();
      return lines.join("\n");
    }
  });
});
