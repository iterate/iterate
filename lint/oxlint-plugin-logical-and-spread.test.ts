// Tests for iterate/prefer-logical-and-spread: object spread treats any falsy
// value like {}, so `...(cond ? obj : {})` is just `...(cond && obj)` with a
// dead empty-object arm. The rule is auto-fixable, and the fix must be
// parse-preserving (parens around `||`/`??`/ternary operands) — most of the
// tests here run the real oxlint binary with --fix and assert the output.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

import { test } from "vitest";

test("fixes the basic pattern", () => {
  using fixture = createOxlintFixture();
  fixture.write(
    "basic.ts",
    [
      "declare const f: { def: string } | undefined;",
      "export const x = {",
      "  ...(f ? { abc: f.def } : {}),",
      "};",
      "",
    ].join("\n"),
  );

  fixture.runOxlint(["--fix", "basic.ts"]);
  assert.match(fixture.read("basic.ts"), /\.\.\.\(f && \{ abc: f\.def \}\),/);
});

test("parenthesizes operands that bind looser than &&", () => {
  using fixture = createOxlintFixture();
  fixture.write(
    "precedence.ts",
    [
      "declare const a: boolean, b: boolean, f: boolean;",
      "declare const left: object | null, right: object;",
      "export const x = {",
      "  ...(a || b ? { x: 1 } : {}),",
      "  ...(f ? (left ?? right) : {}),",
      "};",
      "",
    ].join("\n"),
  );

  fixture.runOxlint(["--fix", "precedence.ts"]);
  const fixed = fixture.read("precedence.ts");
  assert.match(fixed, /\.\.\.\(\(a \|\| b\) && \{ x: 1 \}\),/);
  assert.match(fixed, /\.\.\.\(f && \(left \?\? right\)\),/);
});

test("fixes non-literal consequents too", () => {
  using fixture = createOxlintFixture();
  fixture.write(
    "reference.ts",
    [
      "declare const f: { extras: object } | undefined;",
      "export const x = {",
      "  ...(f ? f.extras : {}),",
      "};",
      "",
    ].join("\n"),
  );

  fixture.runOxlint(["--fix", "reference.ts"]);
  assert.match(fixture.read("reference.ts"), /\.\.\.\(f && f\.extras\),/);
});

test("reports without fixing when the rewrite would drop a comment", () => {
  using fixture = createOxlintFixture();
  const source = [
    "declare const f: { def: string } | undefined;",
    "export const x = {",
    "  ...(f ? /* keep me */ { abc: f.def } : {}),",
    "};",
    "",
  ].join("\n");
  fixture.write("commented.ts", source);

  const result = fixture.runOxlint(["--fix", "commented.ts"], { expectFailure: true });
  assert.match(result.stdout + result.stderr, /Spreading a falsy value/);
  assert.equal(fixture.read("commented.ts"), source);
});

test("leaves non-matching spreads alone", () => {
  using fixture = createOxlintFixture();
  fixture.write(
    "ok.ts",
    [
      "declare const f: boolean, g: { a: number };",
      "export const objects = {",
      "  ...(f ? { a: 1 } : { b: 2 }),", // both arms meaningful
      "  ...(f ? {} : { a: 1 }),", // mirrored form: fix would add a negation
      "  ...(f && g),", // already idiomatic
      "};",
      "export const array = [...(f ? [1] : [])];", // array spread of falsy throws
      "",
    ].join("\n"),
  );

  fixture.runOxlint(["ok.ts"]);
});

const repoRoot = resolve(import.meta.dirname, "..");
const pluginPath = join(repoRoot, "lint", "oxlint-plugin-iterate.ts");
const oxlintBin = join(repoRoot, "node_modules", ".bin", "oxlint");

/** Same fixture shape as oxlint-plugin-icon-button.test.ts: a temp project
 * with the real plugin armed, linted by the real oxlint binary. */
function createOxlintFixture() {
  const root = mkdtempSync(join(tmpdir(), "iterate-oxlint-logical-and-spread-"));
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
        rules: { "iterate/prefer-logical-and-spread": "error" },
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
