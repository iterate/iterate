import { describe, expect, test } from "vitest";
import { Callable, CallableError, dispatchCallable } from "./callable.ts";

describe("Callable / dispatchCallable", () => {
  test("fetch http POSTs the payload and returns the parsed JSON body", async () => {
    const calls: Array<{ url: string; body: string; method: string | undefined }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input.toString(), init);
      calls.push({
        url: req.url,
        body: await req.clone().text(),
        method: req.method,
      });
      return new Response(JSON.stringify({ hello: "world" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;
    try {
      const result = await dispatchCallable<{ hello: string }>({
        callable: Callable.parse({
          kind: "fetch",
          target: { type: "http", url: "https://example.test/types" },
        }),
        payload: { foo: 1 },
        ctx: { env: {} },
      });
      expect(result).toEqual({ hello: "world" });
      expect(calls).toEqual([
        {
          url: "https://example.test/types",
          method: "POST",
          body: JSON.stringify({ foo: 1 }),
        },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("fetch http throws CallableError on non-2xx", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("nope", { status: 503 })) as typeof globalThis.fetch;
    try {
      await expect(
        dispatchCallable({
          callable: Callable.parse({
            kind: "fetch",
            target: { type: "http", url: "https://example.test/x" },
          }),
          payload: null,
          ctx: { env: {} },
        }),
      ).rejects.toMatchObject({
        constructor: CallableError,
        status: 503,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rpc service binding invokes the named method with the payload", async () => {
    const seen: Array<{ name: string; payload: unknown }> = [];
    const stub = {
      callTool: async (payload: { name: string; args: unknown }) => {
        seen.push({ name: payload.name, payload: payload.args });
        return { ok: true };
      },
    };
    const result = await dispatchCallable<{ ok: boolean }>({
      callable: Callable.parse({
        kind: "rpc",
        target: { type: "service", binding: { $binding: "STUB" } },
        rpcMethod: "callTool",
        argsMode: "object",
      }),
      payload: { name: "search", args: { q: "hi" } },
      ctx: { env: { STUB: stub } as Record<string, unknown> },
    });
    expect(result).toEqual({ ok: true });
    expect(seen).toEqual([{ name: "search", payload: { q: "hi" } }]);
  });

  test("rpc positional spreads the array payload", async () => {
    const stub = {
      add: async (a: number, b: number) => a + b,
    };
    const result = await dispatchCallable<number>({
      callable: Callable.parse({
        kind: "rpc",
        target: { type: "service", binding: { $binding: "STUB" } },
        rpcMethod: "add",
        argsMode: "positional",
      }),
      payload: [2, 3],
      ctx: { env: { STUB: stub } as Record<string, unknown> },
    });
    expect(result).toBe(5);
  });

  test("rpc throws if the binding has no such method", async () => {
    await expect(
      dispatchCallable({
        callable: Callable.parse({
          kind: "rpc",
          target: { type: "service", binding: { $binding: "STUB" } },
          rpcMethod: "missing",
          argsMode: "object",
        }),
        payload: null,
        ctx: { env: { STUB: {} } as Record<string, unknown> },
      }),
    ).rejects.toThrow(/RPC method "missing" not found/);
  });

  test("rpc throws if the binding is missing from env", async () => {
    await expect(
      dispatchCallable({
        callable: Callable.parse({
          kind: "rpc",
          target: { type: "service", binding: { $binding: "MISSING" } },
          rpcMethod: "x",
          argsMode: "object",
        }),
        payload: null,
        ctx: { env: {} },
      }),
    ).rejects.toThrow(/Binding "MISSING" not present in env/);
  });
});
