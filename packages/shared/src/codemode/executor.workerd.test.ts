/**
 * Integration tests for CodemodeExecutor — runs in real Workers runtime
 * via vitest-pool-workers with a real WorkerLoader binding.
 *
 * Adapted from @cloudflare/codemode (cloudflare/agents):
 * https://github.com/cloudflare/agents/blob/main/packages/codemode/src/tests/executor.test.ts
 */
import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:workers";
import { CodemodeExecutor, type ResolvedProvider } from "./executor.ts";
import type { ToolProvider, CodemodeEvent } from "./types.ts";

function makeProvider(
  executeFn: (path: string[], payload: unknown) => Promise<unknown>,
): ToolProvider {
  return {
    executeToolFunction: executeFn,
    async describeToolFunctions() {
      return { typeDefinitions: "" };
    },
  };
}

function simpleProvider(fns: Record<string, (payload: unknown) => Promise<unknown>>): ToolProvider {
  return makeProvider(async (path, payload) => {
    const name = path.join(".");
    const fn = fns[name];
    if (!fn) throw new Error(`Tool "${name}" not found`);
    return fn(payload);
  });
}

function collectEvents() {
  const events: CodemodeEvent[] = [];
  return {
    events,
    onEvent: (event: CodemodeEvent) => events.push(event),
  };
}

const blockId = "cblk_test";

