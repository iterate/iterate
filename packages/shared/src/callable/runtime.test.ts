import { env } from "cloudflare:test";
import { describe, expect, test, vi } from "vitest";
import {
  buildCallableRequest,
  connectCallableWebSocket,
  dispatchCallableFetch,
  validateCallable,
} from "./runtime.ts";
import type { Callable } from "./types.ts";
import workerEntry, { CallableTestDurableObject } from "./entry.workerd.vitest.ts";

void workerEntry;
void CallableTestDurableObject;

const testEnv = env as {
  CALLABLE_TEST_DURABLE_OBJECT: DurableObjectNamespace;
};

describe("callable validation", () => {
  test("accepts a JSON round-tripped fetch callable", () => {
    const callable = {
      schemaVersion: "callable/v1",
      kind: "fetch",
      target: { type: "http", upstream: "https://api.example.com/v1" },
    } satisfies Callable;

    expect(validateCallable({ callable: JSON.parse(JSON.stringify(callable)) })).toEqual(callable);
  });

  test("rejects upstream query because query rewrite semantics are not in v1", () => {
    expect(() =>
      validateCallable({
        callable: {
          schemaVersion: "callable/v1",
          kind: "fetch",
          target: { type: "http", upstream: "https://api.example.com/v1?x=1" },
        },
      }),
    ).toThrow("Invalid callable");
  });
});

describe("dispatchCallableFetch", () => {
  test("prefixes incoming paths onto the upstream path by default", async () => {
    const response = await dispatchCallableFetch({
      callable: {
        schemaVersion: "callable/v1",
        kind: "fetch",
        target: { type: "http", upstream: "https://api.example.com/v1" },
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

  test("uses pathMode replace when the upstream path is the complete target path", async () => {
    const response = await dispatchCallableFetch({
      callable: {
        schemaVersion: "callable/v1",
        kind: "fetch",
        target: {
          type: "http",
          upstream: "https://api.example.com/status",
          pathMode: "replace",
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
        schemaVersion: "callable/v1",
        kind: "fetch",
        target: { type: "http", upstream: "https://api.example.com" },
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

  test("dispatches to a service-like binding through env", async () => {
    const response = await dispatchCallableFetch({
      callable: {
        schemaVersion: "callable/v1",
        kind: "fetch",
        target: {
          type: "service",
          binding: { $binding: "ECHO_SERVICE" },
          pathPrefix: "/internal",
        },
      },
      request: new Request("https://router.local/orders/1", { method: "PATCH", body: "patched" }),
      ctx: {
        env: {
          ECHO_SERVICE: { fetch: createEchoResponse },
        },
      },
    });

    await expect(response.json()).resolves.toMatchObject({
      method: "PATCH",
      path: "/internal/orders/1",
      body: "patched",
    });
  });

  test("dispatches to a Durable Object by name", async () => {
    const response = await dispatchCallableFetch({
      callable: {
        schemaVersion: "callable/v1",
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
        schemaVersion: "callable/v1",
        kind: "fetch",
        target: {
          type: "durable-object",
          binding: { $binding: "CALLABLE_TEST_DURABLE_OBJECT" },
          address: { type: "id", id },
          pathPrefix: "/exact",
          pathMode: "replace",
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
          schemaVersion: "callable/v1",
          kind: "fetch",
          target: { type: "http", upstream: "https://api.example.com" },
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
          schemaVersion: "callable/v1",
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
  test("builds a JSON request from a payload template", async () => {
    const request = buildCallableRequest({
      callable: {
        schemaVersion: "callable/v1",
        kind: "fetch",
        target: { type: "http", upstream: "https://api.example.com/tools" },
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
        schemaVersion: "callable/v1",
        kind: "fetch",
        target: {
          type: "durable-object",
          binding: { $binding: "CALLABLE_TEST_DURABLE_OBJECT" },
          address: { type: "name", name: "websocket-target" },
          pathPrefix: "/socket",
          pathMode: "replace",
        },
      },
      ctx: { env: testEnv },
    });

    const message = await new Promise((resolve) => {
      ws.addEventListener("message", (event) => resolve(event.data), { once: true });
    });
    expect(message).toBe("connected");
  });
});

async function createEchoResponse(request: Request) {
  const url = new URL(request.url);
  return Response.json({
    method: request.method,
    path: url.pathname,
    query: url.search,
    body: request.body ? await request.text() : "",
  });
}
