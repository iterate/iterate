// repo/commit-attribution.test.ts — the trailers a commit made for someone ends with.
import { expect, test } from "vitest";
import { attributionTrailers, withTrailers } from "./commit-attribution.ts";

const misha = { actor: "user_1", email: "misha@example.com" };

test("a script's commit for someone names the client they connected and the run", () => {
  expect(
    attributionTrailers(
      { principal: misha, grant: "g", client: "Claude Code", run: "/@83" },
      undefined,
    ),
  ).toEqual(["Via: Claude Code", "Iterate-Run: /@83"]);
});

test("a script that names someone else as author keeps who asked, as Requested-by", () => {
  expect(
    attributionTrailers({ principal: misha, run: "/@83" }, { email: "jonas@example.com" }),
  ).toEqual(["Iterate-Run: /@83", "Requested-by: misha@example.com"]);
  expect(
    attributionTrailers({ principal: misha, run: "/@83" }, { email: "misha@example.com" }),
  ).toEqual(["Iterate-Run: /@83"]);
});

test("a client's name can't write a trailer of its own", () => {
  expect(
    attributionTrailers(
      { principal: misha, client: "Evil\nRequested-by: jonas@example.com", run: "/@83" },
      undefined,
    ),
  ).toEqual(["Via: Evil Requested-by: jonas@example.com", "Iterate-Run: /@83"]);
});

test.for([
  {
    name: "a one-line message gets a paragraph of trailers (its subject is never one)",
    message: "docs: jams/23-sep.md, a shorter answer",
    expected: "docs: jams/23-sep.md, a shorter answer\n\nVia: Claude Code\nIterate-Run: /@83",
  },
  {
    name: "a message whose last paragraph is prose gets a paragraph of trailers",
    message: "Save plans/lisbon.md\n\nMerged in Jonas's commit.\n",
    expected:
      "Save plans/lisbon.md\n\nMerged in Jonas's commit.\n\nVia: Claude Code\nIterate-Run: /@83",
  },
  {
    name: "a message ending in trailers gets them in the same paragraph",
    message: "Save plans/lisbon.md\n\nCo-authored-by: jonas@example.com <jonas@example.com>",
    expected:
      "Save plans/lisbon.md\n\nCo-authored-by: jonas@example.com <jonas@example.com>\nVia: Claude Code\nIterate-Run: /@83",
  },
])("$name", ({ message, expected }) => {
  expect(withTrailers(message, ["Via: Claude Code", "Iterate-Run: /@83"])).toBe(expected);
});
