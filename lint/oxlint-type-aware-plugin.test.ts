import { join } from "node:path";

import { SignatureKind } from "typescript/unstable/sync";
import { expect, test } from "vitest";

import { createOxlintFixture } from "./oxlint-fixture.ts";
import { TypeAwareLintService } from "./oxlint-type-aware.ts";

// Each row writes `types.ts` and `implementation.ts`, runs --fix, and expects nothing left to
// report. A row without `fixed` is already mechanical and stays as written.
test.for([
  {
    name: "fixes implementation signatures from the TypeScript checker",
    types: `
      export type Mechanical<T> = T;
      export interface Greeter {
        getGreeting(params: { enthusiasm: number }): string;
        getFarewell(politeness: number, enthusiasm: number): void;
      }
    `,
    implementation: `
      import type { Greeter, Mechanical } from "./types.ts";

      class MyGreeter implements Mechanical<Greeter> {
        getGreeting(input: { enthusiasm: number }): string {
          return "hello";
        }

        getFarewell(politeness: number, enthusiasm: number): void {
        }
      }
    `,
    fixed: `
      import type { Greeter, Mechanical } from "./types.ts";

      class MyGreeter implements Mechanical<Greeter> {
        getGreeting(input: Parameters<Greeter["getGreeting"]>[0]) {
          return "hello";
        }

        getFarewell(...[politeness, enthusiasm]: Parameters<Greeter["getFarewell"]>) {
        }
      }
    `,
  },
  {
    name: "reads methods from mapped helper implementations",
    types: `
      export type MechanicalMap<T> = {
        [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => R : T[K];
      };
      export interface Greeter {
        getGreeting(params: { enthusiasm: number }): string;
      }
    `,
    implementation: `
      import type { Greeter, MechanicalMap } from "./types.ts";

      class MyGreeter implements MechanicalMap<Greeter> {
        getGreeting(input: { enthusiasm: number }): string {
          return "hello";
        }
      }
    `,
    fixed: `
      import type { Greeter, MechanicalMap } from "./types.ts";

      class MyGreeter implements MechanicalMap<Greeter> {
        getGreeting(input: Parameters<Greeter["getGreeting"]>[0]) {
          return "hello";
        }
      }
    `,
  },
  {
    name: "supports direct interface implementations",
    types: `
      export interface Greeter {
        getGreeting(params: { enthusiasm: number }): string;
      }
    `,
    implementation: `
      import type { Greeter } from "./types.ts";

      class MyGreeter implements Greeter {
        getGreeting(input: { enthusiasm: number }): string {
          return "hello";
        }
      }
    `,
    fixed: `
      import type { Greeter } from "./types.ts";

      class MyGreeter implements Greeter {
        getGreeting(input: Parameters<Greeter["getGreeting"]>[0]) {
          return "hello";
        }
      }
    `,
  },
  {
    name: "allows omitted implementation params",
    types: `
      export interface IPerson {
        sayHello(): string;
        sayGoodbye(params: { mood: "happy" | "sad" | "neutral" }): string;
      }
    `,
    implementation: `
      import type { IPerson } from "./types.ts";

      class CPerson implements IPerson {
        sayHello(): never {
          throw new Error("Method not implemented.");
        }
        sayGoodbye(): never {
          throw new Error("Method not implemented.");
        }
      }
    `,
  },
  {
    name: "allows simple implementation param types",
    types: `
      export interface Greeter {
        setName(name: string): void;
        setEnabled(enabled: boolean): void;
        setScores(scores: number[]): void;
      }
    `,
    implementation: `
      import type { Greeter } from "./types.ts";

      class MyGreeter implements Greeter {
        setName(name: string) {
        }
        setEnabled(enabled: boolean) {
        }
        setScores(scores: number[]) {
        }
      }
    `,
  },
  {
    name: "fixes class field arrow implementations",
    types: `
      export interface IPerson {
        sayGoodbye(params: { mood: "happy" | "sad" | "neutral" }): string;
      }
    `,
    implementation: `
      import type { IPerson } from "./types.ts";

      class CPerson implements IPerson {
        sayGoodbye = (_params: any): string => {
          return "bye";
        };
      }
    `,
    fixed: `
      import type { IPerson } from "./types.ts";

      class CPerson implements IPerson {
        sayGoodbye = (_params: Parameters<IPerson["sayGoodbye"]>[0]) => {
          return "bye";
        };
      }
    `,
  },
  {
    name: "preserves defaults in nested helper implementations",
    types: `
      export type Mechanical<T> = T;
      export interface Greeter {
        getGreeting(params: { enthusiasm: number }): string;
      }
    `,
    implementation: `
      import type { Greeter, Mechanical } from "./types.ts";

      const defaultInput = { enthusiasm: 1 };

      class MyGreeter implements Pick<Mechanical<Greeter>, "getGreeting"> {
        getGreeting(input: { enthusiasm: number } = defaultInput): string {
          return "hello";
        }
      }
    `,
    fixed: `
      import type { Greeter, Mechanical } from "./types.ts";

      const defaultInput = { enthusiasm: 1 };

      class MyGreeter implements Pick<Mechanical<Greeter>, "getGreeting"> {
        getGreeting(input: Parameters<Greeter["getGreeting"]>[0] = defaultInput) {
          return "hello";
        }
      }
    `,
  },
])("mechanical-class-impl $name", ({ types, implementation, fixed = implementation }) => {
  using fixture = createOxlintFixture({
    tsconfig: true,
    rules: { "iterate/mechanical-class-impl": "error" },
  });
  fixture.write("types.ts", types);
  fixture.write("implementation.ts", implementation);

  fixture.run(["implementation.ts", "--fix"]);

  expect(fixture.read("implementation.ts")).toBe(fixed);
});

