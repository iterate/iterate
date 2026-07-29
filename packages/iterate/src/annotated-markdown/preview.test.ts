import { expect, test } from "vitest";
import { parseAnnotatedMarkdown, projectMarkdownPreview } from "./index.ts";

test("projects valid YAML frontmatter away from a fail-open annotation document", () => {
  const source = [
    "---",
    "title: Review plan",
    "labels: [docs, review]",
    "---",
    "",
    "# Plan",
    "",
    "Keep this body visible.",
    "",
    "<!-- iterate-annotations:v1 broken -->",
    "",
  ].join("\n");

  expect(parseAnnotatedMarkdown(source).kind).toBe("plain");
  expect(projectMarkdownPreview(source)).toEqual({
    body: [
      "",
      "# Plan",
      "",
      "Keep this body visible.",
      "",
      "<!-- iterate-annotations:v1 broken -->",
      "",
    ].join("\n"),
    metadata: [
      { key: "title", value: "Review plan" },
      { key: "labels", value: "docs, review" },
    ],
  });
});

test("projects blank frontmatter and supports a BOM", () => {
  expect(projectMarkdownPreview("\uFEFF---\n---\n# Body\n")).toEqual({
    body: "# Body\n",
    metadata: [],
  });
});

test("leaves ordinary or invalid frontmatter byte-for-byte visible", () => {
  expect(projectMarkdownPreview("# Plain Markdown\n")).toEqual({
    body: "# Plain Markdown\n",
    metadata: [],
  });

  const midDocumentFences = [
    "# Plain Markdown",
    "",
    "Intro before the thematic break.",
    "",
    "---",
    "title: This is document content",
    "---",
    "",
    "Keep the whole document visible.",
    "",
  ].join("\n");
  expect(projectMarkdownPreview(midDocumentFences)).toEqual({
    body: midDocumentFences,
    metadata: [],
  });

  const malformed = "---\nlabels: [broken\n---\n# Keep this visible\n";
  expect(projectMarkdownPreview(malformed)).toEqual({ body: malformed, metadata: [] });

  const unsupported = "---\nvalue: &shared 1\ncopy: *shared\n---\n# Keep this visible\n";
  expect(projectMarkdownPreview(unsupported)).toEqual({
    body: unsupported,
    metadata: [],
  });
});
