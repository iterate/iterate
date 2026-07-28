import { expect, test } from "vitest";
import { projectMarkdownPreview } from "./markdown-frontmatter.ts";

test("projects YAML frontmatter separately from the Markdown body", () => {
  expect(
    projectMarkdownPreview(
      "---\nstate: backlog\nlabels: [demo, planning]\nsize: 3\n---\n\n# New task\n\nBody.\n",
    ),
  ).toEqual({
    body: "\n# New task\n\nBody.\n",
    metadata: [
      { key: "state", value: "backlog" },
      { key: "labels", value: "demo, planning" },
      { key: "size", value: "3" },
    ],
  });
});

test("leaves ordinary or malformed Markdown untouched", () => {
  expect(projectMarkdownPreview("# Plain Markdown\n")).toEqual({
    body: "# Plain Markdown\n",
    metadata: [],
  });
  const malformed = "---\nlabels: [broken\n---\n# Keep this visible\n";
  expect(projectMarkdownPreview(malformed)).toEqual({ body: malformed, metadata: [] });
});
