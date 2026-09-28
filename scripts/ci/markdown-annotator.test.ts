import { expect, test } from "vitest";
import { markedSection, replaceMarkedSection } from "./markdown-annotator.ts";

test.for<{ name: string; body: string; contents: string; expected: string }>([
  {
    name: "a body without the section gets it appended after a blank line, the author's text kept",
    body: "What this PR does.\n",
    contents: "table",
    expected: "What this PR does.\n\n<!-- loc-report -->\ntable\n<!-- /loc-report -->\n",
  },
  {
    name: "an existing section is replaced in place, and only that",
    body: "Intro.\n\n<!-- loc-report -->\nold\n<!-- /loc-report -->\n\nOutro.\n",
    contents: "new",
    expected: "Intro.\n\n<!-- loc-report -->\nnew\n<!-- /loc-report -->\n\nOutro.\n",
  },
  {
    name: "an empty body becomes just the section",
    body: "",
    contents: "\ntable\n",
    expected: "<!-- loc-report -->\ntable\n<!-- /loc-report -->\n",
  },
  {
    name: "another label's section is left alone",
    body: "<!-- os-preview -->\nlinks\n<!-- /os-preview -->\n",
    contents: "table",
    expected:
      "<!-- os-preview -->\nlinks\n<!-- /os-preview -->\n\n<!-- loc-report -->\ntable\n<!-- /loc-report -->\n",
  },
])("a managed section: $name", ({ body, contents, expected }) => {
  expect(replaceMarkedSection(body, "loc-report", contents)).toBe(expected);
});

test("a managed section reads back as what was written, and a body without one has none", () => {
  const body = replaceMarkedSection("Intro.", "loc-report", "table");
  expect({
    written: markedSection(body, "loc-report"),
    rewritten: markedSection(replaceMarkedSection(body, "loc-report", "newer"), "loc-report"),
    other: markedSection(body, "os-preview"),
  }).toEqual({ written: "table", rewritten: "newer", other: undefined });
});
