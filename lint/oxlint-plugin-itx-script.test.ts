// Tests for iterate/itx-script-fn-self-contained: the function argument of
// ItxScriptBuilder's .execute()/.define() ships as compiled source into a
// server-side isolate, so it must not reference test-file bindings and must
// not contain `using` declarations (the test-file transform downlevels those
// into module-scope helpers that only exist in the test isolate).
//
// Scope of the implementation (deliberate, proportionate): a scope-walk over
// the function's unresolved references (`scope.through`) plus a `using`
// declaration scan. References that the configured lint env resolves as
// globals (node/builtin) are allowed — the rule's job is catching test-file
// captures and downlevel-hazard syntax, not re-modeling the workerd global
// surface. Anything subtler is the runtime guard's job
// (assertSelfContainedScriptSource in itx-script-builder.ts).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

import { test } from "vitest";

test("flags test-file bindings captured by an .execute() function", () => {
  using fixture = createOxlintFixture();
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

  const result = fixture.runOxlint(["capture.ts"], { expectFailure: true });
  const output = result.stdout + result.stderr;
  assert.match(output, /`marker` is captured from outside the script function/);
  assert.match(output, /\.vars\(\{\.\.\.\}\)/);
});

test("flags captures inside .define() and inside nested functions", () => {
  using fixture = createOxlintFixture();
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

  const result = fixture.runOxlint(["nested.ts"], { expectFailure: true });
  assert.match(result.stdout + result.stderr, /`outer` is captured/);
});

test("flags `using` (and `await using`) declarations in script functions", () => {
  using fixture = createOxlintFixture();
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

  const result = fixture.runOxlint(["using.ts"], { expectFailure: true });
  const output = result.stdout + result.stderr;
  assert.match(output, /`using` inside a typed script function downlevels/);
  assert.match(output, /executeSource\(\)/);
});

test("allows self-contained functions: params, locals, globals, and type-only references", () => {
  using fixture = createOxlintFixture();
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

  fixture.runOxlint(["clean.ts"]);
});

test("ignores functions passed to unrelated methods and non-function arguments", () => {
  using fixture = createOxlintFixture();
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

  fixture.runOxlint(["unrelated.ts"]);
});

const repoRoot = resolve(import.meta.dirname, "..");
const pluginPath = join(repoRoot, "lint", "oxlint-plugin-iterate.ts");
const oxlintBin = join(repoRoot, "node_modules", ".bin", "oxlint");

/** Same fixture shape as oxlint-type-aware-plugin.test.ts: a temp project
 * with the real plugin armed, linted by the real oxlint binary. */
function createOxlintFixture() {
  const root = mkdtempSync(join(tmpdir(), "iterate-oxlint-itx-script-"));
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
        rules: { "iterate/itx-script-fn-self-contained": "error" },
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
