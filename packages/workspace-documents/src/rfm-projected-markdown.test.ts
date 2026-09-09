import { DocInput, ensureSyntaxTree, language, syntaxTree } from "@codemirror/language";
import { Compartment, EditorState, Text } from "@codemirror/state";
import { TreeFragment } from "@lezer/common";
import { applyReviewOperation } from "iterate/document-review";
import { expect, test } from "vitest";
import { projectedMarkdown } from "./rfm-projected-markdown.ts";
import { richMarkdown } from "./rich-markdown.ts";

function commented(source: string, passage: string) {
  const start = source.indexOf(passage);
  const result = applyReviewOperation(source, {
    type: "add-selected-comment",
    expectedSource: source,
    range: { start, end: start + passage.length },
    author: "Alice",
    body: "Please review | this.",
    createdAt: "2026-09-09T02:00:00Z",
  });
  if (!result.ok) throw new Error(result.message);
  return result.source;
}

test.for([
  ["# Heading", "ATXHeading1"],
  ["- First\n- Second", "BulletList"],
  ["| Name | Owner |\n| --- | --- |\n| Alpha | Alice |", "Table"],
])("a wrapped %s keeps Markdown syntax at source offsets", ([passage, nodeName]) => {
  const source = commented(passage + "\n", passage);
  const tree = projectedMarkdown().language.parser.parse(source);
  const node = tree.topNode.firstChild!;
  expect(node.name).toBe(nodeName);
  expect(source.slice(node.from, node.to)).toBe(passage);
  expect(tree.length).toBe(source.length);
});

test("a small edit reuses untouched syntax subtrees in an RFM document", () => {
  const original = commented("# Heading\n\nFirst paragraph.\n\nLast **paragraph**.\n", "# Heading");
  const parser = projectedMarkdown().language.parser;
  const first = parser.parse(new DocInput(Text.of(original.split("\n"))));
  const from = original.indexOf("First") + 5;
  const next = original.slice(0, from) + " revised" + original.slice(from);
  const fragments = TreeFragment.applyChanges(TreeFragment.addTree(first), [
    { fromA: from, toA: from, fromB: from, toB: from + 8 },
  ]);
  const second = parser.parse(next, fragments);
  expect(next.slice(second.topNode.lastChild!.from, second.topNode.lastChild!.to)).toBe(
    "Last **paragraph**.",
  );
  expect(second.topNode.lastChild!.toTree()).toBe(first.topNode.lastChild!.toTree());
});

test("selecting a review thread keeps the existing rich language and parsed tree", () => {
  const source = commented(
    "# Heading\n\n" + "A **shared** paragraph.\n\n".repeat(1000),
    "# Heading",
  );
  const layer = new Compartment();
  const callbacks = { onSelectThread: () => {}, onComment: () => true, mountComposer: () => {} };
  const state = EditorState.create({
    doc: source,
    extensions: layer.of(richMarkdown({ ...callbacks, selectedThreadId: null })),
  });
  const tree = ensureSyntaxTree(state, source.length, 200);
  expect(tree?.length).toBe(source.length);
  const next = state.update({
    effects: layer.reconfigure(richMarkdown({ ...callbacks, selectedThreadId: "thread" })),
  }).state;
  expect(next.facet(language)).toBe(state.facet(language));
  expect(syntaxTree(next)).toBe(tree);
});

test("an invalid review stays fully available to the Markdown source parser", () => {
  const source = "# Heading\n\n{==broken\n\n---\ncomments: [\n";
  const tree = projectedMarkdown().language.parser.parse(source);
  expect(tree.length).toBe(source.length);
  expect(tree.toString()).toContain("ATXHeading1");
});

test("a parse requested after hidden controls keeps positions relative to its requested start", () => {
  const source = commented("# First\n\n# Second\n\n# Third\n", "# First");
  const from = source.indexOf("# Second");
  const tree = projectedMarkdown().language.parser.parse(source, [], [{ from, to: source.length }]);
  expect(tree.length).toBe(source.length - from);
  const heading = tree.topNode.firstChild!;
  expect(heading.name).toBe("ATXHeading1");
  expect(source.slice(from + heading.from, from + heading.to)).toBe("# Second");
});

test("a fully hidden first requested range does not shift later projected Markdown", () => {
  const source = commented("# Before\n\n# First\n\n# Second\n", "# First");
  const hiddenControlStart = source.indexOf("{==");
  const hiddenControlEnd = source.indexOf("# First");
  const secondHeading = source.indexOf("# Second");
  const tree = projectedMarkdown().language.parser.parse(
    source,
    [],
    [
      { from: hiddenControlStart, to: hiddenControlEnd },
      { from: secondHeading, to: source.length },
    ],
  );
  const heading = tree.topNode.firstChild!;

  expect(tree.length).toBe(source.length - hiddenControlStart);
  expect(heading.name).toBe("ATXHeading1");
  expect(source.slice(hiddenControlStart + heading.from, hiddenControlStart + heading.to)).toBe(
    "# Second",
  );
});

test("an interrupted parse resumes through a large commented document", () => {
  const source = commented("# First\n\n" + "Another **paragraph**.\n\n".repeat(500), "# First");
  const parser = projectedMarkdown().language.parser;
  const partial = parser.startParse(source);
  const stop = source.indexOf("Another", 300);
  partial.stopAt(stop);
  let tree = partial.advance();
  while (!tree) tree = partial.advance();
  expect(tree.length).toBeLessThan(source.length);
  const resumed = parser.parse(source, TreeFragment.addTree(tree, [], true));
  expect(resumed.length).toBe(source.length);
  expect(source.slice(resumed.topNode.lastChild!.from, resumed.topNode.lastChild!.to)).toBe(
    "Another **paragraph**.",
  );
});
