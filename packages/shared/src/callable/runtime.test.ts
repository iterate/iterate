import { env } from "cloudflare:test";
import { describe, expect, test, vi } from "vitest";
import {
  buildCallableRequest,
  connectCallableWebSocket,
  dispatchCallable,
  dispatchCallableFetch,
  validateCallable,
} from "./runtime.ts";
import { CALLABLE_SCHEMA, type Callable } from "./types.ts";
import workerEntry, { CallableTestDurableObject } from "./entry.workerd.vitest.ts";

void workerEntry;
void CallableTestDurableObject;

const testEnv = env as {
  CALLABLE_TEST_DURABLE_OBJECT: DurableObjectNamespace;
  CALLABLE_TEST_SERVICE: {
    fetch: (request: Request) => Promise<Response>;
    echo: (input: unknown) => Promise<unknown>;
    join: (left: string, right: string) => Promise<string>;
  };
};

describe("callable validation", () => {
  test("accepts a JSON round-tripped fetch callable with the default schema", () => {
    const callable = {
      kind: "fetch",
      target: { type: "http", url: "https://api.example.com/v1" },
    } satisfies Callable;

    expect(validateCallable({ callable: JSON.parse(JSON.stringify(callable)) })).toEqual(callable);
  });

  test("accepts the explicit schema URL when a stored record wants to be self-describing", () => {
    const callable = {
      schema: CALLABLE_SCHEMA,
      kind: "fetch",
      target: { type: "http", url: "https://api.example.com/v1" },
    } satisfies Callable;

    expect(validateCallable({ callable })).toEqual(callable);
  });

  test("rejects legacy schemaVersion because v1 has no backwards-compatibility layer", () => {
    expect(() =>
      validateCallable({
        callable: {
          schemaVersion: "callable/v1",
          kind: "fetch",
          target: { type: "http", url: "https://api.example.com/v1" },
        },
      }),
    ).toThrow("Invalid callable");
  });

  test("rejects URL query because query rewrite semantics are not in v1", () => {
    expect(() =>
      validateCallable({
        callable: {
          kind: "fetch",
          target: { type: "http", url: "https://api.example.com/v1?x=1" },
        },
      }),
    ).toThrow("Invalid callable");
  });

  test("rejects protocol-relative path prefixes for synthetic binding URLs", () => {
    expect(() =>
      validateCallable({
        callable: {
          kind: "fetch",
          target: {
            type: "service",
            binding: { $binding: "CALLABLE_TEST_SERVICE" },
            pathPrefix: "//evil.example/internal",
          },
        },
      }),
    ).toThrow("Invalid callable");
  });

  test("rejects dangerous RPC method names and dotted paths", () => {
    for (const rpcMethod of ["then", "__proto__", "fetch", "users.byId"]) {
      expect(() =>
        validateCallable({
          callable: {
            kind: "rpc",
            target: { type: "service", binding: { $binding: "CALLABLE_TEST_SERVICE" } },
            rpcMethod,
          },
        }),
      ).toThrow("Invalid callable");
    }
  });
});

