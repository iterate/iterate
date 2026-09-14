import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { RuleTester } from "oxlint/plugins-dev";
import { simpleTruthinessCheckRule } from "./rules/simple-truthiness-check.ts";
import { getTypeAwareLintService } from "./oxlint-type-aware.ts";

test("reports optional properties hidden behind conditional spreads without autofixing", () => {
  using fixture = createFixture();
  const source = `
    declare const input: { foo?: string };
    export const obj = { ...(input.foo !== undefined && { foo: input.foo }) };
  `;
  fixture.write(source);
  const result = fixture.lint(["--fix"]);
  expect(result).toMatchObject({ status: 1 });
  expect(result.stdout).toContain("Write the property directly");
  expect(fixture.read()).toBe(source);
});

test("trusts optional strings, arrays and objects, but preserves zero, false and unknown inputs", () => {
  using fixture = createFixture();
  fixture.write(`
    declare const input: {
      label?: string; items?: string[]; object?: { name: string };
      count?: number; enabled?: boolean; mixed?: string | number; raw: unknown;
    };
    export const checks = [
      input.label !== undefined,
      input.items != null,
      null === input.object,
      input.label ?? "Default",
      input.items ?? [],
      input.object ?? { name: "Default" },
      Array.isArray(input.items),
      input.count !== undefined,
      input.enabled !== undefined,
      input.mixed ?? "Default",
      input.count ?? 42,
      input.enabled ?? true,
      Array.isArray(input.raw),
      input.raw !== null,
    ];
  `);
  const result = fixture.lint([]);
  expect(result).toMatchObject({ status: 1 });
  const diagnostics = JSON.parse(result.stdout).diagnostics;
  expect(diagnostics).toHaveLength(7);
  expect(diagnostics.map((item: any) => item.message)).toEqual([
    ...Array(3).fill(expect.stringContaining("truthiness")),
    ...Array(3).fill(expect.stringContaining("Use ||")),
    expect.stringContaining("already an array"),
  ]);
});

test("reports ternary omission, typed typeof guards and nullish assignment", () => {
  using fixture = createFixture();
  fixture.write(`
    declare let input: { foo?: string; items?: string[] };
    export const a = { ...(input.foo ? { foo: input.foo } : {}) };
    export const b = { ...(input.foo == null ? {} : { foo: input.foo }) };
    export const c = typeof input.foo === "string";
    export const d = typeof input.items !== "undefined";
    input.foo ??= "Default";
  `);
  const result = fixture.lint([]);
  expect(JSON.parse(result.stdout).diagnostics).toHaveLength(5);
});

test("checks new and edited lines while grandfathering old violations at the inclusive cutoff", () => {
  using fixture = createFixture();
  const date = "2026-09-11T00:00:00Z";
  fixture.git(["init", "--quiet"], date);
  fixture.write(`declare const input: { foo?: string };
export const old = { ...(input.foo && { foo: input.foo }) };
`);
  fixture.git(["add", "."], date);
  fixture.git(["commit", "--quiet", "-m", "Old code"], date);
  expect(fixture.lint([])).toMatchObject({ status: 0 });
  fixture.write(`// Shift old code without changing its age.
${fixture.read()}export const fresh = { ...(input.foo && { foo: input.foo }) };
`);
  const uncommitted = JSON.parse(fixture.lint([]).stdout).diagnostics;
  expect(uncommitted).toHaveLength(1);
  fixture.git(["add", "."], "2026-09-11T01:00:00Z");
  fixture.git(["commit", "--quiet", "-m", "New code"], "2026-09-11T01:00:00Z");
  expect(JSON.parse(fixture.lint([]).stdout).diagnostics).toHaveLength(1);
});

