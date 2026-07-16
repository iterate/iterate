import { RpcStub, RpcTarget } from "capnweb";
import { describe, expect, test, vi } from "vitest";
import {
  compileBrowserReplFunction,
  DEFAULT_BROWSER_REPL_CODE,
  evalBrowserReplCode,
  evalBrowserReplSessionCode,
  rewriteBrowserReplImports,
  runBrowserReplEntry,
} from "./browser-repl.ts";
import { ITX_EXAMPLES } from "./examples.ts";

/** One snippet submitted to a persistent session: either it evaluates to
 * `expected`, or it `declares` a scope binding the result must BE (functions
 * and classes — values a table cannot hand-write). */
type SessionStep = { code: string; declares?: string; expected?: unknown };

const SESSION_ROWS: Array<{ name: string; steps: SessionStep[] }> = [
  {
    name: "session snippets can reference previous local variables",
    steps: [
      { code: "const answer = 41", expected: 41 },
      { code: "answer + 1", expected: 42 },
      { code: "const secondAnswer = answer + 1", expected: 42 },
      { code: "secondAnswer", expected: 42 },
    ],
  },
  {
    name: "session snippets persist multiple top-level variables across lines",
    steps: [
      { code: "const first = 20\nconst second = 22", expected: 22 },
      { code: "first + second", expected: 42 },
    ],
  },
  {
    name: "session snippets persist function and class declarations",
    steps: [
      { code: "function answer() { return 42; }", declares: "answer" },
      { code: "answer()", expected: 42 },
      { code: "class Box { value() { return answer(); } }", declares: "Box" },
      { code: "new Box().value()", expected: 42 },
      { code: "async function asyncAnswer() { return answer(); }", declares: "asyncAnswer" },
      { code: "await asyncAnswer()", expected: 42 },
    ],
  },
  {
    // A stand-in for the esm.sh module: a data: URL is scheme'd, so the
    // import statement itself is untouched — instead prove the REWRITTEN
    // shape (`const x = …`) persists like any other top-level declaration.
    name: "imported bindings persist across session snippets",
    steps: [
      {
        code: 'const __replModule1 = { z: { kind: "schema" } };\nconst z = __replModule1.z;',
        expected: { kind: "schema" },
      },
      { code: "z.kind", expected: "schema" },
    ],
  },
];

