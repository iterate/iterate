import { join } from "node:path";
import { expect, test } from "vitest";
import { RuleTester } from "oxlint/plugins-dev";
import { simpleTruthinessCheckRule } from "./rules/simple-truthiness-check.ts";
import { createOxlintFixture } from "./oxlint-fixture.ts";
import { getTypeAwareLintService } from "./oxlint-type-aware.ts";

test("reports optional properties hidden behind conditional spreads without autofixing", () => {
  using fixture = createOxlintFixture({
    rules: { "iterate/simple-truthiness-check": "error" },
    tsconfig: true,
  });
  const source = `
    declare const input: { foo?: string };
    export const obj = { ...(input.foo !== undefined && { foo: input.foo }) };
  `;
  fixture.write("input.ts", source);
  const result = fixture.run(["input.ts", "--fix"], { format: "json", expectFailure: true });
  expect(result).toMatchObject({ status: 1 });
  expect(result.stdout).toContain("Write the property directly");
  expect(fixture.read("input.ts")).toBe(source);
});

test("trusts optional strings, arrays and objects, but preserves zero, false and unknown inputs", () => {
  using fixture = createOxlintFixture({
    rules: { "iterate/simple-truthiness-check": "error" },
    tsconfig: true,
  });
  fixture.write(
    "input.ts",
    `
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
  `,
  );
  const result = fixture.run(["input.ts"], { format: "json", expectFailure: true });
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
  using fixture = createOxlintFixture({
    rules: { "iterate/simple-truthiness-check": "error" },
    tsconfig: true,
  });
  fixture.write(
    "input.ts",
    `
    declare let input: { foo?: string; items?: string[] };
    export const a = { ...(input.foo ? { foo: input.foo } : {}) };
    export const b = { ...(input.foo == null ? {} : { foo: input.foo }) };
    export const c = typeof input.foo === "string";
    export const d = typeof input.items !== "undefined";
    input.foo ??= "Default";
  `,
  );
  expect(fixture.diagnostics(["input.ts"])).toHaveLength(5);
});

test("leaves real type discrimination and conditional computation alone", () => {
  using fixture = createOxlintFixture({
    rules: { "iterate/simple-truthiness-check": "error" },
    tsconfig: true,
  });
  fixture.write(
    "input.ts",
    `
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
  `,
  );
  const diagnostics = fixture.diagnostics(["input.ts"]);
  // The explicit undefined check in b is still a typed truthiness report,
  // but b is not an optional-property omission pattern.
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0].message).toContain("truthiness");
});

test("does not mistake shadowed globals for built-in checks", () => {
  using fixture = createOxlintFixture({
    rules: { "iterate/simple-truthiness-check": "error" },
    tsconfig: true,
  });
  fixture.write(
    "input.ts",
    `
    export function check(Array: { isArray(value: string[]): boolean }, undefined: string) {
      const items: string[] = [];
      const name = "foo";
      return [Array.isArray(items), name === undefined];
    }
  `,
  );
  fixture.run(["input.ts"]);
});

test("checks unsaved editor text rather than the file on disk", () => {
  using fixture = createOxlintFixture({
    rules: { "iterate/simple-truthiness-check": "error" },
    tsconfig: true,
  });
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
      "input.ts",
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
  using fixture = createOxlintFixture({
    rules: { "iterate/simple-truthiness-check": "error" },
    tsconfig: true,
  });
  fixture.write(
    "input.ts",
    `
    declare const input: { foo?: string; items?: readonly string[]; pair?: [string, number] };
    export const obj = { foo: input.foo };
    export const label = input.foo || "Default";
    export const items = input.items || [];
    export const checks = [Array.isArray(input.items), Array.isArray(input.pair)];
  `,
  );
  const diagnostics = fixture.diagnostics(["input.ts"]);
  expect(diagnostics).toHaveLength(2);
  expect(diagnostics.every((item: any) => item.message.includes("already an array"))).toBe(true);
});
