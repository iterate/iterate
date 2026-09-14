import { ChangeSet, Text } from "@codemirror/state";
import { expect, test } from "vitest";
import { textEdits } from "./text-edits.ts";

test("keeps independent source ranges when adding a selected comment", () => {
  const source = "First paragraph.\n\nSecond paragraph.\n";
  const next =
    "{==First==}{>>Check First.<<}{#c_1} paragraph.\n\nSecond paragraph.\n\n---\ncomments:\n  c_1:\n";
  const edits = textEdits(source, next);

  expect(edits).toHaveLength(3);
  expect(
    ChangeSet.of(edits, source.length)
      .apply(Text.of(source.split("\n")))
      .toString(),
  ).toBe(next);
});

test("finishes a pathological one-megabyte rewrite with the requested text", () => {
  const source = "ab".repeat(512 * 1024);
  const next = "ba".repeat(512 * 1024);
  const edits = textEdits(source, next);

  expect(edits.length).toBeGreaterThan(0);
  expect(
    ChangeSet.of(edits, source.length)
      .apply(Text.of(source.split("\n")))
      .toString(),
  ).toBe(next);
});