// `reported` is the source text under each report, in source order.
test.for([
  {
    name: "reports the params alone when they are not mechanical, and the return type alone",
    implementation: `
      import type { Greeter } from "./types.ts";

      class MyGreeter implements Greeter {
        getGreeting(input: { enthusiasm: number }): string {
          return "hello";
        }
      }
    `,
    reported: ["input: { enthusiasm: number }", ": string"],
  },
  {
    name: "reports only the return type when the params are mechanical",
    implementation: `
      import type { Greeter } from "./types.ts";

      class MyGreeter implements Greeter {
        getGreeting(input: Parameters<Greeter["getGreeting"]>[0]): string {
          return "hello";
        }
      }
    `,
    reported: [": string"],
  },
])("mechanical-class-impl $name", ({ implementation, reported }) => {
  using fixture = createOxlintFixture({
    tsconfig: true,
    rules: { "iterate/mechanical-class-impl": "error" },
  });
  fixture.write(
    "types.ts",
    "export interface Greeter { getGreeting(params: { enthusiasm: number }): string; }",
  );
  fixture.write("implementation.ts", implementation);

  const spans = fixture.diagnostics(["implementation.ts"]).map(({ labels }) => labels[0]!.span);
  expect(spans.map((span) => implementation.slice(span.offset, span.offset + span.length))).toEqual(
    reported,
  );
});

test("type-aware lint service refreshes changed files without restarting the process", () => {
  using fixture = createOxlintFixture({
    tsconfig: true,
    rules: { "iterate/mechanical-class-impl": "error" },
  });
  const service = new TypeAwareLintService({ cwd: fixture.root });
  using _service = { [Symbol.dispose]: () => service.close() };
  const firstSource = `
    interface Foo {}

    export class Bar implements Foo {
      f(a: 1): void {
        console.log(a);
      }
    }
  `;
  fixture.write("implementation.ts", firstSource);

  const firstProperties = getCallablePropertyNames(
    service,
    join(fixture.root, "implementation.ts"),
    "Foo",
    firstSource.indexOf("Foo {"),
  );

  expect(firstProperties).toEqual([]);

  const secondSource = `
    interface Foo {
      f(a: 1): void;
    }

    export class Bar implements Foo {
      f(a: 1): void {
        console.log(a);
      }
    }
  `;
  fixture.write("implementation.ts", secondSource);

  const secondProperties = getCallablePropertyNames(
    service,
    join(fixture.root, "implementation.ts"),
    "Foo",
    secondSource.indexOf("Foo {"),
  );

  expect(secondProperties).toEqual(["f"]);
});

