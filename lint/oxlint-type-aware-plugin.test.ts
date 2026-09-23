import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

import { SignatureKind } from "@typescript/native-preview/unstable/sync";
import { test } from "vitest";

import { TypeAwareLintService } from "./oxlint-type-aware.ts";

const repoRoot = resolve(import.meta.dirname, "..");
const pluginPath = join(repoRoot, "lint", "oxlint-plugin-iterate.ts");
const oxlintBin = join(repoRoot, "node_modules", ".bin", "oxlint");

test("type-aware lint service refreshes changed files without restarting the process", () => {
  using fixture = createOxlintFixture({ rules: {} });
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

test("type-aware lint service keeps all open files in snapshot updates", () => {
  using fixture = createOxlintFixture({ rules: {} });
  const service = new TypeAwareLintService({ cwd: fixture.root });
  using _service = { [Symbol.dispose]: () => service.close() };
  const firstFile = join(fixture.root, "first.ts");
  const secondFile = join(fixture.root, "second.ts");
  const tsconfigFile = join(fixture.root, "tsconfig.json");
  const updates: NonNullable<Parameters<TypeAwareLintService["updateSnapshot"]>[0]>[] = [];
  service.updateSnapshot = (params) => {
    if (!params) throw new Error("Expected snapshot update params");
    updates.push(params);
  };

  service.openFile(firstFile);
  service.openFile(secondFile);

  assert.deepEqual(
    updates.map((update) => update.openFiles),
    [[firstFile], [firstFile, secondFile]],
  );
  assert.deepEqual(
    updates.map((update) => update.openProjects),
    [[tsconfigFile], [tsconfigFile]],
  );
});

test("type-aware lint service can read unsaved text overlays", () => {
  using fixture = createOxlintFixture({ rules: {} });
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

test("typed-no-floating-promises reports only unhandled promise-like expression statements", () => {
  using fixture = createOxlintFixture({
    rules: {
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
  if (!fileService) return undefined;
  const typed = fileService.resolveTypeByName(name, position);
  if (!typed) return undefined;
  return fileService.project.checker
    .getPropertiesOfType(typed.type)
    .filter((property) => {
      const propertyType = fileService.project.checker.getTypeOfSymbol(property);
      if (!propertyType) return false;
      return (
        fileService.project.checker.getSignaturesOfType(propertyType, SignatureKind.Call).length > 0
      );
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
