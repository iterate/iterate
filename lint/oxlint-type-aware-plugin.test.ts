import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

import { SignatureKind } from "@typescript/native-preview/unstable/sync";

import { TypeAwareLintService } from "./oxlint-type-aware.ts";

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

test("mechanical-class-impl allows omitted implementation params", () => {
  using fixture = createOxlintFixture({
    rules: {
      "iterate/mechanical-class-impl": "error",
      "iterate/typed-no-floating-promises": "off",
    },
  });

  fixture.write(
    "types.ts",
    [
      "export interface IPerson {",
      "  sayHello(): string;",
      '  sayGoodbye(params: { mood: "happy" | "sad" | "neutral" }): string;',
      "}",
    ].join("\n"),
  );
  fixture.write(
    "implementation.ts",
    [
      'import type { IPerson } from "./types.ts";',
      "",
      "class CPerson implements IPerson {",
      "  sayHello(): never {",
      '    throw new Error("Method not implemented.");',
      "  }",
      "  sayGoodbye(): never {",
      '    throw new Error("Method not implemented.");',
      "  }",
      "}",
      "",
    ].join("\n"),
  );

  fixture.runOxlint(["implementation.ts", "--fix"]);

  assert.equal(
    fixture.read("implementation.ts"),
    [
      'import type { IPerson } from "./types.ts";',
      "",
      "class CPerson implements IPerson {",
      "  sayHello(): never {",
      '    throw new Error("Method not implemented.");',
      "  }",
      "  sayGoodbye(): never {",
      '    throw new Error("Method not implemented.");',
      "  }",
      "}",
      "",
    ].join("\n"),
  );
});

test("mechanical-class-impl allows simple implementation param types", () => {
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
      "  setName(name: string): void;",
      "  setEnabled(enabled: boolean): void;",
      "  setScores(scores: number[]): void;",
      "}",
    ].join("\n"),
  );
  fixture.write(
    "implementation.ts",
    [
      'import type { Greeter } from "./types.ts";',
      "",
      "class MyGreeter implements Greeter {",
      "  setName(name: string) {",
      "  }",
      "  setEnabled(enabled: boolean) {",
      "  }",
      "  setScores(scores: number[]) {",
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
      "  setName(name: string) {",
      "  }",
      "  setEnabled(enabled: boolean) {",
      "  }",
      "  setScores(scores: number[]) {",
      "  }",
      "}",
      "",
    ].join("\n"),
  );
});

test("mechanical-class-impl fixes class field arrow implementations", () => {
  using fixture = createOxlintFixture({
    rules: {
      "iterate/mechanical-class-impl": "error",
      "iterate/typed-no-floating-promises": "off",
    },
  });

  fixture.write(
    "types.ts",
    [
      "export interface IPerson {",
      '  sayGoodbye(params: { mood: "happy" | "sad" | "neutral" }): string;',
      "}",
    ].join("\n"),
  );
  fixture.write(
    "implementation.ts",
    [
      'import type { IPerson } from "./types.ts";',
      "",
      "class CPerson implements IPerson {",
      "  sayGoodbye = (_params: any): string => {",
      '    return "bye";',
      "  };",
      "}",
      "",
    ].join("\n"),
  );

  fixture.runOxlint(["implementation.ts", "--fix"]);

  assert.equal(
    fixture.read("implementation.ts"),
    [
      'import type { IPerson } from "./types.ts";',
      "",
      "class CPerson implements IPerson {",
      '  sayGoodbye = (_params: Parameters<IPerson["sayGoodbye"]>[0]) => {',
      '    return "bye";',
      "  };",
      "}",
      "",
    ].join("\n"),
  );
});

test("type-aware lint service refreshes changed files without restarting the process", () => {
  using fixture = createOxlintFixture({
    rules: {
      "iterate/mechanical-class-impl": "error",
      "iterate/typed-no-floating-promises": "off",
    },
  });
  const service = new TypeAwareLintService({ cwd: fixture.root });
  using _service = { [Symbol.dispose]: () => service.close() };
  const firstSource = [
    "interface Foo {}",
    "",
    "export class Bar implements Foo {",
    "  f(a: 1): void {",
    "    console.log(a);",
    "  }",
    "}",
    "",
  ].join("\n");
  fixture.write("implementation.ts", firstSource);

  const firstProperties = getCallablePropertyNames(
    service,
    join(fixture.root, "implementation.ts"),
    "Foo",
    firstSource.indexOf("Foo {"),
  );

  assert.deepEqual(firstProperties, []);

  const secondSource = [
    "interface Foo {",
    "  f(a: 1): void;",
    "}",
    "",
    "export class Bar implements Foo {",
    "  f(a: 1): void {",
    "    console.log(a);",
    "  }",
    "}",
    "",
  ].join("\n");
  fixture.write("implementation.ts", secondSource);

  const secondProperties = getCallablePropertyNames(
    service,
    join(fixture.root, "implementation.ts"),
    "Foo",
    secondSource.indexOf("Foo {"),
  );

  assert.deepEqual(secondProperties, ["f"]);
});

