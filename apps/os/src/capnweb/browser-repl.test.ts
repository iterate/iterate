import { RpcStub, RpcTarget } from "capnweb";
import { describe, expect, test, vi } from "vitest";
import {
  BROWSER_REPL_EXAMPLES,
  DEFAULT_BROWSER_REPL_CODE,
  evalBrowserReplCode,
  evalBrowserReplSessionCode,
  runBrowserReplEntry,
} from "./browser-repl.ts";
import { liftLocalProxies } from "./local-proxy-wrapper.js";

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

    const ctx = liftLocalProxies(new RpcStub(new Context()));

    await expect(evalBrowserReplCode({ code: DEFAULT_BROWSER_REPL_CODE, ctx })).resolves.toEqual({
      items: [{ id: "proj_123" }],
    });
    expect(list).toHaveBeenCalledWith({ limit: 5 });
  });

  test("route entry runner succeeds for the default project list snippet", async () => {
    const ctx = liftLocalProxies({
      projects: {
        list(input: { limit: number }) {
          return { projects: [{ id: "proj_123" }], total: 1, limit: input.limit };
        },
      },
    });

    await expect(
      runBrowserReplEntry({
        code: DEFAULT_BROWSER_REPL_CODE,
        ctx,
        scope: {},
      }),
    ).resolves.toEqual({
      code: DEFAULT_BROWSER_REPL_CODE,
      output: JSON.stringify({ projects: [{ id: "proj_123" }], total: 1, limit: 5 }, null, 2),
      status: "success",
    });
  });

  test("session snippets can reference previous local variables", async () => {
    const scope: Record<string, unknown> = {};

    await expect(
      evalBrowserReplSessionCode({
        code: "const answer = 41",
        ctx: {},
        scope,
      }),
    ).resolves.toBeUndefined();

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
    ).resolves.toBeUndefined();

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
    ).resolves.toBeUndefined();

    await expect(
      evalBrowserReplSessionCode({
        code: "first + second",
        ctx: {},
        scope,
      }),
    ).resolves.toBe(42);
  });

  test("session snippets persist function and class declarations", async () => {
    const scope: Record<string, unknown> = {};

    await expect(
      evalBrowserReplSessionCode({
        code: "function answer() { return 42; }",
        ctx: {},
        scope,
      }),
    ).resolves.toBeUndefined();
    await expect(
      evalBrowserReplSessionCode({
        code: "answer()",
        ctx: {},
        scope,
      }),
    ).resolves.toBe(42);

    await expect(
      evalBrowserReplSessionCode({
        code: "class Box { value() { return answer(); } }",
        ctx: {},
        scope,
      }),
    ).resolves.toBeUndefined();
    await expect(
      evalBrowserReplSessionCode({
        code: "new Box().value()",
        ctx: {},
        scope,
      }),
    ).resolves.toBe(42);

    await expect(
      evalBrowserReplSessionCode({
        code: "async function asyncAnswer() { return answer(); }",
        ctx: {},
        scope,
      }),
    ).resolves.toBeUndefined();
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
    ).resolves.toBeUndefined();

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
