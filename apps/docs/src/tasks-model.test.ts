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
  "The {==body text==}{>>A live comment.<<}{#c_a} needs review.",
  "",
  "---",
  "comments:",
  "  c_a:",
  "    by: lee",
  "    at: 2026-07-28T08:30:00Z",
  "  c_b:",
  "    body: A reply.",
  "    by: sam",
  "    at: 2026-07-28T09:00:00Z",
  "    re: c_a",
  "",
);

describe("parseTaskCard with RFM review markup", () => {
  it("counts comments and keeps board metadata", () => {
    const card = parseTaskCard("tasks/a.md", DISCUSSED);
    expect(card).toMatchObject({
      title: "Prevent stale search results",
      state: "in-review",
      labels: ["search"],
      frontmatterError: false,
      commentCount: 2,
    });
  });

  it("ignores review endmatter when inferring the title", () => {
    const source = md(
      "---",
      "state: todo",
      "---",
      "",
      "no heading in the body",
      "",
      "{>>Not the task title<<}{#c_a}",
      "",
      "---",
      "comments:",
      "  c_a:",
      "    by: lee",
      "    at: 2026-07-28T08:30:00Z",
      "",
    );
    expect(parseTaskCard("tasks/quiet.md", source).title).toBe("tasks/quiet.md");
  });

  it.each([
    "# {==Prevent stale search results==}{>>Clarify this.<<}{#c_title}",
    "{==# Prevent stale search results==}{>>Clarify this.<<}{#c_title}",
    "---\nstate: [unclosed\n---\n\n# {==Prevent stale search results==}{>>Clarify this.<<}{#c_title}",
  ])("infers a clean title from an annotated heading: %s", (source) => {
    expect(parseTaskCard("tasks/a.md", source).title).toBe("Prevent stale search results");
  });

  it("still flags broken YAML as a frontmatter error", () => {
    const card = parseTaskCard(
      "tasks/broken.md",
      md("---", "state: [unclosed", "---", "", "# Broken", ""),
    );
    expect(card).toMatchObject({
      frontmatterError: true,
      state: "todo",
      title: "Broken",
      commentCount: 0,
    });
  });

  it("frontmatter edits leave RFM endmatter untouched", () => {
    const next = setTaskCardState(DISCUSSED, "done");
    expect(next).toContain("state: done");
    expect(next.slice(next.lastIndexOf("\n---\ncomments:"))).toBe(
      DISCUSSED.slice(DISCUSSED.lastIndexOf("\n---\ncomments:")),
    );
    expect(parseTaskCard("tasks/a.md", next).commentCount).toBe(2);
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
      expected: { author: "usr_1", authorDisplay: "Two Words" },
    },
    {
      me: { name: null, email: "has spaces@x.com", userId: "usr_9" },
      expected: { author: "has spaces@x.com", authorDisplay: "has spaces@x.com" },
    },
    { me: { name: null, email: null, userId: null }, expected: { author: "someone" } },
  ])("derives $expected.author", ({ me, expected }) => {
    expect(commentIdentityFor(me)).toEqual(expected);
  });
});
