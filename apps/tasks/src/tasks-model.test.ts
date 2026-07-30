import { describe, expect, it, test } from "vitest";
import { commentIdentityFor } from "@iterate-com/workspace-documents/identity";
import { parseTaskCard, setTaskCardState } from "./tasks-model.ts";

const md = (...lines: string[]): string => lines.join("\n");

const DISCUSSED = md(
  "---",
  "state: in-review",
  "tags: [search]",
  "---",
  "",
  "# Prevent stale search results",
  "",
  "Body text.",
  "",
  "<!-- iterate-annotations:v1 -->",
  "",
  "## Discussion",
  "",
  "<!-- iterate-thread:v1 begin id=th_a status=open -->",
  "<!-- iterate-comment:v1 begin id=cm_a author=lee created=2026-07-28T08:30:00Z -->",
  "A live comment.",
  "<!-- iterate-comment:v1 end id=cm_a -->",
  "<!-- iterate-comment:v1 begin id=cm_b author=sam created=2026-07-28T09:00:00Z in-reply-to=cm_a deleted=true -->",
  "*Deleted.*",
  "<!-- iterate-comment:v1 end id=cm_b -->",
  "<!-- iterate-thread:v1 end id=th_a -->",
  "",
);

describe("parseTaskCard with discussions", () => {
  it("counts non-deleted comments and keeps board metadata", () => {
    const card = parseTaskCard("tasks/a.md", DISCUSSED);
    expect(card).toMatchObject({
      title: "Prevent stale search results",
      state: "in-review",
      labels: ["search"],
      frontmatterError: false,
      commentCount: 1,
    });
  });

  it("ignores headings inside the discussion store when inferring the title", () => {
    const source = md(
      "---",
      "state: todo",
      "---",
      "",
      "no heading in the body",
      "",
      "<!-- iterate-annotations:v1 -->",
      "<!-- iterate-thread:v1 begin id=th_a status=open -->",
      "<!-- iterate-comment:v1 begin id=cm_a author=lee created=2026-07-28T08:30:00Z -->",
      "# Not the task title",
      "<!-- iterate-comment:v1 end id=cm_a -->",
      "<!-- iterate-thread:v1 end id=th_a -->",
      "",
    );
    expect(parseTaskCard("tasks/quiet.md", source).title).toBe("tasks/quiet.md");
  });

  it("keeps board metadata when only the discussion store is malformed", () => {
    const source = md(
      "---",
      "state: done",
      "tags: [alpha]",
      "---",
      "",
      "# Broken store",
      "",
      "<!-- iterate-annotations:v1 -->",
      "<!-- iterate-thread:v1 begin id=th_a status=open -->",
      "",
    );
    const card = parseTaskCard("tasks/broken-store.md", source);
    expect(card).toMatchObject({
      title: "Broken store",
      state: "done",
      labels: ["alpha"],
      frontmatterError: false,
      commentCount: 0,
    });
  });

  it("never takes the board title from inside a broken store", () => {
    const source = md(
      "---",
      "state: todo",
      "---",
      "",
      "no heading in the real body",
      "",
      "<!-- iterate-annotations:v1 -->",
      "<!-- iterate-thread:v1 begin id=th_a status=open -->",
      "<!-- iterate-comment:v1 begin id=cm_a author=importer created=2026-07-26T10:00:00Z -->",
      "# Sneaky store heading",
      "<!-- iterate-thread:v1 end id=th_a -->",
      "",
    );
    const card = parseTaskCard("tasks/mangled.md", source);
    expect(card).toMatchObject({ title: "tasks/mangled.md", state: "todo", commentCount: 0 });
  });

  it("still flags broken YAML as a frontmatter error", () => {
    const card = parseTaskCard("tasks/broken.md", md("---", "state: [unclosed", "---", "", "# Broken", ""));
    expect(card).toMatchObject({ frontmatterError: true, state: "todo", title: "Broken", commentCount: 0 });
  });

  it("frontmatter edits leave the discussion store untouched", () => {
    const next = setTaskCardState(DISCUSSED, "done");
    expect(next).toContain("state: done");
    expect(next.slice(next.indexOf("<!-- iterate-annotations:v1 -->"))).toBe(
      DISCUSSED.slice(DISCUSSED.indexOf("<!-- iterate-annotations:v1 -->")),
    );
    expect(parseTaskCard("tasks/a.md", next).commentCount).toBe(1);
  });
});

describe("commentIdentityFor", () => {
  test.for([
    {
      me: { name: "Jonas Templestein", email: "jonas@nustom.com", userId: "usr_1" },
      expected: { author: "jonas@nustom.com", authorDisplay: "Jonas Templestein" },
    },
    {
      me: { name: "Two Words", email: null, userId: "usr_1" },
      expected: { author: "two-words", authorDisplay: "Two Words" },
    },
    {
      me: { name: null, email: "has spaces@x.com", userId: "usr_9" },
      expected: { author: "usr-9", authorDisplay: "has spaces@x.com" },
    },
    { me: { name: null, email: null, userId: null }, expected: { author: "someone" } },
  ])("derives $expected.author", ({ me, expected }) => {
    expect(commentIdentityFor(me)).toEqual(expected);
  });
});
