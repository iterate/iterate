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
  CALLABLE_TEST_LOADER: unknown;
  CALLABLE_TEST_SERVICE: {
    fetch: (request: Request) => Promise<Response>;
    echo: (input: unknown) => Promise<unknown>;
    join: (left: string, right: string) => Promise<string>;
  };
};

const dynamicWorkerCode = {
  compatibilityDate: "2026-04-27",
  mainModule: "worker.js",
  modules: {
    "worker.js": `
      import { WorkerEntrypoint } from "cloudflare:workers";

      export default class extends WorkerEntrypoint {
        async fetch(request) {
          const url = new URL(request.url);
          return Response.json({
            target: "dynamic-worker",
            method: request.method,
            path: url.pathname,
            query: url.search,
            body: await request.text(),
            contentType: request.headers.get("content-type"),
          });
        }

        echo(input) {
          return { target: "dynamic-worker", input };
        }

        join(left, right) {
          return left + ":" + right;
        }
      }
    `,
  },
} as const;

async function dispatchThroughHostWorker(options: { callable: Callable; payload: unknown }) {
  const response = await workerEntry.fetch(
    new Request("https://host.local/dispatch", {
      method: "POST",
      body: JSON.stringify(options),
    }),
    testEnv,
  );
  return await response.json();
}

describe("callable validation", () => {
  test("accepts a JSON round-tripped fetch callable with the default schema", () => {
    const callable = {
      target: { type: "http", url: "https://api.example.com/v1" },
    } satisfies Callable;

    expect(validateCallable({ callable: JSON.parse(JSON.stringify(callable)) })).toEqual(callable);
  });

  test("accepts the explicit schema URL when a stored record wants to be self-describing", () => {
    const callable = {
      schema: CALLABLE_SCHEMA,
      target: { type: "http", url: "https://api.example.com/v1" },
    } satisfies Callable;

    expect(validateCallable({ callable })).toEqual(callable);
  });

  test("rejects legacy schemaVersion because v1 has no backwards-compatibility layer", () => {
    expect(() =>
      validateCallable({
        callable: {
          schemaVersion: "callable/v1",
          target: { type: "http", url: "https://api.example.com/v1" },
        },
      }),
    ).toThrow("Invalid callable");
  });

  test("accepts URL query and keeps query merging out of v1", () => {
    expect(
      validateCallable({
        callable: {
          target: { type: "http", url: "https://api.example.com/v1?x=1" },
        },
      }),
    ).toEqual({
      target: { type: "http", url: "https://api.example.com/v1?x=1" },
    });
  });

  test("rejects HTTP URLs with credentials", () => {
    expect(() =>
      validateCallable({
        callable: {
          target: { type: "http", url: "https://user:pass@api.example.com/v1" },
        },
      }),
    ).toThrow("Invalid callable");
  });

  test("rejects protocol-relative path prefixes for synthetic binding URLs", () => {
    expect(() =>
      validateCallable({
        callable: {
          target: {
            type: "service",
            binding: { $binding: "CALLABLE_TEST_SERVICE" },
          },
          call: { type: "fetch", path: { base: "//evil.example/internal" } },
        },
      }),
    ).toThrow("Invalid callable");
  });

  test("rejects fetch path bases that URL normalization would rewrite", () => {
    for (const base of ["/internal/../admin", "/internal/%2e%2e/admin", "/internal\\admin"]) {
      expect(() =>
        validateCallable({
          callable: {
            target: { type: "service", binding: { $binding: "CALLABLE_TEST_SERVICE" } },
            call: { type: "fetch", path: { base } },
          },
        }),
      ).toThrow("Invalid callable");
    }
  });

  test("rejects dangerous RPC method names and dotted paths", () => {
    for (const rpcMethod of [
      "then",
      "__proto__",
      "fetch",
      "users.byId",
      "toString",
      "valueOf",
      "hasOwnProperty",
      "apply",
      "bind",
      "call",
    ]) {
      expect(() =>
        validateCallable({
          callable: {
            target: { type: "service", binding: { $binding: "CALLABLE_TEST_SERVICE" } },
            call: { type: "rpc", method: rpcMethod },
          },
        }),
      ).toThrow("Invalid callable");
    }
  });

  test("rejects HTTP targets paired with RPC calls at the schema level", () => {
    expect(() =>
      validateCallable({
        callable: {
          target: { type: "http", url: "https://api.example.com/v1" },
          call: { type: "rpc", method: "run" },
        },
      }),
    ).toThrow("Invalid callable");
  });

  test("rejects invalid Dynamic Worker code before dispatch", () => {
    expect(() =>
      validateCallable({
        callable: {
          target: {
            type: "dynamic-worker",
            loader: { $binding: "CALLABLE_TEST_LOADER" },
            code: {
              compatibilityDate: "2026-04-27",
              mainModule: "worker.js",
              modules: { "worker.txt": "export default {}" },
            },
          },
        },
      }),
    ).toThrow("Invalid callable");
  });

  test("rejects Dynamic Worker code whose main module is not present", () => {
    expect(() =>
      validateCallable({
        callable: {
          target: {
            type: "dynamic-worker",
            loader: { $binding: "CALLABLE_TEST_LOADER" },
            code: {
              compatibilityDate: "2026-04-27",
              mainModule: "missing.js",
              modules: { "worker.js": "export default {}" },
            },
          },
        },
      }),
    ).toThrow("Invalid callable");
  });

  test("rejects GET and HEAD request templates with JSON bodies", () => {
    for (const method of ["GET", "HEAD"]) {
      expect(() =>
        validateCallable({
          callable: {
            target: { type: "http", url: "https://api.example.com/v1" },
            call: {
              type: "fetch",
              request: {
                method,
                body: { type: "json", from: "payload" },
              },
            },
          },
        }),
      ).toThrow("Invalid callable");
    }
  });

  test("rejects extra fields in request template bodies", () => {
    expect(() =>
      validateCallable({
        callable: {
          target: { type: "http", url: "https://api.example.com/v1" },
          call: {
            type: "fetch",
            request: {
              method: "POST",
              body: { type: "json", from: "payload", extra: true },
            },
          },
        },
      }),
    ).toThrow("Invalid callable");
  });
});

