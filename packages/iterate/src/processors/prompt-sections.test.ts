import { expect, test } from "vitest";
import { parsePromptSections } from "./prompt-sections.ts";

test("a tagged file parses to one section per section, in file order, tags stripped", () => {
  const sections = parsePromptSections({
    content: [
      '<section key="identity">',
      "You are the test agent.",
      "</section>",
      "",
      '<section key="output-formatting">',
      "Respond with one fenced block.",
      "</section>",
    ].join("\n"),
    fallbackKey: "agent/system-prompt",
  });
  expect(sections).toEqual([
    { key: "identity", content: "You are the test agent." },
    { key: "output-formatting", content: "Respond with one fenced block." },
  ]);
});

test("an untagged file is one fallback section — old prompt files keep working unchanged", () => {
  expect(
    parsePromptSections({
      content: "Just a whole prompt.\nNo tags anywhere.\n",
      fallbackKey: "agent/system-prompt",
    }),
  ).toEqual([{ key: "agent/system-prompt", content: "Just a whole prompt.\nNo tags anywhere." }]);
});

test("untagged runs between and around tags land in the fallback section at their file position", () => {
  const sections = parsePromptSections({
    content: [
      "Preamble outside any tag.",
      '<section key="identity">Tagged.</section>',
      "A trailing addendum (the MCP prompt suffix shape).",
    ].join("\n"),
    fallbackKey: "agent/system-prompt",
  });
  expect(sections).toEqual([
    { key: "agent/system-prompt", content: "Preamble outside any tag." },
    { key: "identity", content: "Tagged." },
    {
      key: "agent/system-prompt",
      content: "A trailing addendum (the MCP prompt suffix shape).",
    },
  ]);
});

test("an empty file still parses to one empty fallback section", () => {
  expect(parsePromptSections({ content: "  \n", fallbackKey: "x" })).toEqual([
    { key: "x", content: "" },
  ]);
});

test("malformed authoring fails loudly at append time", () => {
  expect(() =>
    parsePromptSections({ content: '<section key="a">unclosed', fallbackKey: "x" }),
  ).toThrow(/unclosed/);
  expect(() =>
    parsePromptSections({
      content: '<section key="a"><section key="b">nested</section></section>',
      fallbackKey: "x",
    }),
  ).toThrow(/flat/);
});
