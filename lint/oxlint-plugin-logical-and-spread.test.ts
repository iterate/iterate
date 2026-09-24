// Tests for iterate/prefer-logical-and-spread: object spread treats any falsy
// value like {}, so `...(cond ? obj : {})` is just `...(cond && obj)` with a
// dead empty-object arm. The rule is auto-fixable, and the fix must be
// parse-preserving (parens around `||`/`??`/ternary operands) — most of the
// tests here run the real oxlint binary with --fix and assert the output.

import { expect, test } from "vitest";
import { createOxlintFixture } from "./oxlint-fixture.ts";

test("fixes the basic pattern", () => {
  using fixture = createOxlintFixture({ rules: { "iterate/prefer-logical-and-spread": "error" } });
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

  fixture.run(["--fix", "basic.ts"]);
  expect(fixture.read("basic.ts")).toMatch(/\.\.\.\(f && \{ abc: f\.def \}\),/);
});

test("parenthesizes operands that bind looser than &&", () => {
  using fixture = createOxlintFixture({ rules: { "iterate/prefer-logical-and-spread": "error" } });
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

  fixture.run(["--fix", "precedence.ts"]);
  const fixed = fixture.read("precedence.ts");
  expect(fixed).toMatch(/\.\.\.\(\(a \|\| b\) && \{ x: 1 \}\),/);
  expect(fixed).toMatch(/\.\.\.\(f && \(left \?\? right\)\),/);
});

test("fixes non-literal consequents too", () => {
  using fixture = createOxlintFixture({ rules: { "iterate/prefer-logical-and-spread": "error" } });
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

  fixture.run(["--fix", "reference.ts"]);
  expect(fixture.read("reference.ts")).toMatch(/\.\.\.\(f && f\.extras\),/);
});

test("reports without fixing when the rewrite would drop a comment", () => {
  using fixture = createOxlintFixture({ rules: { "iterate/prefer-logical-and-spread": "error" } });
  const source = [
    "declare const f: { def: string } | undefined;",
    "export const x = {",
    "  ...(f ? /* keep me */ { abc: f.def } : {}),",
    "};",
    "",
  ].join("\n");
  fixture.write("commented.ts", source);

  const result = fixture.run(["--fix", "commented.ts"], { expectFailure: true });
  expect(result.stdout + result.stderr).toMatch(/Spreading a falsy value/);
  expect(fixture.read("commented.ts")).toBe(source);
});

test("leaves non-matching spreads alone", () => {
  using fixture = createOxlintFixture({ rules: { "iterate/prefer-logical-and-spread": "error" } });
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

  fixture.run(["ok.ts"]);
});
