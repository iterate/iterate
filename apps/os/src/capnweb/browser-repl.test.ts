import { RpcStub, RpcTarget } from "capnweb";
import { describe, expect, test, vi } from "vitest";
import {
  BROWSER_REPL_EXAMPLES,
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

    const ctx = new RpcStub(new Context());

    await expect(evalBrowserReplCode({ code: DEFAULT_BROWSER_REPL_CODE, ctx })).resolves.toEqual({
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
        ctx: rpcRoot,
      }),
    ).resolves.toEqual({ projects: [], total: 0, limit: 5 });
    expect(thenReads).toBe(0);
  });

  test("route entry runner succeeds for the default project list snippet", async () => {
    const ctx = {
      projects: {
        list(input: { limit: number }) {
          return { projects: [{ id: "proj_123" }], total: 1, limit: input.limit };
        },
      },
    };

    await expect(
      runBrowserReplEntry({
        code: DEFAULT_BROWSER_REPL_CODE,
        ctx,
        scope: {},
      }),
    ).resolves.toEqual({
      consoleOutput: "",
      code: DEFAULT_BROWSER_REPL_CODE,
      output: JSON.stringify({ projects: [{ id: "proj_123" }], total: 1, limit: 5 }, null, 2),
      outputLanguage: "json",
      status: "success",
    });
  });

  test("REPL supports SDK-shaped calls through a server-side path target", async () => {
    const call = vi.fn(async (input: { args: unknown[]; path: string[] }) => input);
    const ctx = {
      slack: new BrowserPathTarget(call),
    };

    await expect(
      evalBrowserReplCode({
        code: `await ctx.slack.chat.postMessage({ channel: "C123", text: "hi" })`,
        ctx,
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
        ctx: {},
        scope,
      }),
    ).resolves.toBe(41);

    await expect(
      evalBrowserReplSessionCode({
        code: "answer + 1",
        ctx: {},
        scope,
      }),
    ).resolves.toBe(42);

    await expect(
      evalBrowserReplSessionCode({
        code: "const secondAnswer = answer + 1",
        ctx: {},
        scope,
      }),
    ).resolves.toBe(42);

    await expect(
      evalBrowserReplSessionCode({
        code: "secondAnswer",
        ctx: {},
        scope,
      }),
    ).resolves.toBe(42);
  });

  test("session snippets persist multiple top-level variables across lines", async () => {
    const scope: Record<string, unknown> = {};

    await expect(
      evalBrowserReplSessionCode({
        code: "const first = 20\nconst second = 22",
        ctx: {},
        scope,
      }),
    ).resolves.toBe(22);

    await expect(
      evalBrowserReplSessionCode({
        code: "first + second",
        ctx: {},
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
        ctx: {},
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
        ctx: {},
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
        ctx: {},
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
        ctx: {},
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
        ctx: {},
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
        ctx: {},
        scope,
      }),
    ).resolves.toBe(1);

    expect(scope.count).toBe(1);
  });

  test("session snippets persist function and class declarations", async () => {
    const scope: Record<string, unknown> = {};

    const answerResult = await evalBrowserReplSessionCode({
      code: "function answer() { return 42; }",
      ctx: {},
      scope,
    });
    expect(answerResult).toBe(scope.answer);
    expect(answerResult).toEqual(expect.any(Function));

    await expect(
      evalBrowserReplSessionCode({
        code: "answer()",
        ctx: {},
        scope,
      }),
    ).resolves.toBe(42);

    const boxResult = await evalBrowserReplSessionCode({
      code: "class Box { value() { return answer(); } }",
      ctx: {},
      scope,
    });
    expect(boxResult).toBe(scope.Box);
    expect(boxResult).toEqual(expect.any(Function));

    await expect(
      evalBrowserReplSessionCode({
        code: "new Box().value()",
        ctx: {},
        scope,
      }),
    ).resolves.toBe(42);

    const asyncAnswerResult = await evalBrowserReplSessionCode({
      code: "async function asyncAnswer() { return answer(); }",
      ctx: {},
      scope,
    });
    expect(asyncAnswerResult).toBe(scope.asyncAnswer);
    expect(asyncAnswerResult).toEqual(expect.any(Function));

    await expect(
      evalBrowserReplSessionCode({
        code: "await asyncAnswer()",
        ctx: {},
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
        ctx: {},
        scope,
      }),
    ).resolves.toBe(42);

    expect(scope).toHaveProperty("answer");
    expect(scope).toHaveProperty("persisted", 42);
    expect(scope).not.toHaveProperty("nested");
  });

  test("session snippets cannot shadow injected ctx or env bindings", async () => {
    const scope: Record<string, unknown> = {};
    const ctx = { marker: "injected ctx" };

    await expect(
      evalBrowserReplSessionCode({
        code: "const ctx = { marker: 'shadowed' }",
        ctx,
        scope,
      }),
    ).rejects.toThrow('REPL binding "ctx" is reserved.');

    await expect(
      evalBrowserReplSessionCode({
        code: "ctx.marker",
        ctx,
        scope,
      }),
    ).resolves.toBe("injected ctx");
    expect(scope).not.toHaveProperty("ctx");

    await expect(
      evalBrowserReplSessionCode({
        code: "function env() {}",
        ctx,
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
        ctx: {},
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
        ctx: {},
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
        ctx: {},
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
          ctx: {},
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

  test("provideCapability example registers and calls a browser-owned target", async () => {
    const providedTargets = new Map<string, unknown>();
    const alert = vi.fn();
    const project = {
      connections: {
        get(connectionKey: string) {
          return providedTargets.get(connectionKey);
        },
      },
      provideCapability(input: { connectionKey: string; rpcTarget: unknown }) {
        providedTargets.set(input.connectionKey, input.rpcTarget);
        return { connectionKey: input.connectionKey, ok: true };
      },
    };
    const ctx = {
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
      return candidate.id === "provide-alert-capability";
    });
    if (!example) throw new Error("Missing provideCapability browser REPL example.");

    await expect(
      evalBrowserReplSessionCode({
        code: example.code,
        ctx,
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
