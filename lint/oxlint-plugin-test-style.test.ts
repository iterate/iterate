// The six test-style rules (lint/test-style-rules.md), one row per rule: the source a test file
// might contain, and the lines the rule reports. Each row runs the real oxlint binary on a temp
// file.

import { expect, test } from "vitest";
import { createOxlintFixture } from "./oxlint-fixture.ts";

test.for([
  {
    rule: "no-describe",
    source: [
      'describe("group", () => {});',
      'describe.sequential("ordered", () => {});',
      'describe.skipIf(true)("gated", () => {});',
      'test.sequential("an ordered row", () => {});',
      'test.skipIf(true)("a gated row", () => {});',
    ],
    reportedLines: [1, 2, 3],
  },
  {
    rule: "no-lifecycle-hooks",
    source: [
      "beforeAll(() => {});",
      "beforeEach(() => {});",
      "afterEach(() => {});",
      "afterAll(() => {});",
      'test("row", () => { onTestFinished(() => {}); });',
    ],
    reportedLines: [1, 2, 3, 4],
  },
  {
    rule: "no-vi-mock",
    source: [
      'vi.mock("cloudflare:workers", () => ({}));',
      'vi.doMock("./dependency.ts");',
      "const fake = vi.fn();",
      'vi.spyOn(console, "error");',
      'vi.stubGlobal("fetch", fake);',
    ],
    reportedLines: [1, 2],
  },
  {
    rule: "helpers-after-tests",
    source: [
      "function helperAbove() {}",
      "const arrowAbove = () => 1;",
      "class FixtureAbove {}",
      "const rows = [1, 2];",
      'test("row", () => {});',
      "function helperBelow() {}",
    ],
    reportedLines: [1, 2, 3],
  },
  {
    rule: "prefer-object-property-match",
    source: [
      "expect(result.status).toBe(200);",
      "expect(result.body).not.toEqual({});",
      "expect(result.items).toStrictEqual([]);",
      "expect(result.items.length).toBe(0);",
      'expect(result["status"]).toBe(200);',
      "expect(result).toMatchObject({ status: 200 });",
      "expect(result.status).toBeGreaterThan(199);",
    ],
    reportedLines: [1, 2, 3],
  },
  {
    rule: "prefer-test-over-it",
    source: [
      'import { it, test } from "vitest";',
      'it("row", () => {});',
      'it.each([1])("row %i", () => {});',
      'test("row", () => {});',
    ],
    reportedLines: [1, 2, 3],
  },
])("$rule reports only the lines it names", ({ rule, source, reportedLines }) => {
  using fixture = createOxlintFixture({ rules: { [`iterate/${rule}`]: "error" } });
  fixture.write("input.test.ts", `${source.join("\n")}\n`);
  const reported = fixture
    .diagnostics(["input.test.ts"])
    .filter((diagnostic) => diagnostic.code === `iterate(${rule})`)
    .map((diagnostic) => diagnostic.labels[0]!.span.line);
  expect(reported.sort((a, b) => a - b)).toEqual(reportedLines);
});
