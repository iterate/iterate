import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

const repoRoot = resolve(import.meta.dirname, "..");
const pluginPath = join(repoRoot, "oxlint-plugin-iterate.js");
const oxlintBin = join(repoRoot, "node_modules", ".bin", "oxlint");

test("mechanical-class-impl fixes implementation signatures from the TypeScript checker", () => {
  using fixture = createOxlintFixture({
    rules: {
      "iterate/mechanical-class-impl": "error",
      "iterate/typed-no-floating-promises": "off",
    },
  });

  fixture.write(
    "types.ts",
    [
      "export type Mechanical<T> = T;",
      "export interface Greeter {",
      "  getGreeting(params: { enthusiasm: number }): string;",
      "  getFarewell(politeness: number, enthusiasm: number): void;",
      "}",
    ].join("\n"),
  );
  fixture.write(
    "implementation.ts",
    [
      'import type { Greeter, Mechanical } from "./types.ts";',
      "",
      "class MyGreeter implements Mechanical<Greeter> {",
      "  getGreeting(input: { enthusiasm: number }): string {",
      '    return "hello";',
      "  }",
      "",
      "  getFarewell(politeness: number, enthusiasm: number): void {",
      "  }",
      "}",
      "",
    ].join("\n"),
  );

  fixture.runOxlint(["implementation.ts", "--fix"]);

  assert.equal(
    fixture.read("implementation.ts"),
    [
      'import type { Greeter, Mechanical } from "./types.ts";',
      "",
      "class MyGreeter implements Mechanical<Greeter> {",
      '  getGreeting(input: Parameters<Greeter["getGreeting"]>[0]) {',
      '    return "hello";',
      "  }",
      "",
      '  getFarewell(...[politeness, enthusiasm]: Parameters<Greeter["getFarewell"]>) {',
      "  }",
      "}",
      "",
    ].join("\n"),
  );
});

test("mechanical-class-impl reads methods from mapped helper implementations", () => {
  using fixture = createOxlintFixture({
    rules: {
      "iterate/mechanical-class-impl": "error",
      "iterate/typed-no-floating-promises": "off",
    },
  });

  fixture.write(
    "types.ts",
    [
      "export type MechanicalMap<T> = {",
      "  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => R : T[K];",
      "};",
      "export interface Greeter {",
      "  getGreeting(params: { enthusiasm: number }): string;",
      "}",
    ].join("\n"),
  );
  fixture.write(
    "implementation.ts",
    [
      'import type { Greeter, MechanicalMap } from "./types.ts";',
      "",
      "class MyGreeter implements MechanicalMap<Greeter> {",
      "  getGreeting(input: { enthusiasm: number }): string {",
      '    return "hello";',
      "  }",
      "}",
      "",
    ].join("\n"),
  );

  fixture.runOxlint(["implementation.ts", "--fix"]);

  assert.equal(
    fixture.read("implementation.ts"),
    [
      'import type { Greeter, MechanicalMap } from "./types.ts";',
      "",
      "class MyGreeter implements MechanicalMap<Greeter> {",
      '  getGreeting(input: Parameters<Greeter["getGreeting"]>[0]) {',
      '    return "hello";',
      "  }",
      "}",
      "",
    ].join("\n"),
  );
});

test("mechanical-class-impl supports direct interface implementations", () => {
  using fixture = createOxlintFixture({
    rules: {
      "iterate/mechanical-class-impl": "error",
      "iterate/typed-no-floating-promises": "off",
    },
  });

  fixture.write(
    "types.ts",
    [
      "export interface Greeter {",
      "  getGreeting(params: { enthusiasm: number }): string;",
      "}",
    ].join("\n"),
  );
  fixture.write(
    "implementation.ts",
    [
      'import type { Greeter } from "./types.ts";',
      "",
      "class MyGreeter implements Greeter {",
      "  getGreeting(input: { enthusiasm: number }): string {",
      '    return "hello";',
      "  }",
      "}",
      "",
    ].join("\n"),
  );

  fixture.runOxlint(["implementation.ts", "--fix"]);

  assert.equal(
    fixture.read("implementation.ts"),
    [
      'import type { Greeter } from "./types.ts";',
      "",
      "class MyGreeter implements Greeter {",
      '  getGreeting(input: Parameters<Greeter["getGreeting"]>[0]) {',
      '    return "hello";',
      "  }",
      "}",
      "",
    ].join("\n"),
  );
});