describe("dispatchCallable", () => {
  test("posts JSON by default for fetch callables and parses JSON responses", async () => {
    const value = await dispatchCallable({
      callable: {
        kind: "fetch",
        target: { type: "service", binding: { $binding: "CALLABLE_TEST_SERVICE" } },
      },
      payload: { title: "Bug" },
      ctx: { env: testEnv },
    });

    expect(value).toMatchObject({
      target: "service",
      method: "POST",
      path: "/",
      body: '{"title":"Bug"}',
      contentType: "application/json",
    });
  });

  test("serializes undefined payloads as JSON null in the default request template", async () => {
    const request = buildCallableRequest({
      callable: {
        kind: "fetch",
        target: { type: "http", url: "https://api.example.com/tools" },
      },
      payload: undefined,
    });

    await expect(request.text()).resolves.toBe("null");
  });

  test("parses text responses when the response is not JSON", async () => {
    const value = await dispatchCallable({
      callable: {
        kind: "fetch",
        target: { type: "http", url: "https://api.example.com/text" },
      },
      payload: { ignored: true },
      ctx: {
        fetcher: async () =>
          new Response("plain text result", { headers: { "content-type": "text/plain" } }),
      },
    });

    expect(value).toBe("plain text result");
  });

  test("includes the response body when fetch callables return non-2xx", async () => {
    await expect(
      dispatchCallable({
        callable: {
          kind: "fetch",
          target: { type: "http", url: "https://api.example.com/fail" },
        },
        payload: { ignored: true },
        ctx: {
          fetcher: async () => new Response("bad input", { status: 400, statusText: "Bad" }),
        },
      }),
    ).rejects.toMatchObject({
      code: "REMOTE_ERROR",
      retryable: false,
      details: {
        status: 400,
        statusText: "Bad",
        body: "bad input",
      },
    });
  });

  test("keeps raw Request payloads on the streaming-only API", async () => {
    await expect(
      dispatchCallable({
        callable: {
          kind: "fetch",
          target: { type: "http", url: "https://api.example.com" },
        },
        payload: new Request("https://router.local/upload"),
        ctx: { fetcher: vi.fn() },
      }),
    ).rejects.toMatchObject({
      code: "PAYLOAD_VALIDATION_FAILED",
    });
  });

  test("dispatches object-mode service RPC", async () => {
    const value = await dispatchCallable({
      callable: {
        kind: "rpc",
        target: { type: "service", binding: { $binding: "CALLABLE_TEST_SERVICE" } },
        rpcMethod: "echo",
      },
      payload: { ok: true },
      ctx: { env: testEnv },
    });

    expect(value).toEqual({ target: "service", input: { ok: true } });
  });

  test("dispatches positional service RPC", async () => {
    const value = await dispatchCallable({
      callable: {
        kind: "rpc",
        target: { type: "service", binding: { $binding: "CALLABLE_TEST_SERVICE" } },
        rpcMethod: "join",
        argsMode: "positional",
      },
      payload: ["left", "right"],
      ctx: { env: testEnv },
    });

    expect(value).toBe("left:right");
  });

  test("dispatches object-mode Durable Object RPC", async () => {
    const value = await dispatchCallable({
      callable: {
        kind: "rpc",
        target: {
          type: "durable-object",
          binding: { $binding: "CALLABLE_TEST_DURABLE_OBJECT" },
          address: { type: "name", name: "rpc-object-target" },
        },
        rpcMethod: "echo",
      },
      payload: { ok: true },
      ctx: { env: testEnv },
    });

    expect(value).toEqual({ target: "durable-object", input: { ok: true } });
  });

  test("dispatches positional Durable Object RPC", async () => {
    const value = await dispatchCallable({
      callable: {
        kind: "rpc",
        target: {
          type: "durable-object",
          binding: { $binding: "CALLABLE_TEST_DURABLE_OBJECT" },
          address: { type: "name", name: "rpc-positional-target" },
        },
        rpcMethod: "join",
        argsMode: "positional",
      },
      payload: ["left", "right"],
      ctx: { env: testEnv },
    });

    expect(value).toBe("left:right");
  });

  test("rejects non-array payloads for positional RPC", async () => {
    await expect(
      dispatchCallable({
        callable: {
          kind: "rpc",
          target: { type: "service", binding: { $binding: "CALLABLE_TEST_SERVICE" } },
          rpcMethod: "join",
          argsMode: "positional",
        },
        payload: { left: "left", right: "right" },
        ctx: { env: testEnv },
      }),
    ).rejects.toMatchObject({
      code: "PAYLOAD_VALIDATION_FAILED",
    });
  });

  test("lets missing methods surface as remote RPC errors on real platform stubs", async () => {
    await expect(
      dispatchCallable({
        callable: {
          kind: "rpc",
          target: { type: "service", binding: { $binding: "CALLABLE_TEST_SERVICE" } },
          rpcMethod: "missingMethod",
        },
        payload: null,
        ctx: { env: testEnv },
      }),
    ).rejects.toMatchObject({
      remote: true,
      message: 'The RPC receiver does not implement the method "missingMethod".',
    });
  });
});

