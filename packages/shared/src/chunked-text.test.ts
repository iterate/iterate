import { expect, test } from "vitest";
import { appendText, ChunkedText, sliceText, takeText } from "./chunked-text.ts";

test("appends preserve sealed groups and round-trip through JSON", () => {
  const first = appendText("", "a".repeat(32 * 1024));
  const next = appendText(first, "next");
  expect(next.groups[0]).toBe(first.groups[0]);
  expect(next.groups[1]).toEqual({ 32: "next" });
  expect(sliceText(next, -4)).toBe("next");
  const wire = JSON.stringify(next);
  expect(sliceText(ChunkedText.parse(JSON.parse(wire)))).toBe("a".repeat(32 * 1024) + "next");
});

test("small appends only change the tail block", () => {
  const first = appendText("", "a".repeat(1024) + "hello");
  const next = appendText(first, " world");
  expect(next.groups[0]?.[0]).toBe(first.groups[0]?.[0]);
  expect(next.groups[0]?.[1]).toBe("hello world");
  expect(next.tailOffset).toBe(5);
  expect(first.groups[0]?.[1]).toBe("hello");
});

test.for([
  { prefix: "a".repeat(1023), chunks: ["😀", "!"], expected: "a".repeat(1023) + "😀!" },
  { prefix: "a".repeat(1023), chunks: ["\ud83d", "\ude00!"], expected: "a".repeat(1023) + "😀!" },
  { prefix: "a".repeat(1024), chunks: ["😀", "!"], expected: "a".repeat(1024) + "😀!" },
])("keeps a surrogate pair in one block ($chunks)", ({ prefix, chunks, expected }) => {
  let text = appendText("", prefix);
  for (const chunk of chunks) text = appendText(text, chunk);
  expect(sliceText(text)).toBe(expected);
  expect(ChunkedText.safeParse(text).success).toBe(true);
  const blocks = Object.values(text.groups).flatMap((group) => Object.values(group));
  expect(blocks.some((block) => /[\uD800-\uDBFF]$/.test(block))).toBe(false);
});

test.for([0, 1, 1023, 1024, 1025, 32768, 32769, 65536])(
  "takes a prefix without cutting a surrogate pair: %i",
  (limit) => {
    const source = "a".repeat(1023) + "😀" + "b".repeat(65536);
    const text = appendText("", source);
    const bounded = takeText(text, limit);
    expect(sliceText(bounded)).toBe(source.slice(0, limit).replace(/[\uD800-\uDBFF]$/, ""));
    expect(ChunkedText.safeParse(bounded).success).toBe(true);
    expect(text.length).toBe(source.length);
  },
);

test("rejects impossible metadata without traversing the claimed block count", () => {
  expect(
    ChunkedText.safeParse({ length: 1, blockCount: 1e12, tailOffset: 0, groups: {} }).success,
  ).toBe(false);
  expect(
    ChunkedText.safeParse({
      length: 99,
      blockCount: 1,
      tailOffset: 0,
      groups: { 0: { 0: "x" } },
    }).success,
  ).toBe(false);
});
