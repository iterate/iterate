import { expect, test } from "vitest";
import { inferJsonType } from "./infer-json-type.ts";

test("primitives and simple objects", () => {
  expect(inferJsonType({ ok: true, count: 3, name: "hi", missing: null }, { maxChars: 1_000 }))
    .toMatchInlineSnapshot(`
      "{
        ok: boolean;
        count: number;
        name: "hi";
        missing: null;
      }"
    `);
});

test("array elements merge structurally, with optional fields and cardinality", () => {
  const rows = [
    { id: 1, name: "a", tags: ["x", "y"] },
    { id: 2, name: "b", tags: [] },
    { id: 3, name: "c", tags: ["z"], deleted: true },
  ];
  expect(inferJsonType(rows, { maxChars: 1_000 })).toMatchInlineSnapshot(`
    "Array<{
      id: number;
      name: "a" | "b" | "c";
      tags: Array<"x" | "y" | "z"> /* 0–2 items each */;
      deleted?: boolean;
    }> /* 3 items */"
  `);
});

test("more than 5 distinct strings widen to string", () => {
  const rows = Array.from({ length: 10 }, (_, index) => ({ word: `word-${index}` }));
  expect(inferJsonType(rows, { maxChars: 1_000 })).toContain("word: string;");
});

test("mixed-kind fields become unions; too many kinds become unknown", () => {
  const union = [{ v: 1 }, { v: "s" }];
  expect(inferJsonType(union, { maxChars: 1_000 })).toContain(`v: number | "s";`);
  const chaos = [{ v: 1 }, { v: "s" }, { v: true }, { v: [] }];
  expect(inferJsonType(chaos, { maxChars: 1_000 })).toContain("v: unknown;");
});

test("null merges into unions", () => {
  const rows = [{ v: 1 }, { v: null }];
  expect(inferJsonType(rows, { maxChars: 1_000 })).toContain("v: number | null;");
});

test("long strings get an approximate length comment", () => {
  expect(inferJsonType({ body: "x".repeat(45_000) }, { maxChars: 1_000 })).toContain(
    "body: string /* up to ~45k chars */;",
  );
});

test("wide keyed objects render as Record", () => {
  const map = Object.fromEntries(
    Array.from({ length: 100 }, (_, index) => [
      `user-${index}`,
      { score: index, active: index % 2 === 0 },
    ]),
  );
  const rendered = inferJsonType(map, { maxChars: 1_000 });
  expect(rendered).toMatch(/^Record<string, \{/);
  expect(rendered).toContain("/* 100 keys */");
  expect(rendered).toContain("score: number;");
});

test("non-identifier keys are quoted", () => {
  expect(inferJsonType({ "content-type": "a" }, { maxChars: 1_000 })).toContain(
    '"content-type": "a";',
  );
});

test("maxChars is enforced by collapsing depth", () => {
  // Deeply nested and wide: full render is far over budget.
  const deep = Array.from({ length: 20 }, (_, index) => ({
    [`key${index}`]: { nested: { further: { evenMore: { value: index } } } },
  }));
  const rendered = inferJsonType(deep, { maxChars: 500 });
  expect(rendered.length).toBeLessThanOrEqual(500);
  expect(rendered).toContain("unknown /* nested object */");
});

test("handles empty containers", () => {
  expect(inferJsonType([], { maxChars: 100 })).toBe("unknown[] /* 0 items */");
  expect(inferJsonType({}, { maxChars: 100 })).toBe("{}");
});

test("undefined-valued keys become optional fields, matching JSON.stringify output", () => {
  const rows = [
    { id: 1, extra: "x" },
    { id: 2, extra: undefined },
  ];
  const rendered = inferJsonType(rows, { maxChars: 1_000 });
  expect(rendered).toContain('extra?: "x";');
  expect(rendered).not.toContain("null");
});
