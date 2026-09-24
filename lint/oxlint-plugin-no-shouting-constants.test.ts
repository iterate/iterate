// Tests for iterate/no-shouting-constants: a module-scope SCREAMING_SNAKE
// const that holds a plain literal and is read once is an indirection the
// reader has to chase — the literal belongs inline at its use site. Each test
// runs the real oxlint binary against a temp project with the plugin armed.

import { expect, test } from "vitest";
import { createOxlintFixture } from "./oxlint-fixture.ts";

test("flags single-use number, string, template and negative-number consts", () => {
  using fixture = createOxlintFixture({ rules: { "iterate/no-shouting-constants": "error" } });
  fixture.write(
    "shouting.ts",
    [
      "const MAX_BYTES = 1_000_000;",
      'const GREETING = "hello";',
      "const LABEL = `plain template`;",
      "const FLOOR = -1;",
      "export const sizes = [MAX_BYTES, GREETING.length, LABEL.length, FLOOR];",
      "",
    ].join("\n"),
  );

  const result = fixture.run(["shouting.ts"], { expectFailure: true });
  const output = result.stdout + result.stderr;
  expect(output).toMatch(/MAX_BYTES is a SCREAMING_SNAKE constant holding a plain literal/);
  expect(output).toMatch(/Write the literal inline at its use site/);
  expect(reportedNames(output)).toEqual(["MAX_BYTES", "GREETING", "LABEL", "FLOOR"]);
});

test("leaves exported consts alone", () => {
  using fixture = createOxlintFixture({ rules: { "iterate/no-shouting-constants": "error" } });
  fixture.write(
    "exported.ts",
    [
      "export const PUBLIC_LIMIT = 10;",
      "const REEXPORTED_LIMIT = 20;",
      "export { REEXPORTED_LIMIT };",
      "const DEFAULT_LIMIT = 30;",
      "export default DEFAULT_LIMIT;",
      "export const total = PUBLIC_LIMIT + REEXPORTED_LIMIT + DEFAULT_LIMIT;",
      "",
    ].join("\n"),
  );

  fixture.run(["exported.ts"]);
});

test("leaves non-literal initializers alone", () => {
  using fixture = createOxlintFixture({ rules: { "iterate/no-shouting-constants": "error" } });
  fixture.write(
    "non-literal.ts",
    [
      "declare const region: string;",
      "const HEADERS = { accept: 'application/json' };",
      "const RETRY_DELAYS_MS = [100, 200];",
      "const IS_PROD = () => false;",
      "const SLUG_PATTERN = /^[a-z-]+$/;",
      "const HOST = `https://${region}.example`;",
      'const MODE = "strict" as const;',
      "const STARTED_AT = Date.now();",
      "const SHARED = 5n;",
      "export const bag = [HEADERS, RETRY_DELAYS_MS, IS_PROD, SLUG_PATTERN, HOST, MODE, STARTED_AT, SHARED];",
      "",
    ].join("\n"),
  );

  fixture.run(["non-literal.ts"]);
});

test("leaves consts read more than once alone, counting typeof as a read", () => {
  using fixture = createOxlintFixture({ rules: { "iterate/no-shouting-constants": "error" } });
  fixture.write(
    "multi-use.ts",
    [
      'const EVENT_TYPE = "events.example/thing-happened";',
      "export const first = { type: EVENT_TYPE };",
      "export const second = { type: EVENT_TYPE };",
      'const MODE = "strict";',
      "export type Mode = typeof MODE;",
      "export const mode = MODE;",
      "",
    ].join("\n"),
  );

  fixture.run(["multi-use.ts"]);
});

test("a JSDoc block above the const is an escape hatch; a line comment is not", () => {
  using fixture = createOxlintFixture({ rules: { "iterate/no-shouting-constants": "error" } });
  fixture.write(
    "commented.ts",
    [
      "/** workerd rejects settlements above this size; see the isolate limits doc. */",
      "const MAX_SETTLEMENT_BYTES = 1_000_000;",
      "// this one is just a note",
      "const MAX_SCRIPT_BYTES = 200_000;",
      "export const limits = [MAX_SETTLEMENT_BYTES, MAX_SCRIPT_BYTES];",
      "",
    ].join("\n"),
  );

  const result = fixture.run(["commented.ts"], { expectFailure: true });
  const output = result.stdout + result.stderr;
  expect(reportedNames(output)).toEqual(["MAX_SCRIPT_BYTES"]);
});

test("only module-scope SCREAMING_SNAKE names are in scope", () => {
  using fixture = createOxlintFixture({ rules: { "iterate/no-shouting-constants": "error" } });
  fixture.write(
    "scope.ts",
    [
      "const maxBytes = 1_000_000;",
      "const MaxBytes = 2_000_000;",
      "export function limit() {",
      "  const LOCAL_LIMIT = 3;",
      "  return maxBytes + MaxBytes + LOCAL_LIMIT;",
      "}",
      "",
    ].join("\n"),
  );

  fixture.run(["scope.ts"]);
});

/** Names the rule reported, in source order, pulled from oxlint's stylish output. */
function reportedNames(output: string) {
  return [...output.matchAll(/(\w+) is a SCREAMING_SNAKE constant/g)].map((match) => match[1]);
}
