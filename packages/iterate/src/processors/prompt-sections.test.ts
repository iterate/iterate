import { expect, test } from "vitest";
import { parsePromptSections } from "./prompt-sections.ts";

test("a tagged file parses to one segment per section, in file order, tags stripped", () => {
  const segments = parsePromptSections({
    content: [
      '<section id="identity">',
      "You are the test agent.",
      "</section>",
      "",
      '<section id="output-formatting">',
      "Respond with one fenced block.",
      "</section>",
    ].join("\n"),
    fallbackSectionId: "agent/system-prompt",
  });
  expect(segments).toEqual([
    { sectionId: "identity", content: "You are the test agent." },
    { sectionId: "output-formatting", content: "Respond with one fenced block." },
  ]);
});

test("an untagged file is one fallback segment — old prompt files keep working unchanged", () => {
  expect(
    parsePromptSections({
      content: "Just a whole prompt.\nNo tags anywhere.\n",
      fallbackSectionId: "agent/system-prompt",
    }),
  ).toEqual([
    { sectionId: "agent/system-prompt", content: "Just a whole prompt.\nNo tags anywhere." },
  ]);
});

test("untagged runs between and around tags land in the fallback section at their file position", () => {
  const segments = parsePromptSections({
    content: [
      "Preamble outside any tag.",
      '<section id="identity">Tagged.</section>',
      "A trailing addendum (the MCP prompt suffix shape).",
    ].join("\n"),
    fallbackSectionId: "agent/system-prompt",
  });
  expect(segments).toEqual([
    { sectionId: "agent/system-prompt", content: "Preamble outside any tag." },
    { sectionId: "identity", content: "Tagged." },
    {
      sectionId: "agent/system-prompt",
      content: "A trailing addendum (the MCP prompt suffix shape).",
    },
  ]);
});

test("an empty file still parses to one empty fallback segment", () => {
  expect(parsePromptSections({ content: "  \n", fallbackSectionId: "x" })).toEqual([
    { sectionId: "x", content: "" },
  ]);
});

test("malformed authoring fails loudly at append time", () => {
  expect(() =>
    parsePromptSections({ content: '<section id="a">unclosed', fallbackSectionId: "x" }),
  ).toThrow(/unclosed/);
  expect(() =>
    parsePromptSections({
      content: '<section id="a"><section id="b">nested</section></section>',
      fallbackSectionId: "x",
    }),
  ).toThrow(/flat/);
});