describe("CodemodeExecutor", () => {
  it("executes simple code that returns a value", async () => {
    const executor = new CodemodeExecutor({ loader: env.LOADER });
    const { events, onEvent } = collectEvents();

    const result = await executor.execute({
      code: "async () => 42",
      providers: [],
      blockId,
      onEvent,
    });

    expect(result.result).toBe(42);
    expect(result.error).toBeUndefined();
  });

  it("calls tool functions via proxy", async () => {
    const add = vi.fn(async (payload: unknown) => {
      const { a, b } = payload as { a: number; b: number };
      return a + b;
    });
    const executor = new CodemodeExecutor({ loader: env.LOADER });
    const { events, onEvent } = collectEvents();

    const result = await executor.execute({
      code: "async () => await tools.add({ a: 3, b: 4 })",
      providers: [{ path: ["tools"], provider: simpleProvider({ add }) }],
      blockId,
      onEvent,
    });

    expect(result.result).toBe(7);
    expect(add).toHaveBeenCalledWith({ a: 3, b: 4 });
  });

  it("emits tool-function-call events", async () => {
    const echo = vi.fn(async (payload: unknown) => payload);
    const executor = new CodemodeExecutor({ loader: env.LOADER });
    const { events, onEvent } = collectEvents();

    await executor.execute({
      code: 'async () => await tools.echo({ msg: "hi" })',
      providers: [{ path: ["tools"], provider: simpleProvider({ echo }) }],
      blockId,
      onEvent,
    });

    const requested = events.find((e) => e.type === "codemode-tool-function-call-requested");
    const succeeded = events.find((e) => e.type === "codemode-tool-function-call-succeeded");

    expect(requested).toBeDefined();
    expect(succeeded).toBeDefined();
    if (requested?.type === "codemode-tool-function-call-requested") {
      expect(requested.path).toEqual(["echo"]);
      expect(requested.payload).toEqual({ msg: "hi" });
    }
  });

  it("emits tool-function-call-failed on error", async () => {
    const failing = async () => {
      throw new Error("boom");
    };
    const executor = new CodemodeExecutor({ loader: env.LOADER });
    const { events, onEvent } = collectEvents();

    await executor.execute({
      code: "async () => await tools.failing({})",
      providers: [{ path: ["tools"], provider: simpleProvider({ failing }) }],
      blockId,
      onEvent,
    });

    const failed = events.find((e) => e.type === "codemode-tool-function-call-failed");
    expect(failed).toBeDefined();
    if (failed?.type === "codemode-tool-function-call-failed") {
      expect(failed.error).toBe("boom");
    }
  });

  it("captures console output in result logs", async () => {
    const executor = new CodemodeExecutor({ loader: env.LOADER });
    const { events, onEvent } = collectEvents();

    const result = await executor.execute({
      code: 'async () => { console.log("hello"); console.warn("careful"); return "done"; }',
      providers: [],
      blockId,
      onEvent,
    });

    expect(result.result).toBe("done");
    expect(result.logs).toContain("hello");
    expect(result.logs?.some((m) => m.includes("careful"))).toBe(true);
  });

  it("supports nested provider paths", async () => {
    const doIt = vi.fn(async (payload: unknown) => {
      const { x } = payload as { x: string };
      return `done:${x}`;
    });
    const executor = new CodemodeExecutor({ loader: env.LOADER });
    const { events, onEvent } = collectEvents();

    const result = await executor.execute({
      code: 'async () => await mcp.linear.doIt({ x: "hi" })',
      providers: [{ path: ["mcp", "linear"], provider: simpleProvider({ doIt }) }],
      blockId,
      onEvent,
    });

    expect(result.result).toBe("done:hi");
    expect(doIt).toHaveBeenCalledWith({ x: "hi" });
  });

  it("supports multiple providers", async () => {
    const storeGet = vi.fn(async () => ({ from: "store" }));
    const cacheGet = vi.fn(async () => ({ from: "cache" }));
    const executor = new CodemodeExecutor({ loader: env.LOADER });
    const { events, onEvent } = collectEvents();

    const result = await executor.execute({
      code: `async () => {
        const a = await store.get({});
        const b = await cache.get({});
        return { a, b };
      }`,
      providers: [
        { path: ["store"], provider: simpleProvider({ get: storeGet }) },
        { path: ["cache"], provider: simpleProvider({ get: cacheGet }) },
      ],
      blockId,
      onEvent,
    });

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({
      a: { from: "store" },
      b: { from: "cache" },
    });
  });

  it("returns error when code throws", async () => {
    const executor = new CodemodeExecutor({ loader: env.LOADER });
    const { events, onEvent } = collectEvents();

    const result = await executor.execute({
      code: 'async () => { throw new Error("boom"); }',
      providers: [],
      blockId,
      onEvent,
    });

    expect(result.error).toBe("boom");
  });

  it("handles concurrent tool function calls via Promise.all", async () => {
    const slow = async (payload: unknown) => {
      const { id } = payload as { id: number };
      return { id };
    };
    const executor = new CodemodeExecutor({ loader: env.LOADER });
    const { events, onEvent } = collectEvents();

    const result = await executor.execute({
      code: `async () => {
        const [a, b, c] = await Promise.all([
          tools.slow({ id: 1 }),
          tools.slow({ id: 2 }),
          tools.slow({ id: 3 })
        ]);
        return [a, b, c];
      }`,
      providers: [{ path: ["tools"], provider: simpleProvider({ slow }) }],
      blockId,
      onEvent,
    });

    expect(result.result).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  it("handles timeout", async () => {
    const executor = new CodemodeExecutor({
      loader: env.LOADER,
      timeout: 100,
    });
    const { events, onEvent } = collectEvents();

    const result = await executor.execute({
      code: "async () => { await new Promise(r => setTimeout(r, 5000)); return 'done'; }",
      providers: [],
      blockId,
      onEvent,
    });

    expect(result.error).toContain("timed out");
  });

  it("normalizes bare expressions", async () => {
    const executor = new CodemodeExecutor({ loader: env.LOADER });
    const { events, onEvent } = collectEvents();

    const result = await executor.execute({
      code: "42",
      providers: [],
      blockId,
      onEvent,
    });

    expect(result.result).toBe(42);
  });

  it("strips markdown fences", async () => {
    const executor = new CodemodeExecutor({ loader: env.LOADER });
    const { events, onEvent } = collectEvents();

    const result = await executor.execute({
      code: "```js\n1 + 1\n```",
      providers: [],
      blockId,
      onEvent,
    });

    expect(result.result).toBe(2);
  });

  it("blocks external fetch by default", async () => {
    const executor = new CodemodeExecutor({ loader: env.LOADER });
    const { events, onEvent } = collectEvents();

    const result = await executor.execute({
      code: 'async () => { const r = await fetch("https://example.com"); return r.status; }',
      providers: [],
      blockId,
      onEvent,
    });

    expect(result.error).toBeDefined();
  });

  it("rejects duplicate provider paths", async () => {
    const executor = new CodemodeExecutor({ loader: env.LOADER });
    const { events, onEvent } = collectEvents();
    const provider = simpleProvider({});

    const result = await executor.execute({
      code: "async () => 1",
      providers: [
        { path: ["dup"], provider },
        { path: ["dup"], provider },
      ],
      blockId,
      onEvent,
    });

    expect(result.error).toContain("Duplicate");
  });

  it("rejects conflicting provider paths", async () => {
    const executor = new CodemodeExecutor({ loader: env.LOADER });
    const { events, onEvent } = collectEvents();
    const provider = simpleProvider({});

    const result = await executor.execute({
      code: "async () => 1",
      providers: [
        { path: ["mcp"], provider },
        { path: ["mcp", "linear"], provider },
      ],
      blockId,
      onEvent,
    });

    expect(result.error).toContain("conflicts");
  });

  it("rejects reserved path segments", async () => {
    const executor = new CodemodeExecutor({ loader: env.LOADER });
    const { events, onEvent } = collectEvents();
    const provider = simpleProvider({});

    const result = await executor.execute({
      code: "async () => 1",
      providers: [{ path: ["__dispatchers"], provider }],
      blockId,
      onEvent,
    });

    expect(result.error).toContain("reserved");
  });

  it("works with empty providers array", async () => {
    const executor = new CodemodeExecutor({ loader: env.LOADER });
    const { events, onEvent } = collectEvents();

    const result = await executor.execute({
      code: "async () => 42",
      providers: [],
      blockId,
      onEvent,
    });

    expect(result.result).toBe(42);
  });

  it("supports deep sub-paths in tool function calls", async () => {
    const provider = makeProvider(async (path, payload) => {
      return { path, payload };
    });
    const executor = new CodemodeExecutor({ loader: env.LOADER });
    const { events, onEvent } = collectEvents();

    const result = await executor.execute({
      code: 'async () => await mcp.files.read({ name: "test.txt" })',
      providers: [{ path: ["mcp"], provider }],
      blockId,
      onEvent,
    });

    expect(result.result).toEqual({
      path: ["files", "read"],
      payload: { name: "test.txt" },
    });
  });
});
