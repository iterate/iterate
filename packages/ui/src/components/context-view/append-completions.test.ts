// The append composer's completions: which types it knows and in what order, and what it offers
// where the caret is — a type after `type:`, a field at the start of a mapping line.
import { expect, test } from "vitest";
import { appendCompletionsAt, knownEventTypes } from "./append-completions.ts";

const known = knownEventTypes(
  [
    ["manual/note-added", 3],
    ["events.iterate.com/itx/woken", 5],
  ],
  [
    { name: "notes", consumes: ["manual/note-added", "events.iterate.com/itx/*"] },
    { name: "echo", consumes: ["demo/ping", "manual/note-added"] },
  ],
);

test("known types: consumed first (sorted, with who consumes them), then the log's by count", () => {
  expect(known).toEqual([
    { type: "demo/ping", section: "Consumed here", detail: "echo" },
    { type: "manual/note-added", section: "Consumed here", detail: "notes, echo · 3 in the log" },
    { type: "events.iterate.com/itx/woken", section: "In the log", detail: "5 in the log" },
  ]);
});

test.each([
  { name: "after `type: `", draft: "type: |", from: 6, labels: "types" },
  { name: "part of a type typed", draft: "type: man|", from: 6, labels: "types" },
  { name: "a quoted type", draft: 'type: "man|', from: 7, labels: "types" },
  { name: "a list item's type", draft: "- type: |", from: 8, labels: "types" },
  {
    name: "a list item's second type",
    draft: "- type: a\n  payload: {}\n- type: de|",
    from: 32,
    labels: "types",
  },
  {
    name: "a field started",
    draft: "pa|",
    from: 0,
    labels: ["type", "payload", "metadata", "idempotencyKey"],
  },
  {
    name: "a field in one mapping: the written ones left out",
    draft: "type: a\nm|",
    from: 8,
    labels: ["payload", "metadata", "idempotencyKey"],
  },
  {
    name: "a list item's field",
    draft: "- type: a\n  pay|",
    from: 12,
    labels: ["type", "payload", "metadata", "idempotencyKey"],
  },
  { name: "an empty line, unasked", draft: "type: a\n|", from: null, labels: null },
  { name: "inside the payload", draft: "type: a\npayload:\n  te|", from: null, labels: null },
  { name: "a payload value", draft: "type: a\npayload: |", from: null, labels: null },
  { name: "a type with a space in it", draft: "type: a b|", from: null, labels: null },
])("$name", ({ draft, from, labels }) => {
  const result = at(draft);
  if (from === null) return expect(result).toBeNull();
  expect(result).toEqual({
    from,
    labels: labels === "types" ? known.map((entry) => entry.type) : labels,
  });
});

test("an empty line offers the fields when asked (Ctrl+Space)", () => {
  expect(at("type: a\n|", true)?.labels).toEqual(["payload", "metadata", "idempotencyKey"]);
});

test("a mapping field opens its block; the others take a value on the line", () => {
  const options = appendCompletionsAt("p", 1, false, known)!.options;
  expect(options.find((option) => option.label === "payload")?.apply).toBe("payload:\n  ");
  expect(options.find((option) => option.label === "type")?.apply).toBe("type: ");
  const listed = appendCompletionsAt("- type: a\n  p", 13, false, known)!.options;
  expect(listed.find((option) => option.label === "payload")?.apply).toBe("payload:\n    ");
});

test("a type shows without the platform's prefix, and filters by the whole type", () => {
  const option = appendCompletionsAt("type: ", 6, false, known)!.options.find(
    (entry) => entry.label === "events.iterate.com/itx/woken",
  );
  expect(option).toMatchObject({ displayLabel: "itx/woken", section: "In the log" });
});

/** The draft with `|` as the caret. */
function at(draft: string, explicit = false) {
  const pos = draft.indexOf("|");
  const result = appendCompletionsAt(draft.replace("|", ""), pos, explicit, known);
  return result && { from: result.from, labels: result.options.map((option) => option.label) };
}
