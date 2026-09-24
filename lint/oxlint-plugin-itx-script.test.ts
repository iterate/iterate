// Tests for iterate/itx-script-fn-self-contained: the function argument of
// ItxScriptBuilder's .execute()/.define() ships as compiled source into a
// server-side isolate, so it must not reference test-file bindings and must
// not contain `using` declarations (the test-file transform downlevels those
// into module-scope helpers that only exist in the test isolate).
//
// Scope of the implementation (deliberate, proportionate): a scope-walk over
// the function's unresolved references (`scope.through`) plus a `using`
// declaration scan. oxlint leaves every global unresolved, so the rule
// allowlists the script isolate's globals by name (SCRIPT_ISOLATE_GLOBALS) —
// its job is catching test-file captures and downlevel-hazard syntax, not
// re-modeling the workerd global surface.

import { expect, test } from "vitest";
import { createOxlintFixture } from "./oxlint-fixture.ts";

test("flags test-file bindings captured by an .execute() function", () => {
  using fixture = createOxlintFixture({
    rules: { "iterate/itx-script-fn-self-contained": "error" },
  });
  fixture.write(
    "capture.ts",
    [
      "const marker = crypto.randomUUID();",
      "declare const builder: { execute(fn: (itx: unknown, vars: {}) => Promise<unknown>): Promise<unknown> };",
      "export const run = builder.execute(async (itx, vars) => {",
      "  return { itx, vars, marker };",
      "});",
      "",
    ].join("\n"),
  );

  const result = fixture.run(["capture.ts"], { expectFailure: true });
  const output = result.stdout + result.stderr;
  expect(output).toMatch(/`marker` is captured from outside the script function/);
  expect(output).toMatch(/\.vars\(\{\.\.\.\}\)/);
});

test("flags captures inside .define() and inside nested functions", () => {
  using fixture = createOxlintFixture({
    rules: { "iterate/itx-script-fn-self-contained": "error" },
  });
  fixture.write(
    "nested.ts",
    [
      "const outer = 42;",
      "declare const builder: { define(fn: (itx: unknown) => Promise<unknown>): { code: string } };",
      "export const defined = builder.define(async (itx) => {",
      "  const values = [1, 2, 3].map((n) => n + outer);",
      "  return { itx, values };",
      "});",
      "",
    ].join("\n"),
  );

  const result = fixture.run(["nested.ts"], { expectFailure: true });
  expect(result.stdout + result.stderr).toMatch(/`outer` is captured/);
});

test("flags `using` (and `await using`) declarations in script functions", () => {
  using fixture = createOxlintFixture({
    rules: { "iterate/itx-script-fn-self-contained": "error" },
  });
  fixture.write(
    "using.ts",
    [
      "declare const builder: { execute(fn: (itx: any) => Promise<unknown>): Promise<unknown> };",
      "export const run = builder.execute(async (itx) => {",
      '  using agent = itx.agents.get("/agents/x");',
      "  return await agent.__describe();",
      "});",
      "",
    ].join("\n"),
  );

  const result = fixture.run(["using.ts"], { expectFailure: true });
  const output = result.stdout + result.stderr;
  expect(output).toMatch(/`using` inside a typed script function downlevels/);
  expect(output).toMatch(/executeSource\(\)/);
});

test("allows self-contained functions: params, locals, globals, and type-only references", () => {
  using fixture = createOxlintFixture({
    rules: { "iterate/itx-script-fn-self-contained": "error" },
  });
  fixture.write(
    "clean.ts",
    [
      "type Shape = { note: string };",
      "declare const builder: {",
      "  execute(fn: (itx: unknown, vars: { note: string }) => Promise<unknown>): Promise<unknown>;",
      "};",
      "export const run = builder.execute(async (itx, vars) => {",
      "  const shaped: Shape = { note: vars.note };",
      "  await new Promise((resolveDone) => setTimeout(resolveDone, 5));",
      "  const id = crypto.randomUUID();",
      "  console.log(JSON.stringify({ id, itx }));",
      "  return { ...shaped, id };",
      "});",
      "",
    ].join("\n"),
  );

  fixture.run(["clean.ts"]);
});

test("ignores functions passed to unrelated methods and non-function arguments", () => {
  using fixture = createOxlintFixture({
    rules: { "iterate/itx-script-fn-self-contained": "error" },
  });
  fixture.write(
    "unrelated.ts",
    [
      "const captured = 7;",
      "declare const runner: { start(fn: () => number): number };",
      "export const value = runner.start(() => captured);",
      "declare const builder: { execute(code: string): Promise<unknown> };",
      "export const fromString = builder.execute(`async (itx) => ${captured}`);",
      "",
    ].join("\n"),
  );

  fixture.run(["unrelated.ts"]);
});
