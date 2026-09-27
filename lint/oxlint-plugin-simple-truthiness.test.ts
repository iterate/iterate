// Tests for iterate/simple-truthiness-check (rules/simple-truthiness-check.ts), a type-aware rule
// with no autofix: each row runs the real oxlint binary with --fix, and the file stays as written.
// `reports` name each message by its opening, in source order.

import { join } from "node:path";
import { expect, test } from "vitest";
import { RuleTester } from "oxlint/plugins-dev";
import { simpleTruthinessCheckRule } from "./rules/simple-truthiness-check.ts";
import { createOxlintFixture, lintOne } from "./oxlint-fixture.ts";
import { getTypeAwareLintService } from "./oxlint-type-aware.ts";

test.for([
  {
    name: "reports optional properties hidden behind conditional spreads",
    source: `
      declare const input: { foo?: string };
      export const obj = { ...(input.foo !== undefined && { foo: input.foo }) };
    `,
    reports: ["Write the property directly"],
  },
  {
    name: "trusts optional strings, arrays and objects, but preserves zero, false and unknown inputs",
    source: `
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
    reports: [
      "Trust the declared string/object type",
      "Trust the declared string/object type",
      "Trust the declared string/object type",
      "Use || for a string/object fallback",
      "Use || for a string/object fallback",
      "Use || for a string/object fallback",
      "This value is already an array",
    ],
  },
  {
    name: "reports ternary omission, typed typeof guards and nullish assignment",
    source: `
      declare let input: { foo?: string; items?: string[] };
      export const a = { ...(input.foo ? { foo: input.foo } : {}) };
      export const b = { ...(input.foo == null ? {} : { foo: input.foo }) };
      export const c = typeof input.foo === "string";
      export const d = typeof input.items !== "undefined";
      input.foo ??= "Default";
    `,
    reports: [
      "Write the property directly",
      "Write the property directly",
      "Trust the declared string/object type",
      "Trust the declared string/object type",
      "Use ||= for a string/object fallback",
    ],
  },
  {
    // The explicit undefined check in b is still a typed truthiness report, but b is not an
    // optional-property omission pattern.
    name: "leaves real type discrimination and conditional computation alone",
    source: `
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
    reports: ["Trust the declared string/object type"],
  },
  {
    name: "does not mistake shadowed globals for built-in checks",
    source: `
      export function check(Array: { isArray(value: string[]): boolean }, undefined: string) {
        const items: string[] = [];
        const name = "foo";
        return [Array.isArray(items), name === undefined];
      }
    `,
    reports: [],
  },
  {
    name: "accepts direct properties and truthy fallbacks; checks readonly arrays and tuples",
    source: `
      declare const input: { foo?: string; items?: readonly string[]; pair?: [string, number] };
      export const obj = { foo: input.foo };
      export const label = input.foo || "Default";
      export const items = input.items || [];
      export const checks = [Array.isArray(input.items), Array.isArray(input.pair)];
    `,
    reports: ["This value is already an array", "This value is already an array"],
  },
])("$name", ({ source, reports }) => {
  expect(lintOne("simple-truthiness-check", "input.ts", source)).toEqual({
    messages: reports.map((opening) => expect.stringContaining(opening)),
    output: source,
  });
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
