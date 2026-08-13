// Tests for iterate/simple-truthiness-check: don't compare directly to null,
// undefined, or NaN — trust the types and use a truthiness check, with
// Number.isFinite as the escape hatch when 0 is meaningful. The rule is
// suggestion-only (the rewrite is only equivalent under repo conventions, so a
// human confirms per site); these tests run the real oxlint binary with
// --fix-suggestions, which applies the first (truthiness) suggestion.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

import { test } from "vitest";

test("suggests bare truthiness in boolean contexts", () => {
  using fixture = createOxlintFixture();
  fixture.write(
    "boolean-context.ts",
    [
      "declare const a: string | null;",
      "declare const b: { x: number } | undefined;",
      "if (a !== null) console.log(a);",
      "if (a === null) console.log('empty');",
      "if (b != null) console.log(b.x);",
      "while (a !== undefined) console.log(a);",
      "console.log(b !== undefined ? b.x : 0);",
      "",
    ].join("\n"),
  );

  fixture.runOxlint(["--fix-suggestions", "boolean-context.ts"]);
  assert.equal(
    fixture.read("boolean-context.ts"),
    [
      "declare const a: string | null;",
      "declare const b: { x: number } | undefined;",
      "if (a) console.log(a);",
      "if (!a) console.log('empty');",
      "if (b) console.log(b.x);",
      "while (a) console.log(a);",
      "console.log(b ? b.x : 0);",
      "",
    ].join("\n"),
  );
});

test("suggests !! where the boolean value itself is consumed", () => {
  using fixture = createOxlintFixture();
  fixture.write(
    "boolean-value.ts",
    [
      "declare const a: string | undefined;",
      "export const present = a !== undefined;",
      "export const absent = a === undefined;",
      "export const fed = (a !== undefined) && 'yes';",
      "",
    ].join("\n"),
  );

  fixture.runOxlint(["--fix-suggestions", "boolean-value.ts"]);
  assert.equal(
    fixture.read("boolean-value.ts"),
    [
      "declare const a: string | undefined;",
      "export const present = !!a;",
      "export const absent = !a;",
      "export const fed = (!!a) && 'yes';",
      "",
    ].join("\n"),
  );
});

test("offers Number.isFinite as the second suggestion for 0-is-meaningful sites", () => {
  using fixture = createOxlintFixture();
  fixture.write(
    "numbers.ts",
    ["declare const n: number | undefined;", "if (n == null) console.log('no n');", ""].join("\n"),
  );

  const result = fixture.runOxlint(["numbers.ts"], { expectFailure: true });
  assert.match(result.stdout + result.stderr, /!Number\.isFinite\(n\)/);
});

test("collapses the dual null-and-undefined check into one report and fix", () => {
  using fixture = createOxlintFixture();
  fixture.write(
    "dual.ts",
    [
      "declare const r: { id: string } | null | undefined;",
      "if (r !== null && r !== undefined) console.log(r.id);",
      "export const missing = r === null || r === undefined;",
      "",
    ].join("\n"),
  );

  fixture.runOxlint(["--fix-suggestions", "dual.ts"]);
  assert.equal(
    fixture.read("dual.ts"),
    [
      "declare const r: { id: string } | null | undefined;",
      "if (r) console.log(r.id);",
      "export const missing = !r;",
      "",
    ].join("\n"),
  );
});

test("parenthesizes operands that bind looser than !", () => {
  using fixture = createOxlintFixture();
  fixture.write(
    "parens.ts",
    [
      "declare const a: string | null, b: string | null;",
      "declare function pick(): string | undefined;",
      "export const neither = (a ?? b) === null;",
      "if (pick() != null) console.log('picked');",
      "",
    ].join("\n"),
  );

  fixture.runOxlint(["--fix-suggestions", "parens.ts"]);
  assert.equal(
    fixture.read("parens.ts"),
    [
      "declare const a: string | null, b: string | null;",
      "declare function pick(): string | undefined;",
      "export const neither = !(a ?? b);",
      "if (pick()) console.log('picked');",
      "",
    ].join("\n"),
  );
});

test("NaN comparisons suggest Number.isNaN", () => {
  using fixture = createOxlintFixture();
  fixture.write(
    "nan.ts",
    [
      "declare const n: number;",
      "if (n === NaN) console.log('never true');",
      "if (n !== NaN) console.log('always true');",
      "",
    ].join("\n"),
  );

  fixture.runOxlint(["--fix-suggestions", "nan.ts"]);
  assert.equal(
    fixture.read("nan.ts"),
    [
      "declare const n: number;",
      "if (Number.isNaN(n)) console.log('never true');",
      "if (!Number.isNaN(n)) console.log('always true');",
      "",
    ].join("\n"),
  );
});

test("handles yoda comparisons", () => {
  using fixture = createOxlintFixture();
  fixture.write(
    "yoda.ts",
    ["declare const a: string | null;", "if (null !== a) console.log(a);", ""].join("\n"),
  );

  fixture.runOxlint(["--fix-suggestions", "yoda.ts"]);
  assert.match(fixture.read("yoda.ts"), /if \(a\) console\.log\(a\);/);
});

test("leaves non-nullish comparisons alone", () => {
  using fixture = createOxlintFixture();
  fixture.write(
    "ok.ts",
    [
      "declare const a: string, n: number, u: unknown;",
      "export const checks = [",
      "  a === 'x',",
      "  n === 0,",
      "  n <= 0,",
      "  u === u,",
      "  null === undefined,", // dead code, but not a truthiness check in disguise
      "  a,",
      "  !a,",
      "];",
      "",
    ].join("\n"),
  );

  fixture.runOxlint(["ok.ts"]);
});

const repoRoot = resolve(import.meta.dirname, "..");
const pluginPath = join(repoRoot, "lint", "oxlint-plugin-iterate.ts");
const oxlintBin = join(repoRoot, "node_modules", ".bin", "oxlint");

/** Same fixture shape as oxlint-plugin-logical-and-spread.test.ts: a temp
 * project with the real plugin armed, linted by the real oxlint binary. */
function createOxlintFixture() {
  const root = mkdtempSync(join(tmpdir(), "iterate-oxlint-simple-truthiness-"));
  const configPath = join(root, ".oxlintrc.json");

  writeFileSync(
    configPath,
    JSON.stringify(
      {
        categories: {
          correctness: "off",
          nursery: "off",
          pedantic: "off",
          perf: "off",
          restriction: "off",
          style: "off",
          suspicious: "off",
        },
        env: {
          builtin: true,
          node: true,
        },
        jsPlugins: [pluginPath],
        rules: { "iterate/simple-truthiness-check": "error" },
      },
      null,
      2,
    ),
  );

  return {
    root,
    [Symbol.dispose]() {
      rmSync(root, { force: true, recursive: true });
    },
    read(path: string) {
      return readFileSync(join(root, path), "utf8");
    },
    runOxlint(args: string[], options: { expectFailure?: boolean } = {}) {
      const result = spawnSync(
        oxlintBin,
        [...args, "--config", configPath, "--threads", "1", "--format", "stylish"],
        { cwd: root, encoding: "utf8" },
      );
      if (options.expectFailure) {
        assert.notEqual(result.status, 0, result.stderr || result.stdout);
      } else {
        assert.equal(result.status, 0, result.stderr || result.stdout);
      }
      return result;
    },
    write(path: string, contents: string) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), contents);
    },
  };
}
