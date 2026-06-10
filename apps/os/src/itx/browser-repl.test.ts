import { RpcStub, RpcTarget } from "capnweb";
import { describe, expect, test, vi } from "vitest";
import {
  browserReplExternalScopesEqual,
  BROWSER_REPL_EXAMPLES,
  compileBrowserReplFunction,
  createBrowserReplScope,
  DEFAULT_BROWSER_REPL_CODE,
  evalBrowserReplCode,
  evalBrowserReplSessionCode,
  runBrowserReplEntry,
} from "./browser-repl.ts";

describe("browser Cap'n Web REPL", () => {
  test("default snippet uses Cap'n Web promise pipelining", async () => {
    const list = vi.fn().mockResolvedValue({ items: [{ id: "proj_123" }] });
    class Projects extends RpcTarget {
      list(input: { limit: number }) {
        return list(input);
      }
    }

    class Context extends RpcTarget {
      get projects() {
        return new Projects();
      }
    }

    const itx = new RpcStub(new Context());

    await expect(evalBrowserReplCode({ code: DEFAULT_BROWSER_REPL_CODE, itx })).resolves.toEqual({
      items: [{ id: "proj_123" }],
    });
    expect(list).toHaveBeenCalledWith({ limit: 5 });
  });

  test("default snippet does not probe a callable RPC root then member", async () => {
    let thenReads = 0;
    const rpcRoot = Object.assign(() => undefined, {
      projects: {
        list(input: { limit: number }) {
          return { projects: [], total: 0, limit: input.limit };
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
    ).resolves.toEqual({ projects: [], total: 0, limit: 5 });
    expect(thenReads).toBe(0);
  });

  test("route entry runner succeeds for the default project list snippet", async () => {
    const itx = {
      projects: {
        list(input: { limit: number }) {
          return { projects: [{ id: "proj_123" }], total: 1, limit: input.limit };
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
      output: JSON.stringify({ projects: [{ id: "proj_123" }], total: 1, limit: 5 }, null, 2),
      outputLanguage: "json",
      result: { projects: [{ id: "proj_123" }], total: 1, limit: 5 },
      status: "success",
    });
  });

  test("external scope comparison preserves REPL bindings across equivalent renders", () => {
    const currentScope = createBrowserReplScope({ projectId: "proj_123" });
    currentScope.$_ = 42;
    currentScope._ = 42;

    expect(
      browserReplExternalScopesEqual({ projectId: "proj_123" }, { projectId: "proj_123" }),
    ).toBe(true);
    expect(currentScope.$_).toBe(42);
    expect(currentScope._).toBe(42);

    expect(
      browserReplExternalScopesEqual({ projectId: "proj_123" }, { projectId: "proj_456" }),
    ).toBe(false);
  });

  test("REPL supports SDK-shaped calls through a server-side path target", async () => {
    const call = vi.fn(async (input: { args: unknown[]; path: string[] }) => input);
    const itx = {
      slack: new BrowserPathTarget(call),
    };

    await expect(
      evalBrowserReplCode({
        code: `await itx.slack.chat.postMessage({ channel: "C123", text: "hi" })`,
        itx,
      }),
    ).resolves.toEqual({
      args: [{ channel: "C123", text: "hi" }],
      path: ["chat", "postMessage"],
    });
    expect(call).toHaveBeenCalledTimes(1);
  });

  test("session snippets can reference previous local variables", async () => {
    const scope: Record<string, unknown> = {};

    await expect(
      evalBrowserReplSessionCode({
        code: "const answer = 41",
        itx: {},
        scope,
      }),
    ).resolves.toBe(41);

    await expect(
      evalBrowserReplSessionCode({
        code: "answer + 1",
        itx: {},
        scope,
      }),
    ).resolves.toBe(42);

    await expect(
      evalBrowserReplSessionCode({
        code: "const secondAnswer = answer + 1",
        itx: {},
        scope,
      }),
    ).resolves.toBe(42);

    await expect(
      evalBrowserReplSessionCode({
        code: "secondAnswer",
        itx: {},
        scope,
      }),
    ).resolves.toBe(42);
  });

  test("session snippets persist multiple top-level variables across lines", async () => {
    const scope: Record<string, unknown> = {};

    await expect(
      evalBrowserReplSessionCode({
        code: "const first = 20\nconst second = 22",
        itx: {},
        scope,
      }),
    ).resolves.toBe(22);

    await expect(
      evalBrowserReplSessionCode({
        code: "first + second",
        itx: {},
        scope,
      }),
    ).resolves.toBe(42);
  });

  test("session snippets use the final top-level expression as the result", async () => {
    const scope: Record<string, unknown> = {};

    await expect(
      evalBrowserReplSessionCode({
        code: `
const project = { total: 2 }
project.total + 40
`.trim(),
        itx: {},
        scope,
      }),
    ).resolves.toBe(42);

    expect(scope.project).toEqual({ total: 2 });
  });

  test("session snippets keep multiline calls as one final expression", async () => {
    const scope: Record<string, unknown> = {};

    await expect(
      evalBrowserReplSessionCode({
        code: `
const increment = (value) => value + 1
increment
(41)
`.trim(),
        itx: {},
        scope,
      }),
    ).resolves.toBe(42);
  });

  test("session snippets keep operator-start continuations in the final expression", async () => {
    await expect(
      evalBrowserReplSessionCode({
        code: `
40
+ 2
`.trim(),
        itx: {},
        scope: {},
      }),
    ).resolves.toBe(42);

    await expect(
      evalBrowserReplSessionCode({
        code: `
const project = { stats: { total: 42 } }
project.stats
?.total
`.trim(),
        itx: {},
        scope: {},
      }),
    ).resolves.toBe(42);

    await expect(
      evalBrowserReplSessionCode({
        code: `
true
? 42
: 0
`.trim(),
        itx: {},
        scope: {},
      }),
    ).resolves.toBe(42);
  });

  test("session snippets do not rewrite do-while statements as expressions", async () => {
    const scope: Record<string, unknown> = {};

    await expect(
      evalBrowserReplSessionCode({
        code: `
let count = 0
do {
  count += 1
} while (false)
count
`.trim(),
        itx: {},
        scope,
      }),
    ).resolves.toBe(1);

    expect(scope.count).toBe(1);
  });

  test("snippet ending in a line comment still returns its last value", async () => {
    // Regression: the appended `; return __replLastValue` used to land on the
    // same line as a trailing comment and get swallowed → "Unexpected end of
    // input". A trailing comment is natural in our documented examples.
    await expect(
      evalBrowserReplSessionCode({
        code: "const a = 41;\na + 1   // the answer",
        itx: {},
        scope: {},
      }),
    ).resolves.toBe(42);
  });

  test("session snippets persist function and class declarations", async () => {
    const scope: Record<string, unknown> = {};

    const answerResult = await evalBrowserReplSessionCode({
      code: "function answer() { return 42; }",
      itx: {},
      scope,
    });
    expect(answerResult).toBe(scope.answer);
    expect(answerResult).toEqual(expect.any(Function));

    await expect(
      evalBrowserReplSessionCode({
        code: "answer()",
        itx: {},
        scope,
      }),
    ).resolves.toBe(42);

    const boxResult = await evalBrowserReplSessionCode({
      code: "class Box { value() { return answer(); } }",
      itx: {},
      scope,
    });
    expect(boxResult).toBe(scope.Box);
    expect(boxResult).toEqual(expect.any(Function));

    await expect(
      evalBrowserReplSessionCode({
        code: "new Box().value()",
        itx: {},
        scope,
      }),
    ).resolves.toBe(42);

    const asyncAnswerResult = await evalBrowserReplSessionCode({
      code: "async function asyncAnswer() { return answer(); }",
      itx: {},
      scope,
    });
    expect(asyncAnswerResult).toBe(scope.asyncAnswer);
    expect(asyncAnswerResult).toEqual(expect.any(Function));

    await expect(
      evalBrowserReplSessionCode({
        code: "await asyncAnswer()",
        itx: {},
        scope,
      }),
    ).resolves.toBe(42);
  });

  test("session snippets do not rewrite nested local declarations", async () => {
    const scope: Record<string, unknown> = {};

    await expect(
      evalBrowserReplSessionCode({
        code: `
function answer() {
  const nested = 42;
  return nested;
}
if (answer() !== 42) throw new Error("nested local declaration broke");
const persisted = answer();
`.trim(),
        itx: {},
        scope,
      }),
    ).resolves.toBe(42);

    expect(scope).toHaveProperty("answer");
    expect(scope).toHaveProperty("persisted", 42);
    expect(scope).not.toHaveProperty("nested");
  });

  test("session snippets cannot shadow injected itx or env bindings", async () => {
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

    await expect(
      evalBrowserReplSessionCode({
        code: "function env() {}",
        itx,
        scope,
      }),
    ).rejects.toThrow('REPL binding "env" is reserved.');
    expect(scope).not.toHaveProperty("env");
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
    expect(BROWSER_REPL_EXAMPLES.length).toBeGreaterThan(1);
    const ids = new Set<string>();
    for (const example of BROWSER_REPL_EXAMPLES) {
      expect(example.id, `duplicate example id ${example.id}`).not.toBe(undefined);
      expect(ids.has(example.id)).toBe(false);
      ids.add(example.id);
      expect(example.title.length).toBeGreaterThan(0);
      expect(example.description.length).toBeGreaterThan(0);
      // The statement compiler must accept the snippet — this catches
      // transform bugs around nested template literals, top-level classes,
      // and trailing `return` before any of them reaches a user.
      expect(() => compileBrowserReplFunction(example.code)).not.toThrow();
    }
  });

  test("caps.provide example registers and calls a browser-owned target", async () => {
    // Mirrors the itx handle's shape: caps.provide registers a live target,
    // and unknown names on the project handle fall through to it.
    const providedTargets = new Map<string, { run(): unknown }>();
    const alert = vi.fn();
    const project = new Proxy(
      {
        caps: {
          provide(input: { name: string; target: { run(): unknown } }) {
            providedTargets.set(input.name, input.target);
            return { name: input.name, ok: true };
          },
        },
      },
      {
        get(target, prop: string | symbol) {
          if (typeof prop === "string" && providedTargets.has(prop)) {
            return providedTargets.get(prop);
          }
          return Reflect.get(target, prop);
        },
      },
    );
    const itx = {
      projects: {
        get(projectId: string) {
          if (projectId !== "proj_123") throw new Error(`Unexpected project ${projectId}`);
          return project;
        },
        list() {
          return { projects: [{ id: "proj_123" }], total: 1 };
        },
      },
    };

    const example = BROWSER_REPL_EXAMPLES.find((candidate) => {
      return candidate.id === "provide-live-capability";
    });
    if (!example) throw new Error("Missing provide-live-capability browser REPL example.");

    await expect(
      evalBrowserReplSessionCode({
        code: example.code,
        itx,
        scope: { alert, RpcTarget },
      }),
    ).resolves.toBe("alerted");
    expect(alert).toHaveBeenCalledWith("The answer is 42");
  });
});

class BrowserPathTarget extends RpcTarget {
  constructor(private readonly callPath: (input: { args: unknown[]; path: string[] }) => unknown) {
    super();
    return this.callable([]) as unknown as BrowserPathTarget;
  }

  private callable(path: string[]): Function {
    const fn = (...args: unknown[]) => this.callPath({ args, path });
    return new Proxy(fn, {
      apply: (_target, _thisArg, args) => this.callPath({ args, path }),
      get: (target, key, receiver) => {
        if (key === "then") return undefined;
        if (typeof key === "symbol" || key in target) return Reflect.get(target, key, receiver);
        return this.callable([...path, key]);
      },
      getOwnPropertyDescriptor: (target, key) => {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
        if (descriptor) return descriptor;
        if (key in target) return undefined;
        if (typeof key === "symbol" || key === "then") return undefined;
        return {
          configurable: true,
          enumerable: false,
          value: this.callable([...path, key]),
          writable: false,
        };
      },
      has: (target, key) => {
        if (typeof key === "symbol") return key in target;
        if (key === "then") return false;
        return true;
      },
    });
  }
}