describe("browser Cap'n Web REPL", () => {
  test("default snippet uses Cap'n Web promise pipelining", async () => {
    const list = vi.fn().mockResolvedValue(["prj_123"]);
    class Projects extends RpcTarget {
      list() {
        return list();
      }
    }

    class Context extends RpcTarget {
      get projects() {
        return new Projects();
      }
    }

    const itx = new RpcStub(new Context());

    await expect(evalBrowserReplCode({ code: DEFAULT_BROWSER_REPL_CODE, itx })).resolves.toEqual([
      "prj_123",
    ]);
    expect(list).toHaveBeenCalledTimes(1);
  });

  test("default snippet does not probe a callable RPC root then member", async () => {
    let thenReads = 0;
    const rpcRoot = Object.assign(() => undefined, {
      projects: {
        list() {
          return ["prj_a", "prj_b"];
        },
      },
    });
    Object.defineProperty(rpcRoot, "then", {
      configurable: true,
      get() {
        thenReads += 1;
        throw new Error("remote then should not be read");
      },
    });

    await expect(
      evalBrowserReplCode({
        code: DEFAULT_BROWSER_REPL_CODE,
        itx: rpcRoot,
      }),
    ).resolves.toEqual(["prj_a", "prj_b"]);
    expect(thenReads).toBe(0);
  });

  test("route entry runner succeeds for the default project list snippet", async () => {
    const itx = {
      projects: {
        list() {
          return ["prj_123"];
        },
      },
    };

    await expect(
      runBrowserReplEntry({
        code: DEFAULT_BROWSER_REPL_CODE,
        itx,
        scope: {},
      }),
    ).resolves.toEqual({
      consoleOutput: "",
      code: DEFAULT_BROWSER_REPL_CODE,
      id: expect.any(String),
      output: JSON.stringify(["prj_123"], null, 2),
      outputLanguage: "json",
      result: ["prj_123"],
      status: "success",
    });
  });

  test.for(SESSION_ROWS)("$name", async ({ steps }) => {
    const scope: Record<string, unknown> = {};
    for (const step of steps) {
      const result = await evalBrowserReplSessionCode({ code: step.code, itx: {}, scope });
      if (step.declares !== undefined) {
        expect(result).toBe(scope[step.declares]);
        expect(result).toEqual(expect.any(Function));
      } else {
        expect(result).toEqual(step.expected);
      }
    }
  });

  test.for([
    {
      name: "session snippets use the final top-level expression as the result",
      code: "const project = { total: 2 }\nproject.total + 40",
      expected: 42,
      expectedScope: { project: { total: 2 } } as Record<string, unknown>,
    },
    {
      name: "session snippets keep multiline calls as one final expression",
      code: "const increment = (value) => value + 1\nincrement\n(41)",
      expected: 42,
    },
    {
      name: "session snippets keep operator-start continuations in the final expression",
      code: "40\n+ 2",
      expected: 42,
    },
    {
      name: "session snippets keep optional-chain continuations in the final expression",
      code: "const project = { stats: { total: 42 } }\nproject.stats\n?.total",
      expected: 42,
    },
    {
      name: "session snippets keep ternary continuations in the final expression",
      code: "true\n? 42\n: 0",
      expected: 42,
    },
    {
      name: "session snippets do not rewrite do-while statements as expressions",
      code: "let count = 0\ndo {\n  count += 1\n} while (false)\ncount",
      expected: 1,
      expectedScope: { count: 1 },
    },
    {
      // Regression: the appended `; return __replLastValue` used to land on the
      // same line as a trailing comment and get swallowed → "Unexpected end of
      // input". A trailing comment is natural in our documented examples.
      name: "snippet ending in a line comment still returns its last value",
      code: "const a = 41;\na + 1   // the answer",
      expected: 42,
    },
    {
      name: "session snippets do not rewrite nested local declarations",
      code: 'function answer() {\n  const nested = 42;\n  return nested;\n}\nif (answer() !== 42) throw new Error("nested local declaration broke");\nconst persisted = answer();',
      expected: 42,
      expectedScope: { persisted: 42 },
      scopeHas: ["answer"],
      scopeMissing: ["nested"],
    },
    {
      name: "snippets ending in a top-level return produce that value",
      code: "const stream = { offset: 41 }\nreturn stream.offset + 1",
      expected: 42,
      expectedScope: { stream: { offset: 41 } },
    },
  ])("$name", async ({ code, expected, expectedScope, scopeHas, scopeMissing }) => {
    const scope: Record<string, unknown> = {};

    await expect(evalBrowserReplSessionCode({ code, itx: {}, scope })).resolves.toEqual(expected);

    for (const [key, value] of Object.entries(expectedScope ?? {})) {
      expect(scope[key]).toEqual(value);
    }
    for (const key of scopeHas ?? []) {
      expect(scope).toHaveProperty(key);
    }
    for (const key of scopeMissing ?? []) {
      expect(scope).not.toHaveProperty(key);
    }
  });

  test("session snippets cannot shadow injected itx binding", async () => {
    const scope: Record<string, unknown> = {};
    const itx = { marker: "injected itx" };

    await expect(
      evalBrowserReplSessionCode({
        code: "const itx = { marker: 'shadowed' }",
        itx,
        scope,
      }),
    ).rejects.toThrow('REPL binding "itx" is reserved.');

    await expect(
      evalBrowserReplSessionCode({
        code: "itx.marker",
        itx,
        scope,
      }),
    ).resolves.toBe("injected itx");
    expect(scope).not.toHaveProperty("itx");
  });

  test("route entry runner exposes the last result through aliases", async () => {
    const scope: Record<string, unknown> = {};

    await expect(
      runBrowserReplEntry({
        code: "const answer = 42",
        itx: {},
        scope,
      }),
    ).resolves.toMatchObject({
      output: "42",
      outputLanguage: "json",
      status: "success",
    });
    expect(scope.answer).toBe(42);
    expect(scope.$_).toBe(42);
    expect(scope._).toBe(42);

    await expect(
      runBrowserReplEntry({
        code: "$_ + _",
        itx: {},
        scope,
      }),
    ).resolves.toMatchObject({
      output: "84",
      outputLanguage: "json",
      status: "success",
    });
    expect(scope.$_).toBe(84);
    expect(scope._).toBe(84);
  });

  test("route entry runner captures console output for the submitted prompt", async () => {
    const scope: Record<string, unknown> = {};

    await expect(
      runBrowserReplEntry({
        code: `console.log("project", { id: "proj_123" }); console.warn("careful"); return 42`,
        itx: {},
        scope,
      }),
    ).resolves.toMatchObject({
      consoleOutput: `project {\n  "id": "proj_123"\n}\nwarn: careful`,
      output: "42",
      outputLanguage: "json",
      status: "success",
    });
  });

  test("route entry runner delegates non-captured console methods", async () => {
    const scope: Record<string, unknown> = {};
    const trace = vi.spyOn(console, "trace").mockImplementation(() => {});

    try {
      await expect(
        runBrowserReplEntry({
          code: `console.trace("kept"); return 42`,
          itx: {},
          scope,
        }),
      ).resolves.toMatchObject({
        consoleOutput: "",
        output: "42",
        outputLanguage: "json",
        status: "success",
      });
      expect(trace).toHaveBeenCalledWith("kept");
    } finally {
      trace.mockRestore();
    }
  });

  test("every published example has unique metadata and compiles", () => {
    expect(ITX_EXAMPLES.length).toBeGreaterThan(1);
    const ids = new Set<string>();
    for (const example of ITX_EXAMPLES) {
      expect(example.id, `duplicate example id ${example.id}`).not.toBe(undefined);
      expect(ids.has(example.id)).toBe(false);
      ids.add(example.id);
      expect(example.title.length).toBeGreaterThan(0);
      expect(example.description.length).toBeGreaterThan(0);
      expect(["agent", "project", "session"]).toContain(example.context);
      expect(example.runtimes.length).toBeGreaterThan(0);
      // The statement compiler must accept the snippet — this catches
      // transform bugs around nested template literals, top-level classes,
      // trailing `return`, and import rewriting before any of them reaches a
      // user.
      expect(() => compileBrowserReplFunction(example.code)).not.toThrow();
    }
  });

  test.for([
    {
      name: "rewrites a named import to an awaited esm.sh dynamic import",
      code: 'import { z } from "zod";\nreturn z',
      expected:
        'const __replModule1 = await import("https://esm.sh/zod");\n' +
        "const z = __replModule1.z;\nreturn z",
    },
    {
      name: "rewrites a default import",
      code: 'import dayjs from "dayjs"',
      expected:
        'const __replModule1 = await import("https://esm.sh/dayjs");\n' +
        "const dayjs = __replModule1.default;",
    },
    {
      name: "rewrites a versioned default-plus-aliased-named import",
      code: 'import lodash, { chunk as c } from "lodash-es@4"',
      expected:
        'const __replModule1 = await import("https://esm.sh/lodash-es@4");\n' +
        "const lodash = __replModule1.default;\n" +
        "const c = __replModule1.chunk;",
    },
    {
      name: "rewrites a namespace import",
      code: 'import * as R from "remeda"',
      expected:
        'const __replModule1 = await import("https://esm.sh/remeda");\nconst R = __replModule1;',
    },
    {
      name: "rewrites a side-effect import",
      code: 'import "side-effect-pkg"',
      expected: 'await import("https://esm.sh/side-effect-pkg")',
    },
    {
      // Full URLs load as-is; type-only imports disappear.
      name: "loads full-URL imports as-is",
      code: 'import { x } from "https://example.com/mod.js"',
      expected:
        'const __replModule1 = await import("https://example.com/mod.js");\nconst x = __replModule1.x;',
    },
    {
      name: "erases type-only imports",
      code: 'import type { Foo } from "zod"',
      expected: "",
    },
    {
      name: "leaves relative imports untouched",
      code: 'import { x } from "./local.ts"',
      expected: 'import { x } from "./local.ts"',
    },
    {
      name: "leaves node: scheme'd imports untouched",
      code: 'import fs from "node:fs"',
      expected: 'import fs from "node:fs"',
    },
    {
      name: "leaves cloudflare: scheme'd imports untouched",
      code: 'import { WorkerEntrypoint } from "cloudflare:workers"',
      expected: 'import { WorkerEntrypoint } from "cloudflare:workers"',
    },
    {
      name: "leaves import statements inside template literals untouched",
      code: 'const source = `\n  import { WorkerEntrypoint } from "cloudflare:workers";\n`;',
      expected: 'const source = `\n  import { WorkerEntrypoint } from "cloudflare:workers";\n`;',
    },
    {
      name: "leaves dynamic imports untouched",
      code: "await import(moduleName)",
      expected: "await import(moduleName)",
    },
  ])("$name", ({ code, expected }) => {
    expect(rewriteBrowserReplImports(code)).toBe(expected);
  });
});
