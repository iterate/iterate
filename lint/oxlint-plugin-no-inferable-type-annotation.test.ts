// Tests for iterate/no-inferable-type-annotation (rules/no-inferable-type-annotation.ts), a
// type-aware rule: each row runs the real oxlint binary against a strict temp project, once for
// what it reports and once with --fix, and `output` is the file after the fix.

import { expect, test } from "vitest";
import { createOxlintFixture } from "./oxlint-fixture.ts";

test.for([
  {
    name: "reports annotations that repeat the initializer's own type, and the fix drops them",
    source: `
      interface Foo { a: number }
      declare function makeFoo(): Foo;
      declare const foo: Foo;
      declare const maybe: Foo | undefined;
      declare function load(): Promise<Foo>;
      export const direct: Foo = makeFoo();
      export let reference: Foo = foo;
      export const member: number = foo.a;
      export const either: Foo | null = maybe ? maybe : null;
      export const loaded: Foo = await load();
      export const asserted: Foo = JSON.parse("{}") as Foo;
      export let first: Foo = foo, done: Promise<void> = Promise.resolve();
      export const created: Map<string, number> = new Map<string, number>();
      export class Holder {
        readonly #foo: Foo = makeFoo();
        field: Foo | undefined = maybe;
        get foo() { return this.#foo; }
      }
    `,
    reports: [
      "infers `Foo`",
      "infers `Foo`",
      "infers `number`",
      "infers `Foo | null`",
      "infers `Foo`",
      "infers `Foo`",
      "infers `Foo`",
      "infers `Promise<void>`",
      "infers `Map<string, number>`",
      "infers `Foo`",
      "infers `Foo | undefined`",
    ],
    output: `
      interface Foo { a: number }
      declare function makeFoo(): Foo;
      declare const foo: Foo;
      declare const maybe: Foo | undefined;
      declare function load(): Promise<Foo>;
      export const direct = makeFoo();
      export let reference = foo;
      export const member = foo.a;
      export const either = maybe ? maybe : null;
      export const loaded = await load();
      export const asserted = JSON.parse("{}") as Foo;
      export let first = foo, done = Promise.resolve();
      export const created = new Map<string, number>();
      export class Holder {
        readonly #foo = makeFoo();
        field = maybe;
        get foo() { return this.#foo; }
      }
    `,
  },
  {
    // Each initializer's type would change without its annotation: a wider or narrower type, a
    // generic call that infers from the annotation, or an expression the annotation types.
    name: "leaves annotations that change the declared type alone",
    source: `
      interface Foo { a: number }
      declare const foo: Foo;
      declare function pick<T>(): T;
      declare const raw: any;
      export const wider: Foo | undefined = foo;
      export const narrowed: Foo = raw;
      export const unknownValue: unknown = raw;
      export const set: Set<string> = new Set();
      export const inferred: Foo = pick();
      export const literal: { a: number } = { a: 1 };
      export const list: Foo[] = [foo];
      export const handler: (value: Foo) => number = (value) => value.a;
      export let mode: "a" | "b" = "a";
      export const text: string = "text";
      import type { Missing } from "./nowhere.ts";
      declare const unresolved: Missing;
      export const alsoUnresolved: Missing = unresolved;
      export const alsoAny: any = raw;
    `,
    reports: [],
    output: undefined,
  },
])("$name", ({ source, reports, output }) => {
  using fixture = createOxlintFixture({
    rules: { "iterate/no-inferable-type-annotation": "error" },
    tsconfig: true,
  });
  fixture.write("input.ts", source);
  const messages = fixture.diagnostics(["input.ts"]).map((diagnostic) => diagnostic.message);
  fixture.diagnostics(["input.ts", "--fix"]);
  expect({ messages, output: fixture.read("input.ts") }).toEqual({
    messages: reports.map((opening) => expect.stringContaining(opening)),
    output: output || source,
  });
});
