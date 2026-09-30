// repo/commit-attribution.test.ts — the trailers a commit made for someone ends with, and where.
import { expect, test } from "vitest";
import { attributionTrailers, withTrailers } from "./commit-attribution.ts";

const misha = { actor: "user_1", email: "misha@example.com" };

test("a script's commit for someone names the run that made it", () => {
  expect(attributionTrailers({ principal: misha, grant: "g", run: "/@83" }, undefined)).toEqual([
    "Iterate-Run: /@83",
  ]);
});

test("a script that names someone else as author keeps who asked, as Requested-by", () => {
  expect(
    attributionTrailers({ principal: misha, run: "/@83" }, { email: "jonas@example.com" }),
  ).toEqual(["Iterate-Run: /@83", "Requested-by: misha@example.com"]);
  expect(
    attributionTrailers({ principal: misha, run: "/@83" }, { email: "misha@example.com" }),
  ).toEqual(["Iterate-Run: /@83"]);
});

test.for([
  {
    name: "a one-line message gets a paragraph of trailers (its subject is never one)",
    message: "docs: jams/23-sep.md, a shorter answer",
    expected: "docs: jams/23-sep.md, a shorter answer\n\nIterate-Run: /@83",
  },
  {
    name: "a message whose last paragraph is prose gets a paragraph of trailers",
    message: "Save plans/lisbon.md\n\nMerged in Jonas's commit.\n",
    expected: "Save plans/lisbon.md\n\nMerged in Jonas's commit.\n\nIterate-Run: /@83",
  },
  {
    name: "a message ending in the agent's Via joins it",
    message: "docs: jams/23-sep.md, a shorter answer\n\nVia: Claude Code\n",
    expected: "docs: jams/23-sep.md, a shorter answer\n\nVia: Claude Code\nIterate-Run: /@83",
  },
])("$name", ({ message, expected }) => {
  expect(withTrailers(message, ["Iterate-Run: /@83"])).toBe(expected);
});
