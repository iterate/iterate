import { env, exports as workerExports } from "cloudflare:workers";
import { describe, expect, test, vi } from "vitest";
import {
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
  LOADER: unknown;
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

      export class NamedEntrypoint extends WorkerEntrypoint {
        async fetch(request) {
          const url = new URL(request.url);
          return Response.json({
            target: "dynamic-worker-named",
            props: this.ctx.props,
            method: request.method,
            path: url.pathname,
            body: await request.text(),
          });
        }

        echo(input) {
          return { target: "dynamic-worker-named", props: this.ctx.props, input };
        }
      }
    `,
  },
} as const;

async function dispatchThroughHostWorker(options: { callable: Callable; payload: unknown }) {
  const response = await workerExports.default.fetch("https://host.local/dispatch", {
    method: "POST",
    body: JSON.stringify(options),
  });
  return await response.json();
}

describe("callable validation", () => {
  test("accepts a JSON round-tripped fetch callable with the default schema", () => {
    const callable = {
      type: "fetch",
      via: { type: "url", url: "https://api.example.com/v1" },
    } satisfies Callable;

    expect(validateCallable({ callable: JSON.parse(JSON.stringify(callable)) })).toEqual(callable);
  });

  test("accepts the explicit schema URL when a stored record wants to be self-describing", () => {
    const callable = {
      schema: CALLABLE_SCHEMA,
      type: "fetch",
      via: { type: "url", url: "https://api.example.com/v1" },
    } satisfies Callable;

    expect(validateCallable({ callable })).toEqual(callable);
  });

  test("accepts URL query and keeps query merging out of v1", () => {
    expect(
      validateCallable({
        callable: {
          type: "fetch",
          via: { type: "url", url: "https://api.example.com/v1?x=1" },
        },
      }),
    ).toEqual({
      type: "fetch",
      via: { type: "url", url: "https://api.example.com/v1?x=1" },
    });
  });

  test("rejects HTTP URLs with credentials", () => {
    expect(() =>
      validateCallable({
        callable: {
          type: "fetch",
          via: { type: "url", url: "https://user:pass@api.example.com/v1" },
        },
      }),
    ).toThrow("Invalid callable");
  });

  test("rejects protocol-relative path prefixes for synthetic binding URLs", () => {
    expect(() =>
      validateCallable({
        callable: {
          type: "fetch",
          via: {
            type: "env-binding",
            bindingType: "service",
            bindingName: "CALLABLE_TEST_SERVICE",
          },
          fetchRequest: { path: { base: "//evil.example/internal" } },
        },
      }),
    ).toThrow("Invalid callable");
  });

  test("rejects fetch path bases that URL normalization would rewrite", () => {
    for (const base of ["/internal/../admin", "/internal/%2e%2e/admin", "/internal\\admin"]) {
      expect(() =>
        validateCallable({
          callable: {
            type: "fetch",
            via: {
              type: "env-binding",
              bindingType: "service",
              bindingName: "CALLABLE_TEST_SERVICE",
            },
            fetchRequest: { path: { base } },
          },
        }),
      ).toThrow("Invalid callable");
    }
  });

  test("rejects dangerous RPC method names and dotted paths", () => {
    for (const rpcMethod of [
      "then",
      "__proto__",
      "__defineGetter__",
      "__defineSetter__",
      "__lookupGetter__",
      "__lookupSetter__",
      "email",
      "fetch",
      "queue",
      "scheduled",
      "tail",
      "trace",
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
            type: "workers-rpc",
            via: {
              type: "env-binding",
              bindingType: "service",
              bindingName: "CALLABLE_TEST_SERVICE",
            },
            rpcMethod,
          },
        }),
      ).toThrow("Invalid callable");
    }
  });

  test("rejects URL via values paired with Workers RPC at the schema level", () => {
    expect(() =>
      validateCallable({
        callable: {
          type: "workers-rpc",
          via: { type: "url", url: "https://api.example.com/v1" },
          rpcMethod: "run",
        },
      }),
    ).toThrow("Invalid callable");
  });

  test("rejects invalid Dynamic Worker code before dispatch", () => {
    expect(() =>
      validateCallable({
        callable: {
          type: "fetch",
          via: {
            type: "env-binding",
            bindingType: "dynamic-worker",
            workerLoaderBindingName: "CALLABLE_TEST_LOADER",
            workerCode: {
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
          type: "workers-rpc",
          via: {
            type: "env-binding",
            bindingType: "dynamic-worker",
            workerLoaderBindingName: "CALLABLE_TEST_LOADER",
            workerCode: {
              compatibilityDate: "2026-04-27",
              mainModule: "missing.js",
              modules: { "worker.js": "export default {}" },
            },
          },
        },
      }),
    ).toThrow("Invalid callable");
  });

  test("rejects Dynamic Worker main modules inherited from Object.prototype", () => {
    expect(() =>
      validateCallable({
        callable: {
          type: "fetch",
          via: {
            type: "env-binding",
            bindingType: "dynamic-worker",
            workerCode: {
              compatibilityDate: "2026-04-27",
              mainModule: "toString",
              modules: { "worker.js": "export default {}" },
            },
          },
        },
      }),
    ).toThrow("Invalid callable");
  });

  test("accepts JSONata body construction for fetch value dispatch", () => {
    expect(
      validateCallable({
        callable: {
          type: "fetch",
          via: { type: "url", url: "https://api.example.com/v1" },
          fetchRequest: {
            method: "POST",
            body: { jsonata: '{ "title": title, "source": $ambient.source }' },
          },
        },
      }),
    ).toMatchObject({
      fetchRequest: {
        body: { jsonata: '{ "title": title, "source": $ambient.source }' },
      },
    });
  });

  test("rejects non-JSONata fetchRequest body shapes", () => {
    expect(() =>
      validateCallable({
        callable: {
          type: "fetch",
          via: { type: "url", url: "https://api.example.com/v1" },
          fetchRequest: {
            method: "POST",
            body: { type: "json", from: "payload" },
          },
        },
      }),
    ).toThrow("Invalid callable");
  });

  test("accepts input transforms for fetch and RPC calls", () => {
    expect(
      validateCallable({
        callable: {
          type: "fetch",
          via: { type: "url", url: "https://api.example.com/v1" },
          transformInput: { shallowMerge: { provider: "github" } },
        },
      }),
    ).toMatchObject({
      transformInput: { shallowMerge: { provider: "github" } },
    });

    expect(
      validateCallable({
        callable: {
          type: "workers-rpc",
          via: {
            type: "env-binding",
            bindingType: "service",
            bindingName: "CALLABLE_TEST_SERVICE",
          },
          rpcMethod: "echo",
          transformInput: { jsonata: '{ "provider": "github", "input": $ }' },
        },
      }),
    ).toMatchObject({
      transformInput: { jsonata: '{ "provider": "github", "input": $ }' },
    });
  });

  test("rejects positional RPC shallowMerge without JSONata to produce the args array", () => {
    expect(() =>
      validateCallable({
        callable: {
          type: "workers-rpc",
          via: {
            type: "env-binding",
            bindingType: "service",
            bindingName: "CALLABLE_TEST_SERVICE",
          },
          rpcMethod: "join",
          argsMode: "positional",
          transformInput: { shallowMerge: { left: "left" } },
        },
      }),
    ).toThrow("Invalid callable");
  });

  test("rejects empty or invalid input transforms", () => {
    expect(() =>
      validateCallable({
        callable: {
          type: "fetch",
          via: { type: "url", url: "https://api.example.com/v1" },
          transformInput: {},
        },
      }),
    ).toThrow("Invalid callable");

    expect(() =>
      validateCallable({
        callable: {
          type: "fetch",
          via: { type: "url", url: "https://api.example.com/v1" },
          transformInput: "github",
        },
      }),
    ).toThrow("Invalid callable");
  });
});

describe("dispatchCallable", () => {
  test("posts JSON by default for fetch callables and parses JSON responses", async () => {
    const value = await dispatchCallable({
      callable: {
        type: "fetch",
        via: {
          type: "env-binding",
          bindingType: "service",
          bindingName: "CALLABLE_TEST_SERVICE",
        },
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
        type: "fetch",
        via: {
          type: "env-binding",
          bindingType: "service",
          bindingName: "CALLABLE_TEST_SERVICE",
        },
        fetchRequest: { path: { base: "/internal" } },
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

  test("uses transformInput.shallowMerge as the default fetch JSON body when runtime payload is empty", async () => {
    const value = await dispatchCallable({
      callable: {
        type: "fetch",
        via: {
          type: "env-binding",
          bindingType: "service",
          bindingName: "CALLABLE_TEST_SERVICE",
        },
        transformInput: { shallowMerge: { provider: "github", dryRun: true } },
      },
      payload: undefined,
      ctx: { env: testEnv },
    });

    expect(JSON.parse(value.body)).toEqual({ provider: "github", dryRun: true });
  });

  test("merges the runtime payload into transformInput.shallowMerge before fetch value dispatch", async () => {
    const value = await dispatchCallable({
      callable: {
        type: "fetch",
        via: {
          type: "env-binding",
          bindingType: "service",
          bindingName: "CALLABLE_TEST_SERVICE",
        },
        transformInput: {
          shallowMerge: {
            provider: "github",
            options: { dryRun: true },
          },
        },
      },
      payload: {
        title: "Bug",
        options: { dryRun: false },
      },
      ctx: { env: testEnv },
    });

    expect(JSON.parse(value.body)).toEqual({
      provider: "github",
      title: "Bug",
      options: { dryRun: false },
    });
  });

  test("uses transformInput JSONata before the default fetch JSON body is built", async () => {
    const value = await dispatchCallable({
      callable: {
        type: "fetch",
        via: {
          type: "env-binding",
          bindingType: "service",
          bindingName: "CALLABLE_TEST_SERVICE",
        },
        transformInput: {
          jsonata: '{ "provider": $ambient.provider, "issue": { "title": title } }',
        },
      },
      payload: { title: "Bug" },
      ctx: { env: testEnv, ambient: { provider: "github" } },
    });

    expect(JSON.parse(value.body)).toEqual({
      provider: "github",
      issue: { title: "Bug" },
    });
  });

  test("wraps JSONata evaluation errors as payload validation failures", async () => {
    await expect(
      dispatchCallable({
        callable: {
          type: "fetch",
          via: { type: "url", url: "https://api.example.com/tools" },
          transformInput: { jsonata: "{" },
        },
        payload: { title: "Bug" },
        ctx: { fetch: vi.fn() },
      }),
    ).rejects.toMatchObject({
      code: "PAYLOAD_VALIDATION_FAILED",
      message: "JSONata evaluation failed",
    });
  });

  test("uses fetchRequest body JSONata to build the JSON body from transformed input", async () => {
    const value = await dispatchCallable({
      callable: {
        type: "fetch",
        via: {
          type: "env-binding",
          bindingType: "service",
          bindingName: "CALLABLE_TEST_SERVICE",
        },
        transformInput: {
          shallowMerge: { provider: "github" },
        },
        fetchRequest: {
          body: {
            jsonata: '{ "source": provider, "title": title, "tenant": $ambient.tenantId }',
          },
        },
      },
      payload: { title: "Bug" },
      ctx: { env: testEnv, ambient: { tenantId: "tenant_123" } },
    });

    expect(JSON.parse(value.body)).toEqual({
      source: "github",
      title: "Bug",
      tenant: "tenant_123",
    });
  });

  test("keeps the default JSON body when fetch request options only add headers", async () => {
    const value = await dispatchCallable({
      callable: {
        type: "fetch",
        via: {
          type: "env-binding",
          bindingType: "service",
          bindingName: "CALLABLE_TEST_SERVICE",
        },
        fetchRequest: {
          headers: { "x-callable-test": "set" },
        },
      },
      payload: { title: "Bug" },
      ctx: { env: testEnv },
    });

    expect(value).toMatchObject({
      method: "POST",
      body: '{"title":"Bug"}',
      contentType: "application/json",
    });
  });

  test("serializes undefined payloads as JSON null in the default fetch value request", async () => {
    const value = await dispatchCallable({
      callable: {
        type: "fetch",
        via: { type: "url", url: "https://api.example.com/tools" },
      },
      payload: undefined,
      ctx: {
        fetch: async (request) => Response.json({ body: await request.text() }),
      },
    });

    expect(value).toEqual({ body: "null" });
  });

  test("omits default JSON bodies for GET and HEAD value requests", async () => {
    for (const method of ["GET", "HEAD"] as const) {
      const value = await dispatchCallable({
        callable: {
          type: "fetch",
          via: { type: "url", url: "https://api.example.com/tools" },
          fetchRequest: { method },
        },
        payload: { ignored: true },
        ctx: {
          fetch: async (request) =>
            Response.json({
              method: request.method,
              hasContentType: request.headers.has("content-type"),
              body: await request.text(),
            }),
        },
      });

      expect(value).toEqual({
        method,
        hasContentType: false,
        body: "",
      });
    }
  });

  test("rejects fetchRequest body JSONata for GET and HEAD value requests", async () => {
    for (const method of ["GET", "HEAD"] as const) {
      await expect(
        dispatchCallable({
          callable: {
            type: "fetch",
            via: { type: "url", url: "https://api.example.com/tools" },
            fetchRequest: {
              method,
              body: { jsonata: "$" },
            },
          },
          payload: { ignored: true },
          ctx: { fetch: vi.fn() },
        }),
      ).rejects.toMatchObject({
        code: "PAYLOAD_VALIDATION_FAILED",
      });
    }
  });

  test("ignores transformInput in raw fetch dispatch because the Request already exists", async () => {
    const response = await dispatchCallableFetch({
      callable: {
        type: "fetch",
        via: { type: "url", url: "https://api.example.com" },
        transformInput: { jsonata: "{" },
      },
      request: new Request("https://router.local/raw", {
        method: "POST",
        body: JSON.stringify({ title: "Bug" }),
      }),
      ctx: {
        fetch: async (request) => new Response(await request.text()),
      },
    });

    await expect(response.json()).resolves.toEqual({ title: "Bug" });
  });

  test("rejects fetchRequest body JSONata in raw fetch dispatch because the Request already exists", async () => {
    await expect(
      dispatchCallableFetch({
        callable: {
          type: "fetch",
          via: { type: "url", url: "https://api.example.com" },
          fetchRequest: { body: { jsonata: "$" } },
        },
        request: new Request("https://router.local/raw", {
          method: "POST",
          body: JSON.stringify({ title: "Bug" }),
        }),
        ctx: { fetch: vi.fn() },
      }),
    ).rejects.toMatchObject({
      code: "PAYLOAD_VALIDATION_FAILED",
    });
  });

  test("parses text responses when the response is not JSON", async () => {
    const value = await dispatchCallable({
      callable: {
        type: "fetch",
        via: { type: "url", url: "https://api.example.com/text" },
      },
      payload: { ignored: true },
      ctx: {
        fetch: async () =>
          new Response("plain text result", { headers: { "content-type": "text/plain" } }),
      },
    });

    expect(value).toBe("plain text result");
  });

  test("wraps invalid JSON success responses as remote callable errors", async () => {
    await expect(
      dispatchCallable({
        callable: {
          type: "fetch",
          via: { type: "url", url: "https://api.example.com/bad-json" },
        },
        payload: { ignored: true },
        ctx: {
          fetch: async () =>
            new Response("{not-json", { headers: { "content-type": "application/json" } }),
        },
      }),
    ).rejects.toMatchObject({
      code: "REMOTE_ERROR",
      details: {
        status: 200,
        body: "{not-json",
        contentType: "application/json",
      },
    });
  });

  test("keeps URL query in value mode unless fetchRequest query replaces it", async () => {
    const preserved = await dispatchCallable({
      callable: {
        type: "fetch",
        via: { type: "url", url: "https://api.example.com/tools?fixed=true" },
      },
      payload: { ignored: true },
      ctx: {
        fetch: async (request) => Response.json({ url: request.url }),
      },
    });

    expect(preserved).toEqual({ url: "https://api.example.com/tools?fixed=true" });

    const replaced = await dispatchCallable({
      callable: {
        type: "fetch",
        via: { type: "url", url: "https://api.example.com/tools?fixed=true" },
        fetchRequest: { query: { dryRun: true } },
      },
      payload: { ignored: true },
      ctx: {
        fetch: async (request) => Response.json({ url: request.url }),
      },
    });

    expect(replaced).toEqual({ url: "https://api.example.com/tools?dryRun=true" });

    const cleared = await dispatchCallable({
      callable: {
        type: "fetch",
        via: { type: "url", url: "https://api.example.com/tools?fixed=true" },
        fetchRequest: { query: {} },
      },
      payload: { ignored: true },
      ctx: {
        fetch: async (request) => Response.json({ url: request.url }),
      },
    });

    expect(cleared).toEqual({ url: "https://api.example.com/tools" });
  });

  test("preserves trailing slash URL via values in value mode", async () => {
    const value = await dispatchCallable({
      callable: {
        type: "fetch",
        via: { type: "url", url: "https://api.example.com/v1/" },
      },
      payload: { ignored: true },
      ctx: {
        fetch: async (request) => Response.json({ url: request.url }),
      },
    });

    expect(value).toEqual({ url: "https://api.example.com/v1/" });
  });

  test("requires explicit ctx.fetch for URL via values", async () => {
    await expect(
      dispatchCallable({
        callable: {
          type: "fetch",
          via: { type: "url", url: "https://api.example.com/tools" },
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
          type: "fetch",
          via: { type: "url", url: "https://api.example.com/fail" },
        },
        payload: { ignored: true },
        ctx: {
          fetch: async () => new Response("bad input", { status: 400, statusText: "Bad" }),
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
          type: "fetch",
          via: { type: "url", url: "https://api.example.com" },
          transformInput: { jsonata: "{" },
        },
        payload: new Request("https://router.local/upload"),
        ctx: { fetch: vi.fn() },
      }),
    ).rejects.toMatchObject({
      code: "PAYLOAD_VALIDATION_FAILED",
      message:
        "dispatchCallable() does not accept Request payloads; use dispatchCallableFetch() for raw fetch dispatch",
    });
  });

  test("dispatches object-mode service RPC", async () => {
    const value = await dispatchCallable({
      callable: {
        type: "workers-rpc",
        via: {
          type: "env-binding",
          bindingType: "service",
          bindingName: "CALLABLE_TEST_SERVICE",
        },
        rpcMethod: "echo",
      },
      payload: { ok: true },
      ctx: { env: testEnv },
    });

    expect(value).toEqual({ target: "service", input: { ok: true } });
  });

  test("merges the runtime payload into transformInput.shallowMerge before RPC object dispatch", async () => {
    const value = await dispatchCallable({
      callable: {
        type: "workers-rpc",
        via: {
          type: "env-binding",
          bindingType: "service",
          bindingName: "CALLABLE_TEST_SERVICE",
        },
        rpcMethod: "echo",
        transformInput: {
          shallowMerge: {
            provider: "github",
            options: { dryRun: true },
          },
        },
      },
      payload: {
        name: "createIssue",
        options: { dryRun: false },
      },
      ctx: { env: testEnv },
    });

    expect(value).toEqual({
      target: "service",
      input: {
        provider: "github",
        name: "createIssue",
        options: { dryRun: false },
      },
    });
  });

  test("uses transformInput JSONata before RPC object dispatch", async () => {
    const value = await dispatchCallable({
      callable: {
        type: "workers-rpc",
        via: {
          type: "env-binding",
          bindingType: "service",
          bindingName: "CALLABLE_TEST_SERVICE",
        },
        rpcMethod: "echo",
        transformInput: {
          shallowMerge: { provider: "github" },
          jsonata: '{ "toolProvider": provider, "tool": name, "tenant": $ambient.tenantId }',
        },
      },
      payload: { name: "createIssue" },
      ctx: { env: testEnv, ambient: { tenantId: "tenant_123" } },
    });

    expect(value).toEqual({
      target: "service",
      input: {
        toolProvider: "github",
        tool: "createIssue",
        tenant: "tenant_123",
      },
    });
  });

  test("uses transformInput JSONata before positional service RPC dispatch", async () => {
    const value = await dispatchCallable({
      callable: {
        type: "workers-rpc",
        via: {
          type: "env-binding",
          bindingType: "service",
          bindingName: "CALLABLE_TEST_SERVICE",
        },
        rpcMethod: "join",
        argsMode: "positional",
        transformInput: { jsonata: "[left, right]" },
      },
      payload: { left: "left", right: "right" },
      ctx: { env: testEnv },
    });

    expect(value).toBe("left:right");
  });

  test("rejects primitive runtime payloads when transformInput.shallowMerge is present", async () => {
    await expect(
      dispatchCallable({
        callable: {
          type: "workers-rpc",
          via: {
            type: "env-binding",
            bindingType: "service",
            bindingName: "CALLABLE_TEST_SERVICE",
          },
          rpcMethod: "echo",
          transformInput: { shallowMerge: { provider: "github" } },
        },
        payload: "createIssue",
        ctx: { env: testEnv },
      }),
    ).rejects.toMatchObject({
      code: "PAYLOAD_VALIDATION_FAILED",
    });
  });

  test("does not resolve inherited env properties as service bindings", async () => {
    await expect(
      dispatchCallable({
        callable: {
          type: "workers-rpc",
          via: { type: "env-binding", bindingType: "service", bindingName: "constructor" },
          rpcMethod: "keys",
        },
        payload: { accidental: "prototype" },
        ctx: { env: {} },
      }),
    ).rejects.toMatchObject({
      code: "RESOLUTION_FAILED",
      message: 'Binding "constructor" not found',
    });
  });

  test("dispatches positional service RPC", async () => {
    const value = await dispatchCallable({
      callable: {
        type: "workers-rpc",
        via: {
          type: "env-binding",
          bindingType: "service",
          bindingName: "CALLABLE_TEST_SERVICE",
        },
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
        type: "workers-rpc",
        via: {
          type: "env-binding",
          bindingType: "durable-object-namespace",
          bindingName: "CALLABLE_TEST_DURABLE_OBJECT",
          durableObject: { name: "rpc-object-target" },
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
        type: "workers-rpc",
        via: {
          type: "env-binding",
          bindingType: "durable-object-namespace",
          bindingName: "CALLABLE_TEST_DURABLE_OBJECT",
          durableObject: { name: "rpc-positional-target" },
        },
        rpcMethod: "join",
        argsMode: "positional",
      },
      payload: ["left", "right"],
      ctx: { env: testEnv },
    });

    expect(value).toBe("left:right");
  });

  test("rejects non-array transformed inputs for positional RPC", async () => {
    await expect(
      dispatchCallable({
        callable: {
          type: "workers-rpc",
          via: {
            type: "env-binding",
            bindingType: "service",
            bindingName: "CALLABLE_TEST_SERVICE",
          },
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
          type: "workers-rpc",
          via: {
            type: "env-binding",
            bindingType: "service",
            bindingName: "CALLABLE_TEST_SERVICE",
          },
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

  test("dispatches Dynamic Worker fetch through the same default value path", async () => {
    const value = await dispatchCallable({
      callable: {
        type: "fetch",
        via: {
          type: "env-binding",
          bindingType: "dynamic-worker",
          workerLoaderBindingName: "CALLABLE_TEST_LOADER",
          workerCode: dynamicWorkerCode,
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

  test("uses the LOADER Worker Loader binding when Dynamic Worker via omits a binding name", async () => {
    const value = await dispatchCallable({
      callable: {
        type: "fetch",
        via: {
          type: "env-binding",
          bindingType: "dynamic-worker",
          workerCode: dynamicWorkerCode,
        },
      },
      payload: { title: "Bug" },
      ctx: {
        env: {
          ...testEnv,
          LOADER: testEnv.CALLABLE_TEST_LOADER,
        },
      },
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
        type: "workers-rpc",
        via: {
          type: "env-binding",
          bindingType: "dynamic-worker",
          workerLoaderBindingName: "CALLABLE_TEST_LOADER",
          workerCode: dynamicWorkerCode,
          loader: { type: "get", id: "callable-dynamic-worker-rpc-object" },
        },
        rpcMethod: "echo",
      },
      payload: { ok: true },
      ctx: { env: testEnv },
    });

    expect(value).toEqual({ target: "dynamic-worker", input: { ok: true } });
  });

  test("dispatches positional Dynamic Worker RPC", async () => {
    const value = await dispatchCallable({
      callable: {
        type: "workers-rpc",
        via: {
          type: "env-binding",
          bindingType: "dynamic-worker",
          workerLoaderBindingName: "CALLABLE_TEST_LOADER",
          workerCode: dynamicWorkerCode,
        },
        rpcMethod: "join",
        argsMode: "positional",
      },
      payload: ["left", "right"],
      ctx: { env: testEnv },
    });

    expect(value).toBe("left:right");
  });

  test("dispatches Dynamic Worker RPC to a named entrypoint with props", async () => {
    const value = await dispatchCallable({
      callable: {
        type: "workers-rpc",
        via: {
          type: "env-binding",
          bindingType: "dynamic-worker",
          workerLoaderBindingName: "CALLABLE_TEST_LOADER",
          workerCode: dynamicWorkerCode,
          entrypoint: {
            name: "NamedEntrypoint",
            props: { tenantId: "tenant_dynamic" },
          },
        },
        rpcMethod: "echo",
      },
      payload: { ok: true },
      ctx: { env: testEnv },
    });

    expect(value).toEqual({
      target: "dynamic-worker-named",
      props: { tenantId: "tenant_dynamic" },
      input: { ok: true },
    });
  });

  test("dispatches RPC through a loopback service binding with props", async () => {
    const value = await dispatchCallable({
      callable: {
        type: "workers-rpc",
        via: {
          type: "loopback-binding",
          bindingType: "service",
          exportName: "CallableLoopbackService",
          props: { tenantId: "tenant_loopback" },
        },
        rpcMethod: "echo",
      },
      payload: { ok: true },
      ctx: { exports: workerExports },
    });

    expect(value).toEqual({
      target: "loopback-service",
      props: { tenantId: "tenant_loopback" },
      input: { ok: true },
    });
  });

  test("rejects direct loopback Durable Object dispatch without ctx.exports namespace", async () => {
    await expect(
      dispatchCallable({
        callable: {
          type: "workers-rpc",
          via: {
            type: "loopback-binding",
            bindingType: "durable-object-namespace",
            exportName: "CallableTestDurableObject",
            durableObject: { name: "loopback-rpc-target" },
          },
          rpcMethod: "echo",
        },
        payload: { ok: true },
        ctx: {},
      }),
    ).rejects.toMatchObject({ code: "RESOLUTION_FAILED" });
  });

  test("rejects missing Dynamic Worker loader bindings", async () => {
    await expect(
      dispatchCallable({
        callable: {
          type: "fetch",
          via: {
            type: "env-binding",
            bindingType: "dynamic-worker",
            workerLoaderBindingName: "MISSING_LOADER",
            workerCode: dynamicWorkerCode,
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
  test("routes from the host Worker through service binding fetch", async () => {
    await expect(
      dispatchThroughHostWorker({
        callable: {
          type: "fetch",
          via: {
            type: "env-binding",
            bindingType: "service",
            bindingName: "CALLABLE_TEST_SERVICE",
          },
          fetchRequest: { path: { base: "/host-service", mode: "replace" } },
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

  test("routes from the host Worker through Durable Object Workers RPC", async () => {
    await expect(
      dispatchThroughHostWorker({
        callable: {
          type: "workers-rpc",
          via: {
            type: "env-binding",
            bindingType: "durable-object-namespace",
            bindingName: "CALLABLE_TEST_DURABLE_OBJECT",
            durableObject: { name: "host-rpc-target" },
          },
          rpcMethod: "echo",
        },
        payload: { from: "host" },
      }),
    ).resolves.toEqual({
      value: { target: "durable-object", input: { from: "host" } },
    });
  });

  test("routes from the host Worker through service binding Workers RPC", async () => {
    await expect(
      dispatchThroughHostWorker({
        callable: {
          type: "workers-rpc",
          via: {
            type: "env-binding",
            bindingType: "service",
            bindingName: "CALLABLE_TEST_SERVICE",
          },
          rpcMethod: "echo",
        },
        payload: { from: "host" },
      }),
    ).resolves.toEqual({
      value: { target: "service", input: { from: "host" } },
    });
  });

  test("routes from the host Worker through Durable Object fetch", async () => {
    await expect(
      dispatchThroughHostWorker({
        callable: {
          type: "fetch",
          via: {
            type: "env-binding",
            bindingType: "durable-object-namespace",
            bindingName: "CALLABLE_TEST_DURABLE_OBJECT",
            durableObject: { name: "host-fetch-target" },
          },
          fetchRequest: { path: { base: "/host-do", mode: "replace" } },
        },
        payload: { from: "host" },
      }),
    ).resolves.toMatchObject({
      value: {
        method: "POST",
        path: "/host-do",
        body: '{"from":"host"}',
      },
    });
  });

  test("routes from the host Worker through Dynamic Worker fetch", async () => {
    await expect(
      dispatchThroughHostWorker({
        callable: {
          type: "fetch",
          via: {
            type: "env-binding",
            bindingType: "dynamic-worker",
            workerLoaderBindingName: "CALLABLE_TEST_LOADER",
            workerCode: dynamicWorkerCode,
          },
          fetchRequest: { path: { base: "/host-dynamic", mode: "replace" } },
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

  test("routes from the host Worker through Dynamic Worker Workers RPC", async () => {
    await expect(
      dispatchThroughHostWorker({
        callable: {
          type: "workers-rpc",
          via: {
            type: "env-binding",
            bindingType: "dynamic-worker",
            workerLoaderBindingName: "CALLABLE_TEST_LOADER",
            workerCode: dynamicWorkerCode,
          },
          rpcMethod: "echo",
        },
        payload: { from: "host" },
      }),
    ).resolves.toEqual({
      value: { target: "dynamic-worker", input: { from: "host" } },
    });
  });
});

describe("dispatchCallableFetch", () => {
  test("prefixes incoming paths onto the base URL path by default", async () => {
    const response = await dispatchCallableFetch({
      callable: {
        type: "fetch",
        via: { type: "url", url: "https://api.example.com/v1" },
      },
      request: new Request("https://router.local/users/123?expand=items", { method: "POST" }),
      ctx: {
        fetch: async (request) => Response.json({ url: request.url, method: request.method }),
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
        type: "fetch",
        via: {
          type: "url",
          url: "https://api.example.com/status",
        },
        fetchRequest: { path: { mode: "replace" } },
      },
      request: new Request("https://router.local/users/123?expand=items"),
      ctx: {
        fetch: async (request) => Response.json({ url: request.url }),
      },
    });

    await expect(response.json()).resolves.toEqual({
      url: "https://api.example.com/status?expand=items",
    });
  });

  test("raw fetch dispatch replaces target query with incoming request query without merging", async () => {
    const response = await dispatchCallableFetch({
      callable: {
        type: "fetch",
        via: { type: "url", url: "https://api.example.com/v1?fixed=true" },
      },
      request: new Request("https://router.local/users?active=true"),
      ctx: {
        fetch: async (request) => Response.json({ url: request.url }),
      },
    });

    await expect(response.json()).resolves.toEqual({
      url: "https://api.example.com/v1/users?active=true",
    });
  });

  test("raw fetch mode replaces or clears the incoming query when fetchRequest query is present", async () => {
    const replaced = await dispatchCallableFetch({
      callable: {
        type: "fetch",
        via: { type: "url", url: "https://api.example.com/v1?fixed=true" },
        fetchRequest: { query: { active: true } },
      },
      request: new Request("https://router.local/users?expand=items"),
      ctx: {
        fetch: async (request) => Response.json({ url: request.url }),
      },
    });

    await expect(replaced.json()).resolves.toEqual({
      url: "https://api.example.com/v1/users?active=true",
    });

    const cleared = await dispatchCallableFetch({
      callable: {
        type: "fetch",
        via: { type: "url", url: "https://api.example.com/v1?fixed=true" },
        fetchRequest: { query: {} },
      },
      request: new Request("https://router.local/users?expand=items"),
      ctx: {
        fetch: async (request) => Response.json({ url: request.url }),
      },
    });

    await expect(cleared.json()).resolves.toEqual({
      url: "https://api.example.com/v1/users",
    });
  });

  test("raw fetch mode preserves trailing slash URL via values for root requests", async () => {
    const response = await dispatchCallableFetch({
      callable: {
        type: "fetch",
        via: { type: "url", url: "https://api.example.com/v1/" },
      },
      request: new Request("https://router.local/"),
      ctx: {
        fetch: async (request) => Response.json({ url: request.url }),
      },
    });

    await expect(response.json()).resolves.toEqual({
      url: "https://api.example.com/v1/",
    });
  });

  test("does not read the request body in raw fetch dispatch", async () => {
    const request = new Request("https://router.local/upload", {
      method: "POST",
      body: "streamed-body",
    });

    const response = await dispatchCallableFetch({
      callable: {
        type: "fetch",
        via: { type: "url", url: "https://api.example.com" },
      },
      request,
      ctx: {
        fetch: async (outboundRequest) => {
          expect(request.bodyUsed).toBe(false);
          return new Response(await outboundRequest.text());
        },
      },
    });

    await expect(response.text()).resolves.toBe("streamed-body");
  });

  test("raw fetch mode can apply method and header overrides while preserving the request body", async () => {
    const request = new Request("https://router.local/upload", {
      method: "POST",
      body: "streamed-body",
      headers: { "content-type": "text/plain" },
    });

    const response = await dispatchCallableFetch({
      callable: {
        type: "fetch",
        via: { type: "url", url: "https://api.example.com" },
        fetchRequest: {
          method: "PATCH",
          headers: { "x-callable-test": "set" },
        },
      },
      request,
      ctx: {
        fetch: async (outboundRequest) => {
          expect(request.bodyUsed).toBe(false);
          return Response.json({
            method: outboundRequest.method,
            header: outboundRequest.headers.get("x-callable-test"),
            contentType: outboundRequest.headers.get("content-type"),
            body: await outboundRequest.text(),
          });
        },
      },
    });

    await expect(response.json()).resolves.toEqual({
      method: "PATCH",
      header: "set",
      contentType: "text/plain",
      body: "streamed-body",
    });
  });

  test("dispatches to a real service binding fetch handler through env", async () => {
    const response = await dispatchCallableFetch({
      callable: {
        type: "fetch",
        via: {
          type: "env-binding",
          bindingType: "service",
          bindingName: "CALLABLE_TEST_SERVICE",
        },
        fetchRequest: { path: { base: "/internal" } },
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
        type: "fetch",
        via: {
          type: "env-binding",
          bindingType: "service",
          bindingName: "CALLABLE_TEST_SERVICE",
        },
        fetchRequest: { path: { base: "/redirect", mode: "replace" } },
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
        type: "fetch",
        via: {
          type: "env-binding",
          bindingType: "durable-object-namespace",
          bindingName: "CALLABLE_TEST_DURABLE_OBJECT",
          durableObject: { name: "named-target" },
        },
        fetchRequest: { path: { base: "/do" } },
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
        type: "fetch",
        via: {
          type: "env-binding",
          bindingType: "durable-object-namespace",
          bindingName: "CALLABLE_TEST_DURABLE_OBJECT",
          durableObject: { id },
        },
        fetchRequest: { path: { base: "/exact", mode: "replace" } },
      },
      request: new Request("https://router.local/messages?limit=1"),
      ctx: { env: testEnv },
    });

    await expect(response.json()).resolves.toMatchObject({
      path: "/exact",
      query: "?limit=1",
    });
  });

  test("dispatches to a Dynamic Worker fetch via with request streaming semantics", async () => {
    const request = new Request("https://router.local/orders/1?expand=items", {
      method: "PATCH",
      body: "patched",
    });

    const response = await dispatchCallableFetch({
      callable: {
        type: "fetch",
        via: {
          type: "env-binding",
          bindingType: "dynamic-worker",
          workerLoaderBindingName: "CALLABLE_TEST_LOADER",
          workerCode: dynamicWorkerCode,
          loader: { type: "get", id: "callable-dynamic-worker-fetch" },
        },
        fetchRequest: { path: { base: "/internal" } },
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

  test("dispatches to a Dynamic Worker fetch via with loader.load by default", async () => {
    const response = await dispatchCallableFetch({
      callable: {
        type: "fetch",
        via: {
          type: "env-binding",
          bindingType: "dynamic-worker",
          workerLoaderBindingName: "CALLABLE_TEST_LOADER",
          workerCode: dynamicWorkerCode,
        },
        fetchRequest: { path: { base: "/load-mode", mode: "replace" } },
      },
      request: new Request("https://router.local/ignored"),
      ctx: { env: testEnv },
    });

    await expect(response.json()).resolves.toMatchObject({
      target: "dynamic-worker",
      path: "/load-mode",
    });
  });

  test("dispatches to a Dynamic Worker named entrypoint fetch handler", async () => {
    const response = await dispatchCallableFetch({
      callable: {
        type: "fetch",
        via: {
          type: "env-binding",
          bindingType: "dynamic-worker",
          workerLoaderBindingName: "CALLABLE_TEST_LOADER",
          workerCode: dynamicWorkerCode,
          entrypoint: {
            name: "NamedEntrypoint",
            props: { tenantId: "tenant_dynamic_fetch" },
          },
        },
        fetchRequest: { path: { base: "/named", mode: "replace" } },
      },
      request: new Request("https://router.local/ignored", {
        method: "POST",
        body: "named-body",
      }),
      ctx: { env: testEnv },
    });

    await expect(response.json()).resolves.toEqual({
      target: "dynamic-worker-named",
      props: { tenantId: "tenant_dynamic_fetch" },
      method: "POST",
      path: "/named",
      body: "named-body",
    });
  });

  test("dispatches to the default loopback fetch export", async () => {
    const response = await dispatchCallableFetch({
      callable: {
        type: "fetch",
        via: {
          type: "loopback-binding",
          bindingType: "service",
          exportName: "default",
        },
        fetchRequest: { path: { base: "/loopback-default", mode: "replace" } },
      },
      request: new Request("https://router.local/ignored"),
      ctx: { exports: workerExports },
    });

    await expect(response.text()).resolves.toBe("callable test worker");
  });

  test("dispatches to a loopback service binding fetch handler with props", async () => {
    const response = await dispatchCallableFetch({
      callable: {
        type: "fetch",
        via: {
          type: "loopback-binding",
          bindingType: "service",
          exportName: "CallableLoopbackService",
          props: { tenantId: "tenant_loopback_fetch" },
        },
        fetchRequest: { path: { base: "/loopback-service", mode: "replace" } },
      },
      request: new Request("https://router.local/ignored", {
        method: "POST",
        body: "loopback-body",
      }),
      ctx: { exports: workerExports },
    });

    await expect(response.json()).resolves.toMatchObject({
      target: "loopback-service",
      props: { tenantId: "tenant_loopback_fetch" },
      method: "POST",
      path: "/loopback-service",
      body: "loopback-body",
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
          type: "fetch",
          via: { type: "url", url: "https://api.example.com" },
        },
        request,
        ctx: { fetch: vi.fn() },
      }),
    ).rejects.toThrow("Request body was already consumed");
  });

  test("wraps invalid Durable Object ids as callable resolution errors", async () => {
    await expect(
      dispatchCallableFetch({
        callable: {
          type: "fetch",
          via: {
            type: "env-binding",
            bindingType: "durable-object-namespace",
            bindingName: "CALLABLE_TEST_DURABLE_OBJECT",
            durableObject: { id: "not-a-valid-id" },
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

describe("explicit fetchRequest options", () => {
  test("builds a JSON request from explicit method, header, and query options", async () => {
    const value = await dispatchCallable({
      callable: {
        type: "fetch",
        via: { type: "url", url: "https://api.example.com/tools?fixed=true" },
        fetchRequest: {
          method: "POST",
          headers: { "x-tool": "create-issue" },
          query: { dryRun: true },
        },
      },
      payload: { title: "Bug" },
      ctx: {
        fetch: async (request) =>
          Response.json({
            url: request.url,
            method: request.method,
            tool: request.headers.get("x-tool"),
            contentType: request.headers.get("content-type"),
            body: await request.json(),
          }),
      },
    });

    expect(value).toEqual({
      url: "https://api.example.com/tools?dryRun=true",
      method: "POST",
      tool: "create-issue",
      contentType: "application/json",
      body: { title: "Bug" },
    });
  });
});

describe("connectCallableWebSocket", () => {
  test("marks client-side upgrade failures as non-retryable and includes status details", async () => {
    await expect(
      connectCallableWebSocket({
        callable: {
          type: "fetch",
          via: { type: "url", url: "https://api.example.com/socket" },
        },
        ctx: {
          fetch: async () => new Response("forbidden", { status: 403, statusText: "Forbidden" }),
        },
      }),
    ).rejects.toMatchObject({
      code: "TRANSPORT_FAILED",
      retryable: false,
      details: { status: 403, statusText: "Forbidden" },
    });
  });

  test("connects through a Durable Object fetch callable", async () => {
    const ws = await connectCallableWebSocket({
      callable: {
        type: "fetch",
        via: {
          type: "env-binding",
          bindingType: "durable-object-namespace",
          bindingName: "CALLABLE_TEST_DURABLE_OBJECT",
          durableObject: { name: "websocket-target" },
        },
        fetchRequest: { path: { base: "/socket", mode: "replace" } },
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

  test("connects through a service binding fetch callable", async () => {
    const ws = await connectCallableWebSocket({
      callable: {
        type: "fetch",
        via: {
          type: "env-binding",
          bindingType: "service",
          bindingName: "CALLABLE_TEST_SERVICE",
        },
        fetchRequest: { path: { base: "/socket", mode: "replace" } },
      },
      ctx: { env: testEnv },
    });

    const closed = new Promise((resolve) => {
      ws.addEventListener("close", resolve, { once: true });
    });
    const message = await new Promise((resolve) => {
      ws.addEventListener("message", (event) => resolve(event.data), { once: true });
    });
    expect(JSON.parse(String(message))).toEqual({
      target: "service",
      path: "/socket",
    });
    await closed;
  });
});