test("leaves real type discrimination and conditional computation alone", () => {
  using fixture = createFixture();
  fixture.write(`
    declare const value: string | { name: string } | undefined;
    declare const callable: (() => void) | { name: string } | undefined;
    declare const input: { foo?: string; items?: string[] };
    declare const raw: any;
    declare const arrayLike: ArrayLike<string>;
    export const checks = [typeof value === "string", typeof value === "object", typeof callable === "object", Array.isArray(raw), Array.isArray(arrayLike)];
    export const a = { ...(input.foo && { foo: input.foo.trim() }) };
    export const b = { ...(input.foo === undefined && { foo: input.foo }) };
    export const c = { ...(input.foo && { foo: "constant" }) };
    export const d = { ...(input.foo ? { foo: input.foo } : { foo: "default" }) };
  `);
  const diagnostics = JSON.parse(fixture.lint([]).stdout).diagnostics;
  // The explicit undefined check in b is still a typed truthiness report,
  // but b is not an optional-property omission pattern.
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0].message).toContain("truthiness");
});

test("does not mistake shadowed globals for built-in checks", () => {
  using fixture = createFixture();
  fixture.write(`
    export function check(Array: { isArray(value: string[]): boolean }, undefined: string) {
      const items: string[] = [];
      const name = "foo";
      return [Array.isArray(items), name === undefined];
    }
  `);
  expect(fixture.lint([])).toMatchObject({ status: 0 });
});

test("checks unsaved editor text rather than the file on disk", () => {
  using fixture = createFixture();
  const tester = new RuleTester({ cwd: fixture.root });
  const filename = join(fixture.root, "input.ts");
  const check = (code: string, errors: number) =>
    tester.run("simple-truthiness-check", simpleTruthinessCheckRule as any, {
      valid: [],
      invalid: [{ filename, code, errors }],
    });
  try {
    check(
      'declare const input: { label?: string }; export const label = input.label ?? "Default";',
      1,
    );
    fixture.write(
      "declare const input: { label?: number }; export const label = input.label ?? 42;",
    );
    check(
      'declare const input: { label?: string }; export const label = input.label ?? "Default";',
      1,
    );
  } finally {
    getTypeAwareLintService({ cwd: fixture.root }).close();
  }
});

test("accepts direct properties and truthy fallbacks; checks readonly arrays and tuples", () => {
  using fixture = createFixture();
  fixture.write(`
    declare const input: { foo?: string; items?: readonly string[]; pair?: [string, number] };
    export const obj = { foo: input.foo };
    export const label = input.foo || "Default";
    export const items = input.items || [];
    export const checks = [Array.isArray(input.items), Array.isArray(input.pair)];
  `);
  const diagnostics = JSON.parse(fixture.lint([]).stdout).diagnostics;
  expect(diagnostics).toHaveLength(2);
  expect(diagnostics.every((item: any) => item.message.includes("already an array"))).toBe(true);
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "iterate-truthiness-"));
  const repo = resolve(import.meta.dirname, "..");
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { strict: true, target: "ESNext", noEmit: true },
      include: ["*.ts"],
    }),
  );
  writeFileSync(
    join(root, ".oxlintrc.json"),
    JSON.stringify({
      categories: { correctness: "off" },
      jsPlugins: [join(repo, "lint/oxlint-plugin-iterate.ts")],
      rules: { "iterate/simple-truthiness-check": "error" },
    }),
  );
  return {
    root,
    [Symbol.dispose]() {
      rmSync(root, { recursive: true, force: true });
    },
    write(source: string) {
      writeFileSync(join(root, "input.ts"), source);
    },
    read() {
      return readFileSync(join(root, "input.ts"), "utf8");
    },
    lint(args: string[]) {
      return spawnSync(
        join(repo, "node_modules/.bin/oxlint"),
        ["input.ts", "--threads", "1", "--format", "json", ...args],
        { cwd: root, encoding: "utf8" },
      );
    },
    git(args: string[], date: string) {
      execFileSync("git", args, {
        cwd: root,
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: date,
          GIT_COMMITTER_DATE: date,
          GIT_AUTHOR_NAME: "Test",
          GIT_AUTHOR_EMAIL: "test@iterate.com",
          GIT_COMMITTER_NAME: "Test",
          GIT_COMMITTER_EMAIL: "test@iterate.com",
        },
      });
    },
  };
}