describe("dispatchCallable", () => {
  test("posts JSON by default for fetch callables and parses JSON responses", async () => {
    const value = await dispatchCallable({
      callable: {
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

  test("does not duplicate fetch path bases when value dispatch delegates to fetch dispatch", async () => {
    const value = await dispatchCallable({
      callable: {
        target: { type: "service", binding: { $binding: "CALLABLE_TEST_SERVICE" } },
        call: { type: "fetch", path: { base: "/internal" } },
      },
      payload: { title: "Bug" },
      ctx: { env: testEnv },
    });

    expect(value).toMatchObject({
      target: "service",
      method: "POST",
      path: "/internal",
      body: '{"title":"Bug"}',
    });
  });

  test("serializes undefined payloads as JSON null in the default request template", async () => {
    const request = buildCallableRequest({
      callable: {
        target: { type: "http", url: "https://api.example.com/tools" },
      },
      payload: undefined,
    });

    await expect(request.text()).resolves.toBe("null");
  });

  test("parses text responses when the response is not JSON", async () => {
    const value = await dispatchCallable({
      callable: {
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

  test("keeps target URL query in value mode unless call request query replaces it", async () => {
    const preserved = await dispatchCallable({
      callable: {
        target: { type: "http", url: "https://api.example.com/tools?fixed=true" },
      },
      payload: { ignored: true },
      ctx: {
        fetcher: async (request) => Response.json({ url: request.url }),
      },
    });

    expect(preserved).toEqual({ url: "https://api.example.com/tools?fixed=true" });

    const replaced = await dispatchCallable({
      callable: {
        target: { type: "http", url: "https://api.example.com/tools?fixed=true" },
        call: {
          type: "fetch",
          request: { query: { dryRun: true } },
        },
      },
      payload: { ignored: true },
      ctx: {
        fetcher: async (request) => Response.json({ url: request.url }),
      },
    });

    expect(replaced).toEqual({ url: "https://api.example.com/tools?dryRun=true" });
  });

  test("requires an explicit fetcher for public HTTP targets", async () => {
    await expect(
      dispatchCallable({
        callable: {
          target: { type: "http", url: "https://api.example.com/tools" },
        },
        payload: { ignored: true },
        ctx: {},
      }),
    ).rejects.toMatchObject({
      code: "RESOLUTION_FAILED",
    });
  });

  test("includes the response body when fetch callables return non-2xx", async () => {
    await expect(
      dispatchCallable({
        callable: {
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
        target: { type: "service", binding: { $binding: "CALLABLE_TEST_SERVICE" } },
        call: { type: "rpc", method: "echo" },
      },
      payload: { ok: true },
      ctx: { env: testEnv },
    });

    expect(value).toEqual({ target: "service", input: { ok: true } });
  });

  test("dispatches positional service RPC", async () => {
    const value = await dispatchCallable({
      callable: {
        target: { type: "service", binding: { $binding: "CALLABLE_TEST_SERVICE" } },
        call: { type: "rpc", method: "join", argsMode: "positional" },
      },
      payload: ["left", "right"],
      ctx: { env: testEnv },
    });

    expect(value).toBe("left:right");
  });

  test("dispatches object-mode Durable Object RPC", async () => {
    const value = await dispatchCallable({
      callable: {
        target: {
          type: "durable-object",
          binding: { $binding: "CALLABLE_TEST_DURABLE_OBJECT" },
          address: { type: "name", name: "rpc-object-target" },
        },
        call: { type: "rpc", method: "echo" },
      },
      payload: { ok: true },
      ctx: { env: testEnv },
    });

    expect(value).toEqual({ target: "durable-object", input: { ok: true } });
  });

  test("dispatches positional Durable Object RPC", async () => {
    const value = await dispatchCallable({
      callable: {
        target: {
          type: "durable-object",
          binding: { $binding: "CALLABLE_TEST_DURABLE_OBJECT" },
          address: { type: "name", name: "rpc-positional-target" },
        },
        call: { type: "rpc", method: "join", argsMode: "positional" },
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
          target: { type: "service", binding: { $binding: "CALLABLE_TEST_SERVICE" } },
          call: { type: "rpc", method: "join", argsMode: "positional" },
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
          target: { type: "service", binding: { $binding: "CALLABLE_TEST_SERVICE" } },
          call: { type: "rpc", method: "missingMethod" },
        },
        payload: null,
        ctx: { env: testEnv },
      }),
    ).rejects.toMatchObject({
      remote: true,
      message: 'The RPC receiver does not implement the method "missingMethod".',
    });
  });

  test("dispatches Dynamic Worker fetch through the same default value path", async () => {
    const value = await dispatchCallable({
      callable: {
        target: {
          type: "dynamic-worker",
          loader: { $binding: "CALLABLE_TEST_LOADER" },
          code: dynamicWorkerCode,
        },
      },
      payload: { title: "Bug" },
      ctx: { env: testEnv },
    });

    expect(value).toMatchObject({
      target: "dynamic-worker",
      method: "POST",
      path: "/",
      body: '{"title":"Bug"}',
      contentType: "application/json",
    });
  });

  test("dispatches object-mode Dynamic Worker RPC", async () => {
    const value = await dispatchCallable({
      callable: {
        target: {
          type: "dynamic-worker",
          loader: { $binding: "CALLABLE_TEST_LOADER" },
          code: dynamicWorkerCode,
          cache: { mode: "get", id: "callable-dynamic-worker-rpc-object" },
        },
        call: { type: "rpc", method: "echo" },
      },
      payload: { ok: true },
      ctx: { env: testEnv },
    });

    expect(value).toEqual({ target: "dynamic-worker", input: { ok: true } });
  });

  test("dispatches positional Dynamic Worker RPC", async () => {
    const value = await dispatchCallable({
      callable: {
        target: {
          type: "dynamic-worker",
          loader: { $binding: "CALLABLE_TEST_LOADER" },
          code: dynamicWorkerCode,
        },
        call: { type: "rpc", method: "join", argsMode: "positional" },
      },
      payload: ["left", "right"],
      ctx: { env: testEnv },
    });

    expect(value).toBe("left:right");
  });

  test("rejects missing Dynamic Worker loader bindings", async () => {
    await expect(
      dispatchCallable({
        callable: {
          target: {
            type: "dynamic-worker",
            loader: { $binding: "MISSING_LOADER" },
            code: dynamicWorkerCode,
          },
        },
        payload: { ok: true },
        ctx: { env: testEnv },
      }),
    ).rejects.toMatchObject({
      code: "RESOLUTION_FAILED",
    });
  });
});

describe("host Worker dispatch combinations", () => {
  test("routes from the host Worker to a service binding fetch target", async () => {
    await expect(
      dispatchThroughHostWorker({
        callable: {
          target: { type: "service", binding: { $binding: "CALLABLE_TEST_SERVICE" } },
          call: { type: "fetch", path: { base: "/host-service", mode: "replace" } },
        },
        payload: { from: "host" },
      }),
    ).resolves.toMatchObject({
      value: {
        target: "service",
        method: "POST",
        path: "/host-service",
        body: '{"from":"host"}',
      },
    });
  });

  test("routes from the host Worker to a Durable Object RPC target", async () => {
    await expect(
      dispatchThroughHostWorker({
        callable: {
          target: {
            type: "durable-object",
            binding: { $binding: "CALLABLE_TEST_DURABLE_OBJECT" },
            address: { type: "name", name: "host-rpc-target" },
          },
          call: { type: "rpc", method: "echo" },
        },
        payload: { from: "host" },
      }),
    ).resolves.toEqual({
      value: { target: "durable-object", input: { from: "host" } },
    });
  });

  test("routes from the host Worker to a Dynamic Worker fetch target", async () => {
    await expect(
      dispatchThroughHostWorker({
        callable: {
          target: {
            type: "dynamic-worker",
            loader: { $binding: "CALLABLE_TEST_LOADER" },
            code: dynamicWorkerCode,
          },
          call: { type: "fetch", path: { base: "/host-dynamic", mode: "replace" } },
        },
        payload: { from: "host" },
      }),
    ).resolves.toMatchObject({
      value: {
        target: "dynamic-worker",
        method: "POST",
        path: "/host-dynamic",
        body: '{"from":"host"}',
      },
    });
  });
});

describe("dispatchCallableFetch", () => {
  test("prefixes incoming paths onto the base URL path by default", async () => {
    const response = await dispatchCallableFetch({
      callable: {
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

  test("uses fetch path replace when the base URL path is the complete target path", async () => {
    const response = await dispatchCallableFetch({
      callable: {
        target: {
          type: "http",
          url: "https://api.example.com/status",
        },
        call: { type: "fetch", path: { mode: "replace" } },
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

  test("proxy mode replaces target query with incoming request query without merging", async () => {
    const response = await dispatchCallableFetch({
      callable: {
        target: { type: "http", url: "https://api.example.com/v1?fixed=true" },
      },
      request: new Request("https://router.local/users?active=true"),
      ctx: {
        fetcher: async (request) => Response.json({ url: request.url }),
      },
    });

    await expect(response.json()).resolves.toEqual({
      url: "https://api.example.com/v1/users?active=true",
    });
  });

  test("does not read the request body in proxy mode", async () => {
    const request = new Request("https://router.local/upload", {
      method: "POST",
      body: "streamed-body",
    });

    const response = await dispatchCallableFetch({
      callable: {
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
        target: {
          type: "service",
          binding: { $binding: "CALLABLE_TEST_SERVICE" },
        },
        call: { type: "fetch", path: { base: "/internal" } },
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
        target: {
          type: "service",
          binding: { $binding: "CALLABLE_TEST_SERVICE" },
        },
        call: { type: "fetch", path: { base: "/redirect", mode: "replace" } },
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
        target: {
          type: "durable-object",
          binding: { $binding: "CALLABLE_TEST_DURABLE_OBJECT" },
          address: { type: "name", name: "named-target" },
        },
        call: { type: "fetch", path: { base: "/do" } },
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
        target: {
          type: "durable-object",
          binding: { $binding: "CALLABLE_TEST_DURABLE_OBJECT" },
          address: { type: "id", id },
        },
        call: { type: "fetch", path: { base: "/exact", mode: "replace" } },
      },
      request: new Request("https://router.local/messages?limit=1"),
      ctx: { env: testEnv },
    });

    await expect(response.json()).resolves.toMatchObject({
      path: "/exact",
      query: "?limit=1",
    });
  });

  test("dispatches to a Dynamic Worker fetch target with request streaming semantics", async () => {
    const request = new Request("https://router.local/orders/1?expand=items", {
      method: "PATCH",
      body: "patched",
    });

    const response = await dispatchCallableFetch({
      callable: {
        target: {
          type: "dynamic-worker",
          loader: { $binding: "CALLABLE_TEST_LOADER" },
          code: dynamicWorkerCode,
          cache: { mode: "get", id: "callable-dynamic-worker-fetch" },
        },
        call: { type: "fetch", path: { base: "/internal" } },
      },
      request,
      ctx: { env: testEnv },
    });

    await expect(response.json()).resolves.toMatchObject({
      target: "dynamic-worker",
      method: "PATCH",
      path: "/internal/orders/1",
      query: "?expand=items",
      body: "patched",
    });
  });

  test("dispatches to a Dynamic Worker fetch target with load mode by default", async () => {
    const response = await dispatchCallableFetch({
      callable: {
        target: {
          type: "dynamic-worker",
          loader: { $binding: "CALLABLE_TEST_LOADER" },
          code: dynamicWorkerCode,
        },
        call: { type: "fetch", path: { base: "/load-mode", mode: "replace" } },
      },
      request: new Request("https://router.local/ignored"),
      ctx: { env: testEnv },
    });

    await expect(response.json()).resolves.toMatchObject({
      target: "dynamic-worker",
      path: "/load-mode",
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
        target: { type: "http", url: "https://api.example.com/tools?fixed=true" },
        call: {
          type: "fetch",
          request: {
            method: "POST",
            headers: { "x-tool": "create-issue" },
            query: { dryRun: true },
            body: { type: "json", from: "payload" },
          },
        },
      },
      payload: { title: "Bug" },
    });

    expect(request.url).toBe("https://callable.local/?dryRun=true");
    expect(request.method).toBe("POST");
    expect(request.headers.get("x-tool")).toBe("create-issue");
    expect(request.headers.get("content-type")).toBe("application/json");
    await expect(request.json()).resolves.toEqual({ title: "Bug" });
  });
});

describe("connectCallableWebSocket", () => {
  test("marks client-side upgrade failures as non-retryable and includes status details", async () => {
    await expect(
      connectCallableWebSocket({
        callable: {
          target: { type: "http", url: "https://api.example.com/socket" },
        },
        ctx: {
          fetcher: async () => new Response("forbidden", { status: 403, statusText: "Forbidden" }),
        },
      }),
    ).rejects.toMatchObject({
      code: "TRANSPORT_FAILED",
      retryable: false,
      details: { status: 403, statusText: "Forbidden" },
    });
  });

  test("connects through a Durable Object fetch target", async () => {
    const ws = await connectCallableWebSocket({
      callable: {
        target: {
          type: "durable-object",
          binding: { $binding: "CALLABLE_TEST_DURABLE_OBJECT" },
          address: { type: "name", name: "websocket-target" },
        },
        call: { type: "fetch", path: { base: "/socket", mode: "replace" } },
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