describe("dispatchCallableFetch", () => {
  test("prefixes incoming paths onto the base URL path by default", async () => {
    const response = await dispatchCallableFetch({
      callable: {
        kind: "fetch",
        target: { type: "http", url: "https://api.example.com/v1" },
      },
      request: new Request("https://router.local/users/123?expand=items", { method: "POST" }),
      ctx: {
        fetcher: async (request) => Response.json({ url: request.url, method: request.method }),
      },
    });

    await expect(response.json()).resolves.toEqual({
      url: "https://api.example.com/v1/users/123?expand=items",
      method: "POST",
    });
  });

  test("uses pathMode replace when the base URL path is the complete target path", async () => {
    const response = await dispatchCallableFetch({
      callable: {
        kind: "fetch",
        pathMode: "replace",
        target: {
          type: "http",
          url: "https://api.example.com/status",
        },
      },
      request: new Request("https://router.local/users/123?expand=items"),
      ctx: {
        fetcher: async (request) => Response.json({ url: request.url }),
      },
    });

    await expect(response.json()).resolves.toEqual({
      url: "https://api.example.com/status?expand=items",
    });
  });

  test("does not read the request body in proxy mode", async () => {
    const request = new Request("https://router.local/upload", {
      method: "POST",
      body: "streamed-body",
    });

    const response = await dispatchCallableFetch({
      callable: {
        kind: "fetch",
        target: { type: "http", url: "https://api.example.com" },
      },
      request,
      ctx: {
        fetcher: async (outboundRequest) => {
          expect(request.bodyUsed).toBe(false);
          return new Response(await outboundRequest.text());
        },
      },
    });

    await expect(response.text()).resolves.toBe("streamed-body");
  });

  test("dispatches to a real service binding fetch handler through env", async () => {
    const response = await dispatchCallableFetch({
      callable: {
        kind: "fetch",
        target: {
          type: "service",
          binding: { $binding: "CALLABLE_TEST_SERVICE" },
          pathPrefix: "/internal",
        },
      },
      request: new Request("https://router.local/orders/1", { method: "PATCH", body: "patched" }),
      ctx: { env: testEnv },
    });

    await expect(response.json()).resolves.toMatchObject({
      target: "service",
      method: "PATCH",
      path: "/internal/orders/1",
      body: "patched",
    });
  });

  test("uses manual redirects for service binding fetch dispatch", async () => {
    const response = await dispatchCallableFetch({
      callable: {
        kind: "fetch",
        pathMode: "replace",
        target: {
          type: "service",
          binding: { $binding: "CALLABLE_TEST_SERVICE" },
          pathPrefix: "/redirect",
        },
      },
      request: new Request("https://router.local/orders/1"),
      ctx: { env: testEnv },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://public.example.com/leak");
  });

  test("dispatches to a Durable Object by name", async () => {
    const response = await dispatchCallableFetch({
      callable: {
        kind: "fetch",
        target: {
          type: "durable-object",
          binding: { $binding: "CALLABLE_TEST_DURABLE_OBJECT" },
          address: { type: "name", name: "named-target" },
          pathPrefix: "/do",
        },
      },
      request: new Request("https://router.local/messages?limit=1"),
      ctx: { env: testEnv },
    });

    await expect(response.json()).resolves.toMatchObject({
      path: "/do/messages",
      query: "?limit=1",
    });
  });

  test("dispatches to a Durable Object by id", async () => {
    const id = testEnv.CALLABLE_TEST_DURABLE_OBJECT.idFromName("id-target").toString();
    const response = await dispatchCallableFetch({
      callable: {
        kind: "fetch",
        pathMode: "replace",
        target: {
          type: "durable-object",
          binding: { $binding: "CALLABLE_TEST_DURABLE_OBJECT" },
          address: { type: "id", id },
          pathPrefix: "/exact",
        },
      },
      request: new Request("https://router.local/messages?limit=1"),
      ctx: { env: testEnv },
    });

    await expect(response.json()).resolves.toMatchObject({
      path: "/exact",
      query: "?limit=1",
    });
  });

  test("rejects a consumed proxy request body", async () => {
    const request = new Request("https://router.local/upload", {
      method: "POST",
      body: "already-read",
    });
    await request.text();

    await expect(
      dispatchCallableFetch({
        callable: {
          kind: "fetch",
          target: { type: "http", url: "https://api.example.com" },
        },
        request,
        ctx: { fetcher: vi.fn() },
      }),
    ).rejects.toThrow("Request body was already consumed");
  });

  test("wraps invalid Durable Object ids as callable resolution errors", async () => {
    await expect(
      dispatchCallableFetch({
        callable: {
          kind: "fetch",
          target: {
            type: "durable-object",
            binding: { $binding: "CALLABLE_TEST_DURABLE_OBJECT" },
            address: { type: "id", id: "not-a-valid-id" },
          },
        },
        request: new Request("https://router.local/messages"),
        ctx: { env: testEnv },
      }),
    ).rejects.toMatchObject({
      code: "RESOLUTION_FAILED",
    });
  });
});

describe("buildCallableRequest", () => {
  test("builds a JSON request from an explicit payload template", async () => {
    const request = buildCallableRequest({
      callable: {
        kind: "fetch",
        target: { type: "http", url: "https://api.example.com/tools" },
        requestTemplate: {
          method: "POST",
          headers: { "x-tool": "create-issue" },
          query: { dryRun: true },
          body: { type: "json", from: "payload" },
        },
      },
      payload: { title: "Bug" },
    });

    expect(request.url).toBe("https://api.example.com/tools?dryRun=true");
    expect(request.method).toBe("POST");
    expect(request.headers.get("x-tool")).toBe("create-issue");
    expect(request.headers.get("content-type")).toBe("application/json");
    await expect(request.json()).resolves.toEqual({ title: "Bug" });
  });
});

describe("connectCallableWebSocket", () => {
  test("connects through a Durable Object fetch target", async () => {
    const ws = await connectCallableWebSocket({
      callable: {
        kind: "fetch",
        pathMode: "replace",
        target: {
          type: "durable-object",
          binding: { $binding: "CALLABLE_TEST_DURABLE_OBJECT" },
          address: { type: "name", name: "websocket-target" },
          pathPrefix: "/socket",
        },
      },
      ctx: { env: testEnv },
    });

    const closed = new Promise((resolve) => {
      ws.addEventListener("close", resolve, { once: true });
    });
    const message = await new Promise((resolve) => {
      ws.addEventListener("message", (event) => resolve(event.data), { once: true });
    });
    expect(message).toBe("connected");
    await closed;
  });
});
