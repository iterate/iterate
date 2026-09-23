// The six test-style rules (lint/test-style-rules.md), one row per rule: the source a test file
// might contain, and the lines the rule reports. Each row runs the real oxlint binary on a temp
// file outside Git, where grandfatherRule exempts nothing.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";

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
  using fixture = createOxlintFixture(rule);
  fixture.write(`${source.join("\n")}\n`);
  expect(fixture.reportedLines()).toEqual(reportedLines);
});

const repoRoot = resolve(import.meta.dirname, "..");

/** A temp project with the real plugin and one rule armed, linted by the real oxlint binary. */
function createOxlintFixture(rule: string) {
  const root = mkdtempSync(join(tmpdir(), "iterate-oxlint-test-style-"));
  const configPath = join(root, ".oxlintrc.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      categories: { correctness: "off" },
      jsPlugins: [join(repoRoot, "lint", "oxlint-plugin-iterate.ts")],
      rules: { [`iterate/${rule}`]: "error" },
    }),
  );
  return {
    [Symbol.dispose]() {
      rmSync(root, { force: true, recursive: true });
    },
    write(contents: string) {
      writeFileSync(join(root, "input.test.ts"), contents);
    },
    reportedLines() {
      const result = spawnSync(
        join(repoRoot, "node_modules", ".bin", "oxlint"),
        ["input.test.ts", "--config", configPath, "--threads", "1", "--format", "json"],
        { cwd: root, encoding: "utf8" },
      );
      const { diagnostics } = JSON.parse(result.stdout) as {
        diagnostics: { code: string; labels: { span: { line: number } }[] }[];
      };
      return diagnostics
        .filter((diagnostic) => diagnostic.code === `iterate(${rule})`)
        .map((diagnostic) => diagnostic.labels[0]!.span.line)
        .sort((a, b) => a - b);
    },
  };
}