test("mechanical-class-impl follows arbitrary helper wrappers", () => {
  using fixture = createOxlintFixture({
    rules: {
      "iterate/mechanical-class-impl": "error",
      "iterate/typed-no-floating-promises": "off",
    },
  });

  fixture.write(
    "types.ts",
    [
      "export type MechanicalMap<T> = {",
      "  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => R : T[K];",
      "};",
      "export interface Greeter {",
      "  getGreeting(params: { enthusiasm: number }): string;",
      "}",
    ].join("\n"),
  );
  fixture.write(
    "implementation.ts",
    [
      'import type { Greeter, MechanicalMap } from "./types.ts";',
      "",
      "class MyGreeter implements MechanicalMap<Greeter> {",
      "  getGreeting(input: { enthusiasm: number }): string {",
      '    return "hello";',
      "  }",
      "}",
      "",
    ].join("\n"),
  );

  fixture.runOxlint(["implementation.ts", "--fix"]);

  assert.equal(
    fixture.read("implementation.ts"),
    [
      'import type { Greeter, MechanicalMap } from "./types.ts";',
      "",
      "class MyGreeter implements MechanicalMap<Greeter> {",
      '  getGreeting(input: Parameters<Greeter["getGreeting"]>[0]) {',
      '    return "hello";',
      "  }",
      "}",
      "",
    ].join("\n"),
  );
});

test("mechanical-class-impl preserves defaults in nested helper implementations", () => {
  using fixture = createOxlintFixture({
    rules: {
      "iterate/mechanical-class-impl": "error",
      "iterate/typed-no-floating-promises": "off",
    },
  });

  fixture.write(
    "types.ts",
    [
      "export type Mechanical<T> = T;",
      "export interface Greeter {",
      "  getGreeting(params: { enthusiasm: number }): string;",
      "}",
    ].join("\n"),
  );
  fixture.write(
    "implementation.ts",
    [
      'import type { Greeter, Mechanical } from "./types.ts";',
      "",
      "const defaultInput = { enthusiasm: 1 };",
      "",
      'class MyGreeter implements Pick<Mechanical<Greeter>, "getGreeting"> {',
      "  getGreeting(input: { enthusiasm: number } = defaultInput): string {",
      '    return "hello";',
      "  }",
      "}",
      "",
    ].join("\n"),
  );

  fixture.runOxlint(["implementation.ts", "--fix"]);

  assert.equal(
    fixture.read("implementation.ts"),
    [
      'import type { Greeter, Mechanical } from "./types.ts";',
      "",
      "const defaultInput = { enthusiasm: 1 };",
      "",
      'class MyGreeter implements Pick<Mechanical<Greeter>, "getGreeting"> {',
      '  getGreeting(input: Parameters<Greeter["getGreeting"]>[0] = defaultInput) {',
      '    return "hello";',
      "  }",
      "}",
      "",
    ].join("\n"),
  );
});

test("typed-no-floating-promises reports only unhandled promise-like expression statements", () => {
  using fixture = createOxlintFixture({
    rules: {
      "iterate/mechanical-class-impl": "off",
      "iterate/typed-no-floating-promises": "error",
    },
  });

  fixture.write(
    "promises.ts",
    [
      "async function returnsPromise(): Promise<void> {}",
      "",
      "returnsPromise();",
      "void returnsPromise();",
      "await returnsPromise();",
      "returnsPromise().catch(() => {});",
      "",
    ].join("\n"),
  );

  const result = fixture.runOxlint(["promises.ts"], { expectFailure: true });
  const output = result.stdout + result.stderr;

  assert.match(output, /Promise-like expression/);
  assert.match(output, /promises\.ts/);
  assert.match(output, /3:1/);
  assert.doesNotMatch(output, /4:1/);
  assert.doesNotMatch(output, /5:1/);
  assert.doesNotMatch(output, /6:1/);
});

function createOxlintFixture(input: { rules: Record<string, unknown> }) {
  const root = mkdtempSync(join(tmpdir(), "iterate-oxlint-type-aware-"));
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
        rules: input.rules,
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          lib: ["ES2022"],
          module: "ESNext",
          moduleResolution: "Bundler",
          noEmit: true,
          strict: true,
          target: "ES2022",
        },
        include: ["*.ts"],
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
        {
          cwd: root,
          encoding: "utf8",
        },
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