test("type-aware lint service can read unsaved text overlays", () => {
  using fixture = createOxlintFixture({
    rules: {
      "iterate/mechanical-class-impl": "error",
      "iterate/typed-no-floating-promises": "off",
    },
  });
  const service = new TypeAwareLintService({ cwd: fixture.root });
  using _service = { [Symbol.dispose]: () => service.close() };
  const fileName = join(fixture.root, "implementation.ts");
  const savedSource = [
    "interface Foo {}",
    "",
    "export class Bar implements Foo {",
    "  f(a: 1): void {",
    "    console.log(a);",
    "  }",
    "}",
    "",
  ].join("\n");
  fixture.write("implementation.ts", savedSource);

  const firstProperties = getCallablePropertyNames(
    service,
    fileName,
    "Foo",
    savedSource.indexOf("Foo {"),
  );

  assert.deepEqual(firstProperties, []);

  const unsavedSource = [
    "interface Foo {",
    "  f(a: 1): void;",
    "}",
    "",
    "export class Bar implements Foo {",
    "  f(a: 1): void {",
    "    console.log(a);",
    "  }",
    "}",
    "",
  ].join("\n");
  service.setFileText(fileName, unsavedSource);

  const secondProperties = getCallablePropertyNames(
    service,
    fileName,
    "Foo",
    unsavedSource.indexOf("Foo {"),
  );

  assert.deepEqual(secondProperties, ["f"]);
  assert.equal(fixture.read("implementation.ts"), savedSource);
});

test("mechanical-class-impl reports only the method params when params are not mechanical", () => {
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
  const implementation = [
    'import type { Greeter } from "./types.ts";',
    "",
    "class MyGreeter implements Greeter {",
    "  getGreeting(input: { enthusiasm: number }): string {",
    '    return "hello";',
    "  }",
    "}",
    "",
  ].join("\n");
  fixture.write("implementation.ts", implementation);

  const result = fixture.runOxlint(["implementation.ts"], {
    expectFailure: true,
    format: "json",
  });
  const output = JSON.parse(result.stdout);
  const span = output.diagnostics[0].labels[0].span;
  const reportedText = implementation.slice(span.offset, span.offset + span.length);

  assert.equal(reportedText, "input: { enthusiasm: number }");
});

test("mechanical-class-impl reports only the return type when return type is disallowed", () => {
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
  const implementation = [
    'import type { Greeter } from "./types.ts";',
    "",
    "class MyGreeter implements Greeter {",
    '  getGreeting(input: Parameters<Greeter["getGreeting"]>[0]): string {',
    '    return "hello";',
    "  }",
    "}",
    "",
  ].join("\n");
  fixture.write("implementation.ts", implementation);

  const result = fixture.runOxlint(["implementation.ts"], {
    expectFailure: true,
    format: "json",
  });
  const output = JSON.parse(result.stdout);
  const span = output.diagnostics[0].labels[0].span;
  const reportedText = implementation.slice(span.offset, span.offset + span.length);

  assert.equal(reportedText, ": string");
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

function getCallablePropertyNames(
  service: TypeAwareLintService,
  fileName: string,
  name: string,
  position: number,
) {
  const fileService = service.getFileService(fileName);
  const typed = fileService.resolveTypeByName(name, position);
  if (!typed) return undefined;
  const project = fileService.project;
  if (!project) return undefined;
  return project.checker
    .getPropertiesOfType(typed.type)
    .filter((property) => {
      const propertyType = project.checker.getTypeOfSymbol(property);
      if (!propertyType) return false;
      return project.checker.getSignaturesOfType(propertyType, SignatureKind.Call).length > 0;
    })
    .map((property) => property.name);
}

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
    runOxlint(args: string[], options: { expectFailure?: boolean; format?: string } = {}) {
      const result = spawnSync(
        oxlintBin,
        [
          ...args,
          "--config",
          configPath,
          "--threads",
          "1",
          "--format",
          options.format || "stylish",
        ],
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