test("type-aware lint service keeps all open files in snapshot updates", () => {
  using fixture = createOxlintFixture({
    tsconfig: true,
    rules: { "iterate/mechanical-class-impl": "off" },
  });
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

  expect(updates.map((update) => update.openFiles)).toEqual([[firstFile], [firstFile, secondFile]]);
  expect(updates.map((update) => update.openProjects)).toEqual([[tsconfigFile], [tsconfigFile]]);
});

test("type-aware lint service can read unsaved text overlays", () => {
  using fixture = createOxlintFixture({
    tsconfig: true,
    rules: { "iterate/mechanical-class-impl": "error" },
  });
  const service = new TypeAwareLintService({ cwd: fixture.root });
  using _service = { [Symbol.dispose]: () => service.close() };
  const fileName = join(fixture.root, "implementation.ts");
  const savedSource = `
    interface Foo {}

    export class Bar implements Foo {
      f(a: 1): void {
        console.log(a);
      }
    }
  `;
  fixture.write("implementation.ts", savedSource);

  const firstProperties = getCallablePropertyNames(
    service,
    fileName,
    "Foo",
    savedSource.indexOf("Foo {"),
  );

  expect(firstProperties).toEqual([]);

  const unsavedSource = `
    interface Foo {
      f(a: 1): void;
    }

    export class Bar implements Foo {
      f(a: 1): void {
        console.log(a);
      }
    }
  `;
  service.setFileText(fileName, unsavedSource);

  const secondProperties = getCallablePropertyNames(
    service,
    fileName,
    "Foo",
    unsavedSource.indexOf("Foo {"),
  );

  expect(secondProperties).toEqual(["f"]);
  expect(fixture.read("implementation.ts")).toBe(savedSource);
});

test("typed-no-floating-promises reports only unhandled promise-like expression statements", () => {
  using fixture = createOxlintFixture({
    tsconfig: true,
    rules: { "iterate/typed-no-floating-promises": "error" },
  });
  fixture.write(
    "promises.ts",
    `
      async function returnsPromise(): Promise<void> {}

      returnsPromise();
      void returnsPromise();
      await returnsPromise();
      returnsPromise().catch(() => {});
    `,
  );

  expect(
    fixture.diagnostics(["promises.ts"]).map(({ message, labels }) => ({
      message,
      line: labels[0]!.span.line,
    })),
  ).toEqual([{ message: expect.stringContaining("Promise-like expression"), line: 4 }]);
});

test("typed-no-floating-promises and simple-truthiness-check share one type-aware snapshot across files", () => {
  // Both rules armed together, as .oxlintrc.json arms them: one rule must never dispose the
  // snapshot the other is reading from ("Error running JS plugin … snapshot N not found").
  using fixture = createOxlintFixture({
    tsconfig: true,
    rules: {
      "iterate/simple-truthiness-check": "error",
      "iterate/typed-no-floating-promises": "error",
    },
  });
  for (const name of ["a", "b", "c"])
    fixture.write(
      `${name}.ts`,
      `
        async function returnsPromise(): Promise<void> {}
        declare const input: { label?: string };
        returnsPromise();
        export const label = input.label ?? "Default";
      `,
    );

  const diagnostics = fixture.diagnostics(["a.ts", "b.ts", "c.ts"]);

  expect(
    diagnostics.map((diagnostic) => `${diagnostic.filename} ${diagnostic.code}`).sort(),
  ).toEqual(
    ["a.ts", "b.ts", "c.ts"].flatMap((file) => [
      `${file} iterate(simple-truthiness-check)`,
      `${file} iterate(typed-no-floating-promises)`,
    ]),
  );
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
