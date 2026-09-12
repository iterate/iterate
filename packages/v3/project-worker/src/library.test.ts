// library.test.ts — the library's executable spec, one describe per concept (each over its own fake `itx`),
// plus THE LIBRARY RULE pinned over the file's imports (the last block).

import { readFileSync } from "node:fs";
import { RpcTarget, newHttpBatchRpcResponse } from "capnweb";
import { describe, expect, test } from "vitest";
import {
  buildLibrary,
  type LibraryItx,
  type LibraryRoots,
  type OpenApiDocument,
  connectToCapnweb,
  connectToMcp,
  type McpConnection,
  connectToOpenApi,
  runScript,
  runScriptModule,
} from "./library.ts";

// ── the library ── the memo `buildLibrary` keeps over the three verbs: a connect with the same
// (verb, url, options) is ONE live connection for the context's life; `releaseConnections()` (the
// idle quiesce's call) closes what it holds and the next use reopens; a connect that FAILS is never
// kept. ONE fake `itx.fetch` serves all three remotes by host and records every handshake.

describe("the library", () => {
  const SPEC: OpenApiDocument = {
    openapi: "3.0.0",
    servers: [{ url: "https://api.example/v1" }],
    paths: { "/me": { get: { operationId: "me" } } },
  };
  class Api extends RpcTarget {
    hello() {
      return "hi";
    }
  }
  const json = (value: unknown, init: ResponseInit = {}) =>
    new Response(JSON.stringify(value), {
      ...init,
      headers: { "content-type": "application/json", ...(init.headers as Record<string, string>) },
    });

  /** The three remotes behind one `itx.fetch`, by host: an MCP server (`mcp.example` — a session id on
   *  initialize, DELETE on close), an OpenAPI document (`api.example/openapi.json`) and a capnweb batch
   *  endpoint (`rpc.example`). `seen` is every request: the JSON-RPC method, `GET <path>`, `DELETE`. */
  function remotes(): { itx: LibraryItx; seen: string[] } {
    const seen: string[] = [];
    const itx = {
      fetch: async (request: Request) => {
        const url = new URL(request.url);
        if (url.host === "rpc.example") return newHttpBatchRpcResponse(request, new Api());
        if (url.host === "api.example") {
          seen.push(`GET ${url.pathname}`);
          return json(url.pathname.endsWith("openapi.json") ? SPEC : { ok: true });
        }
        if (request.method === "DELETE") {
          seen.push("DELETE");
          return new Response(null, { status: 204 });
        }
        const body = JSON.parse(await request.text()) as { id?: number; method: string };
        seen.push(body.method);
        if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
        const result =
          body.method === "initialize"
            ? { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "f" } }
            : body.method === "tools/list"
              ? { tools: [{ name: "echo" }] }
              : { content: [{ type: "text", text: '"ok"' }] };
        return json(
          { jsonrpc: "2.0", id: body.id, result },
          body.method === "initialize" ? { headers: { "mcp-session-id": "s-1" } } : {},
        );
      },
    } as unknown as LibraryItx;
    return { itx, seen };
  }
  const initializes = (seen: string[]) => seen.filter((m) => m === "initialize").length;

  describe("buildLibrary — live connections are memoized per context", () => {
    const verbs: {
      verb: string;
      connect: (roots: LibraryRoots) => Promise<unknown>;
      /** The request a connect makes — one per LIVE connection (the batch transport makes none). */
      handshake?: string;
    }[] = [
      {
        verb: "connectToMcp",
        connect: (roots) => roots.connectToMcp("https://mcp.example/", { headers: { a: "1" } }),
        handshake: "initialize",
      },
      {
        verb: "connectToOpenApi",
        connect: (roots) => roots.connectToOpenApi("https://api.example/openapi.json"),
        handshake: "GET /openapi.json",
      },
      {
        verb: "connectToCapnweb",
        connect: (roots) =>
          roots.connectToCapnweb("https://rpc.example/rpc", { transport: "batch" }),
      },
    ];
    for (const { verb, connect, handshake } of verbs)
      test(`${verb}: two connects with the same arguments are ONE connection — the same object back, one handshake`, async () => {
        const { itx, seen } = remotes();
        const { roots } = buildLibrary(itx);
        const a = await connect(roots);
        const b = await connect(roots);
        expect(b).toBe(a);
        if (handshake) expect(seen.filter((m) => m === handshake)).toHaveLength(1);
      });

    test("releaseConnections closes what it holds (MCP: the session's DELETE) and forgets it; the next connect is a fresh handshake, a new object, and works", async () => {
      const { itx, seen } = remotes();
      const { roots, releaseConnections } = buildLibrary(itx);
      const a = await roots.connectToMcp("https://mcp.example/");
      releaseConnections();
      await new Promise((r) => setTimeout(r, 10)); // the close rides a `.then` off the memoized promise
      expect(seen).toContain("DELETE");
      const b = await roots.connectToMcp("https://mcp.example/");
      expect(b).not.toBe(a);
      expect(initializes(seen)).toBe(2);
      expect(await b.callTool("echo", {})).toBe("ok");
    });

    test("a held connection reused CONCURRENTLY after close re-handshakes ONCE — no session-less post", async () => {
      // The idle quiesce closes the memoized client while a caller still holds the connection; its
      // next request re-handshakes. Two concurrent requests must share ONE handshake and neither may
      // post before the session id is established — this fake server delays initialize and rejects a
      // session-less non-initialize (a real MCP server 400s), so a request that skips the shared
      // handshake fails.
      let initializeCount = 0;
      const itx = {
        fetch: async (request: Request) => {
          if (request.method === "DELETE") return new Response(null, { status: 204 });
          const body = JSON.parse(await request.text()) as { id?: number; method: string };
          if (body.method === "notifications/initialized")
            return new Response(null, { status: 202 });
          if (body.method === "initialize") {
            initializeCount++;
            await new Promise((r) => setTimeout(r, 5)); // let a racing request interleave first
            return json(
              { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "f" } } },
              { headers: { "mcp-session-id": "s-1" } },
            );
          }
          if (!request.headers.get("mcp-session-id"))
            return json({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "no session" } }, { status: 400 });
          const result =
            body.method === "tools/list"
              ? { tools: [{ name: "echo" }] }
              : { content: [{ type: "text", text: '"ok"' }] };
          return json({ jsonrpc: "2.0", id: body.id, result });
        },
      } as unknown as LibraryItx;
      const { roots, releaseConnections } = buildLibrary(itx);
      const conn = await roots.connectToMcp("https://mcp.example/");
      releaseConnections();
      await new Promise((r) => setTimeout(r, 10)); // the close rides a `.then` off the memoized promise
      const [r1, r2] = await Promise.all([conn.callTool("echo", {}), conn.callTool("echo", {})]);
      expect([r1, r2]).toEqual(["ok", "ok"]);
      expect(initializeCount).toBe(2); // one for connect, one shared re-handshake — never a third
    });

    test("closing DURING a re-handshake deletes the new session and does not revive the client", async () => {
      let sessions = 0;
      const deletes: string[] = [];
      let releaseHandshake: (() => void) | undefined;
      const itx = {
        fetch: async (request: Request) => {
          if (request.method === "DELETE") {
            deletes.push(request.headers.get("mcp-session-id") ?? "?");
            return new Response(null, { status: 204 });
          }
          const body = JSON.parse(await request.text()) as { id?: number; method: string };
          if (body.method === "notifications/initialized")
            return new Response(null, { status: 202 });
          if (body.method === "initialize") {
            const id = `s-${++sessions}`;
            if (sessions > 1) await new Promise<void>((r) => (releaseHandshake = r)); // park the re-handshake
            return json(
              { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "f" } } },
              { headers: { "mcp-session-id": id } },
            );
          }
          const result =
            body.method === "tools/list"
              ? { tools: [{ name: "echo" }] }
              : { content: [{ type: "text", text: '"ok"' }] };
          return json({ jsonrpc: "2.0", id: body.id, result });
        },
      } as unknown as LibraryItx;
      const { roots, releaseConnections } = buildLibrary(itx);
      const conn = await roots.connectToMcp("https://mcp.example/"); // establishes s-1
      releaseConnections();
      await new Promise((r) => setTimeout(r, 10)); // closes s-1 (DELETE s-1)

      const inflight = conn.callTool("echo", {}).then(
        () => "ok",
        (e: unknown) => (e instanceof Error ? e.message : String(e)),
      );
      await new Promise((r) => setTimeout(r, 10)); // the re-handshake (s-2) is parked
      await conn.close(); // close AGAIN while the handshake is in flight — bumps the generation
      releaseHandshake?.(); // now let the parked handshake complete
      const outcome = await inflight;

      expect(outcome).toMatch(/closed during its handshake/); // the call did not silently succeed
      expect(deletes).toContain("s-1");
      expect(deletes).toContain("s-2"); // the session the losing handshake established was NOT leaked
    });

    test("releaseConnections closes a WebSocket capnweb connection LOCALLY — `close` is the connection's own member, never the dotted proxy's remote call", async () => {
      // What egress's 101 would carry: a WebSocket-shaped object capnweb's session can drive.
      const closed: [number | undefined, string | undefined][] = [];
      const sent: string[] = [];
      const webSocket = {
        readyState: 1,
        accept() {},
        send(data: string) {
          sent.push(String(data));
        },
        close(code?: number, reason?: string) {
          closed.push([code, reason]);
        },
        addEventListener() {},
        removeEventListener() {},
      };
      const itx = { fetch: async () => ({ status: 101, webSocket }) } as unknown as LibraryItx;
      const { roots, releaseConnections } = buildLibrary(itx);
      await roots.connectToCapnweb("wss://ws.example/rpc");
      releaseConnections();
      await new Promise((r) => setTimeout(r, 10));
      // the LOCAL session was shut down (capnweb closes the socket on disposing the main stub) and
      // nothing rode the wire — the dotted fallback beneath InvokeHandle would have made `close` a
      // remote call on the far side's main object instead, leaving this socket open
      expect(closed).toHaveLength(1);
      expect(sent).toEqual([]);
    });

    test("a connect that FAILS is not memoized — the next call retries", async () => {
      let attempts = 0;
      const itx = {
        fetch: async () => {
          attempts += 1;
          return new Response("down", { status: 503 });
        },
      } as unknown as LibraryItx;
      const { roots } = buildLibrary(itx);
      await expect(roots.connectToMcp("https://mcp.example/")).rejects.toThrow(/503/);
      await expect(roots.connectToMcp("https://mcp.example/")).rejects.toThrow(/503/);
      expect(attempts).toBe(2);
    });

    test("the memo is keyed by the options too, and two spellings of one options object are one key", async () => {
      const { itx, seen } = remotes();
      const { roots } = buildLibrary(itx);
      const a = await roots.connectToMcp("https://mcp.example/", { headers: { a: "1", b: "2" } });
      const b = await roots.connectToMcp("https://mcp.example/", { headers: { b: "2", a: "1" } });
      const c = await roots.connectToMcp("https://mcp.example/", { headers: { a: "other" } });
      expect(b).toBe(a);
      expect(c).not.toBe(a);
      expect(initializes(seen)).toBe(2);
    });
  });
});

// ── capnweb ── the batch transport over a fake `itx.fetch` that IS a capnweb server
// (capnweb's own `newHttpBatchRpcResponse`), so a real capnweb round trip runs with no network: the
// handle's dotted sugar, an explicit invoke, and a pipelined chain in one batch. The WebSocket
// transport needs workerd's WebSocketPair and is proved in e2e.

// ── run ── `itx.run(script)` over a fake `itx.workers.get`: the module the loader would get (the
// script spliced verbatim, the smallest WorkerEntrypoint around it), run with NO arguments (a script
// bakes its own values in), the same text ⇒ the same module (the loader's content hash reuses the
// isolate), a blank script refused.

describe("run", () => {
  function host(): { itx: LibraryItx; loaded: unknown[]; runs: () => number } {
    const loaded: unknown[] = [];
    let ran = 0;
    const itx = {
      fetch: async () => new Response(null),
      workers: {
        get: (spec: unknown) => {
          loaded.push(spec);
          return {
            run: async (...args: unknown[]) => {
              ran += 1;
              return { calledWith: args.length }; // run() is called with NO arguments
            },
          };
        },
      },
    } as unknown as LibraryItx;
    return { itx, loaded, runs: () => ran };
  }

  test("the module: the script spliced in verbatim, a default WorkerEntrypoint whose run() hands it env.ITX.get() and disposes it", () => {
    const module = runScriptModule("async (itx) => (await itx.whoami()).path");
    expect(module["cap.js"]).toContain('import { WorkerEntrypoint } from "cloudflare:workers"');
    expect(module["cap.js"]).toContain(
      "const script = (async (itx) => (await itx.whoami()).path);",
    );
    expect(module["cap.js"]).toContain("export default class extends WorkerEntrypoint");
    expect(module["cap.js"]).toContain("async run() {");
    expect(module["cap.js"]).toContain("const itx = this.env.ITX.get();");
    expect(module["cap.js"]).toContain("return await script(itx);");
    expect(module["cap.js"]).toContain("itx[Symbol.dispose]?.();");
  });

  test("run(script) loads that module through itx.workers.get and calls run() with no arguments", async () => {
    const { itx, loaded, runs } = host();
    const { roots } = buildLibrary(itx);
    await expect(roots.run("async (itx) => 1")).resolves.toEqual({ calledWith: 0 });
    expect(loaded).toEqual([{ source: runScriptModule("async (itx) => 1") }]);
    expect(runs()).toBe(1);
  });

  test("the same text is the same module (byte-equal: the loader's content hash keys ONE isolate); a blank script is refused before any load", async () => {
    expect(runScriptModule("async (itx) => 1")).toEqual(runScriptModule("async (itx) => 1"));
    const { itx, loaded } = host();
    expect(() => runScript(itx, "   ")).toThrow(/itx\.run\(script/);
    expect(loaded).toEqual([]);
  });
});

describe("capnweb", () => {
  class Counter extends RpcTarget {
    #n = 0;
    inc(by = 1) {
      this.#n += by;
      return this.#n;
    }
  }
  class Api extends RpcTarget {
    hello(name: string) {
      return `hello ${name}`;
    }
    counter() {
      return new Counter();
    }
    boom() {
      throw new Error("kaboom");
    }
  }

  function fakeItx() {
    const requests: Request[] = [];
    const itx = {
      fetch: async (request: Request) => {
        requests.push(request);
        return newHttpBatchRpcResponse(request, new Api());
      },
    } as unknown as LibraryItx;
    return { itx, requests };
  }

  describe("connectToCapnweb, batch transport", () => {
    test("dotted sugar on the handle reaches the remote main", async () => {
      const { itx, requests } = fakeItx();
      const conn = await connectToCapnweb(itx, "https://api.example/rpc", {
        transport: "batch",
        headers: { authorization: "Bearer t" },
      });
      expect(await (conn as any).hello("world")).toBe("hello world");
      expect(requests[0].method).toBe("POST");
      expect(requests[0].headers.get("authorization")).toBe("Bearer t");
    });
    test("an explicit invoke walks the steps; a call-then-call chain pipelines in ONE batch", async () => {
      const { itx, requests } = fakeItx();
      const conn = await connectToCapnweb(itx, "https://api.example/rpc", { transport: "batch" });
      expect(await conn.invoke([["counter"], ["inc", 5]])).toBe(5);
      expect(requests).toHaveLength(1);
    });
    test("a remote error surfaces as a rejection", async () => {
      const conn = await connectToCapnweb(fakeItx().itx, "https://api.example/rpc", {
        transport: "batch",
      });
      await expect((conn as any).boom()).rejects.toThrow(/kaboom/);
    });
    test("a non-2xx batch answer rejects with the status", async () => {
      const itx = {
        fetch: async () => new Response("no", { status: 502, statusText: "Bad Gateway" }),
      } as unknown as LibraryItx;
      const conn = await connectToCapnweb(itx, "https://api.example/rpc", { transport: "batch" });
      await expect((conn as any).hello("x")).rejects.toThrow(
        /batch to https:\/\/api.example\/rpc returned 502/,
      );
    });
  });
});

// ── mcp ── the MCP client against a fake server: a `Request → Response` function behind
// a fake `itx.fetch`, recording every request. Rows, not prose.

describe("mcp", () => {
  type Handler = (request: Request, body: any) => Response | Promise<Response>;

  /** A fake `itx` whose fetch records requests and answers with `handler`. */
  function fakeItx(handler: Handler): {
    itx: LibraryItx;
    requests: Array<{ request: Request; body: any }>;
  } {
    const requests: Array<{ request: Request; body: any }> = [];
    const itx = {
      fetch: async (request: Request) => {
        const text = await request.clone().text();
        const body = text ? JSON.parse(text) : undefined;
        requests.push({ request, body });
        return handler(request, body);
      },
    } as unknown as LibraryItx;
    return { itx, requests };
  }

  const json = (value: unknown, init: ResponseInit = {}) =>
    new Response(JSON.stringify(value), {
      ...init,
      headers: { "content-type": "application/json", ...(init.headers as Record<string, string>) },
    });

  const TOOLS = [
    { name: "echo", description: "echo the args", inputSchema: { type: "object" } },
    { name: "add", inputSchema: { type: "object" } },
    { name: "callTool", inputSchema: {} }, // a reserved name: reachable through callTool only
  ];

  /** The reference fake server: hands out a session id on initialize and insists on it afterwards. */
  function referenceServer(options: { sse?: boolean } = {}): Handler {
    return (request, body) => {
      if (request.method === "DELETE") return new Response(null, { status: 204 });
      if (body.method === "initialize")
        return json(
          {
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "fake", version: "0" },
            },
          },
          { headers: { "mcp-session-id": "s-1" } },
        );
      if (request.headers.get("mcp-session-id") !== "s-1")
        return new Response("no session", { status: 400 });
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      let result: unknown;
      if (body.method === "tools/list") result = { tools: TOOLS };
      else if (body.method === "tools/call") {
        const { name, arguments: args } = body.params;
        if (name === "echo")
          result = { content: [{ type: "text", text: JSON.stringify({ echoed: args }) }] };
        else if (name === "add")
          result = {
            content: [{ type: "text", text: "ignored" }],
            structuredContent: { sum: args.a + args.b },
          };
        else if (name === "plain") result = { content: [{ type: "text", text: "just text" }] };
        else if (name === "boom")
          result = { content: [{ type: "text", text: "it broke" }], isError: true };
        else
          return json({
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32602, message: `unknown tool ${name}` },
          });
      }
      const message = { jsonrpc: "2.0", id: body.id, result };
      return options.sse
        ? new Response(`event: message\ndata: ${JSON.stringify(message)}\n\n`, {
            headers: { "content-type": "text/event-stream" },
          })
        : json(message);
    };
  }

  /** A session-less server (no `mcp-session-id`, so nothing to DELETE): initialize, then `tools`, then
   *  every tools/call answers `answer` as text. */
  function plainServer(tools: { name: string }[] = [], answer = "answered"): Handler {
    return (_request, body) => {
      if (body?.method === "notifications/initialized") return new Response(null, { status: 202 });
      const result =
        body?.method === "initialize"
          ? { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "plain" } }
          : body?.method === "tools/list"
            ? { tools }
            : { content: [{ type: "text", text: answer }] };
      return json({ jsonrpc: "2.0", id: body?.id, result });
    };
  }

  describe("connectToMcp", () => {
    test("connect: initialize → initialized → tools/list, the session id riding on every later request", async () => {
      const { itx, requests } = fakeItx(referenceServer());
      const conn = await connectToMcp(itx, "https://mcp.example/rpc", {
        headers: { authorization: "Bearer t" },
      });
      expect(requests.map((r) => r.body?.method)).toEqual([
        "initialize",
        "notifications/initialized",
        "tools/list",
      ]);
      expect(requests[0].body.params.protocolVersion).toBe("2025-03-26");
      expect(requests[0].request.headers.get("authorization")).toBe("Bearer t");
      expect(requests[0].request.headers.get("accept")).toBe("application/json, text/event-stream");
      expect(requests[2].request.headers.get("mcp-session-id")).toBe("s-1");
      expect(conn.serverInfo().serverInfo).toEqual({ name: "fake", version: "0" });
      // the connection grew one method per listed tool (`callTool`, a reserved name, stays its own)
      expect(["echo", "add"].map((name) => typeof (conn as any)[name])).toEqual([
        "function",
        "function",
      ]);
    });

    const rows: Array<{
      call: (c: McpConnection) => Promise<unknown>;
      becomes?: unknown;
      throws?: RegExp;
      sse?: boolean;
    }> = [
      { call: (c) => c.callTool("echo", { text: "hi" }), becomes: { echoed: { text: "hi" } } },
      { call: (c) => (c as any).echo({ text: "dotted" }), becomes: { echoed: { text: "dotted" } } }, // a tool as a method
      { call: (c) => (c as any).add({ a: 2, b: 3 }), becomes: { sum: 5 } }, // structuredContent wins over text
      { call: (c) => c.callTool("plain"), becomes: "just text" }, // text that is not JSON stays text
      { call: (c) => c.callTool("boom"), throws: /MCP tool boom failed: it broke/ },
      { call: (c) => c.callTool("nope"), throws: /MCP tools\/call: unknown tool nope/ },
      {
        call: (c) => c.callTool("echo", { via: "sse" }),
        becomes: { echoed: { via: "sse" } },
        sse: true,
      },
      { call: (c) => c.listTools(), becomes: TOOLS },
    ];
    for (const row of rows)
      test(`${row.call.toString().slice(0, 50)} → ${row.throws ?? JSON.stringify(row.becomes)}`, async () => {
        const { itx } = fakeItx(referenceServer({ sse: row.sse }));
        const conn = await connectToMcp(itx, "https://mcp.example/rpc");
        if (row.throws) await expect(row.call(conn)).rejects.toThrow(row.throws);
        else expect(await row.call(conn)).toEqual(row.becomes);
      });

    test("a tool named like a reserved member does not shadow it: callTool stays callTool", async () => {
      const { itx } = fakeItx(referenceServer());
      const conn = await connectToMcp(itx, "https://mcp.example/rpc");
      expect(await conn.callTool("echo", { x: 1 })).toEqual({ echoed: { x: 1 } });
    });

    test("listTools REFUSES a server tool of the wrong shape — network data is parsed, not cast", async () => {
      // An external MCP server is untrusted: a tool whose `name` is a number must not reach a typed
      // frontend as McpTool[]. The first tools/list (at connect) is clean; the second is off-spec.
      let listings = 0;
      const { itx } = fakeItx((request, body) => {
        if (request.method === "DELETE") return new Response(null, { status: 204 });
        if (body.method === "initialize")
          return json(
            { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "fake", version: "0" } } },
            { headers: { "mcp-session-id": "s-1" } },
          );
        if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
        const result =
          body.method === "tools/list" ? { tools: ++listings === 1 ? [] : [{ name: 42 }] } : {};
        return json({ jsonrpc: "2.0", id: body.id, result });
      });
      const conn = await connectToMcp(itx, "https://mcp.example/rpc");
      await expect(conn.listTools()).rejects.toThrow();
    });

    test("close DELETEs the session once; a server without a session id gets no DELETE", async () => {
      const withSession = fakeItx(referenceServer());
      const conn = await connectToMcp(withSession.itx, "https://mcp.example/rpc");
      await conn.close();
      await conn.close();
      const deletes = withSession.requests.filter((r) => r.request.method === "DELETE");
      expect(deletes).toHaveLength(1);
      expect(deletes[0].request.headers.get("mcp-session-id")).toBe("s-1");
      const sessionless = fakeItx(plainServer());
      await (await connectToMcp(sessionless.itx, "https://mcp.example/rpc")).close();
      expect(sessionless.requests.some((r) => r.request.method === "DELETE")).toBe(false);
    });

    test("a connection closed by a holder re-runs its handshake on the next request — a closed connection is never dead", async () => {
      const { itx, requests } = fakeItx(referenceServer());
      const conn = await connectToMcp(itx, "https://mcp.example/rpc");
      await conn.close();
      expect(await conn.callTool("echo", { x: 1 })).toEqual({ echoed: { x: 1 } });
      expect(requests.filter((r) => r.body?.method === "initialize")).toHaveLength(2);
    });

    test("a tool named `then` never makes the connection THENABLE (an await would adopt it and call the tool, never settling): connect settles, no tools/call, and the tool stays reachable through callTool", async () => {
      const { itx, requests } = fakeItx(plainServer([{ name: "then" }, { name: "echo" }]));
      const conn = await connectToMcp(itx, "https://mcp.example/rpc");
      expect(requests.map((r) => r.body?.method)).not.toContain("tools/call");
      expect((conn as { then?: unknown }).then).toBeUndefined();
      expect(await conn.callTool("then")).toBe("answered");
    });

    test("an SSE answer the server leaves OPEN still connects — read as it arrives and left at the matching id, never awaited to EOF", async () => {
      const plain = plainServer();
      const encoder = new TextEncoder();
      const { itx } = fakeItx(async (request, body) => {
        const answer = await plain(request, body);
        if (answer.status !== 200) return answer;
        const message = await answer.text();
        return new Response(
          new ReadableStream({
            start(controller) {
              // one `data:` event, then the stream stays OPEN
              controller.enqueue(encoder.encode(`event: message\ndata: ${message}\n\n`));
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      });
      const conn = await connectToMcp(itx, "https://mcp.example/rpc");
      expect(conn.serverInfo().serverInfo).toEqual({ name: "plain" });
    });

    test("a non-2xx answer throws with the status and the body", async () => {
      const { itx } = fakeItx(() => new Response("nope", { status: 503 }));
      await expect(connectToMcp(itx, "https://mcp.example/rpc")).rejects.toThrow(
        /MCP initialize returned 503: nope/,
      );
    });
  });
});

// ── openapi ── the OpenAPI connection against a fake service behind a fake `itx.fetch`:
// how one input object becomes path, query, header and body, and where the base URL comes from.

describe("openapi", () => {
  const SPEC: OpenApiDocument = {
    openapi: "3.0.0",
    servers: [{ url: "https://api.example/v1" }],
    paths: {
      "/pets/{id}": {
        parameters: [{ name: "id", in: "path", required: true }],
        get: { operationId: "getPet", summary: "one pet" },
        delete: { operationId: "deletePet" },
      },
      "/pets": {
        get: {
          operationId: "listPets",
          parameters: [
            { name: "limit", in: "query", required: true },
            { name: "tag", in: "query" },
          ],
        },
        post: { operationId: "createPet", requestBody: { content: { "application/json": {} } } },
      },
      "/me": { get: { operationId: "me", parameters: [{ name: "x-user", in: "header" }] } },
      "/raw": { put: { operationId: "putRaw", requestBody: {} } },
      "/text": { get: { operationId: "getText" } },
      "/call": { get: { operationId: "call" } }, // reserved: reachable through call('call') only
      "/session": {
        get: {
          operationId: "whoami",
          parameters: [
            { name: "session", in: "cookie" },
            { name: "theme", in: "cookie" },
          ],
        },
      },
      "/then": { get: { operationId: "then" } }, // reserved too: a thenable connection would never settle
      "/items": {
        parameters: [{ name: "limit", in: "query", required: true }],
        // the operation OVERRIDES the path item's `limit` (same name, same location): optional here
        get: { operationId: "listItems", parameters: [{ name: "limit", in: "query" }] },
      },
    },
  };

  function fakeItx(answer: (request: Request) => Response = () => json({ ok: true })) {
    const requests: Request[] = [];
    const itx = {
      fetch: async (request: Request) => {
        requests.push(request);
        return answer(request);
      },
    } as unknown as LibraryItx;
    return { itx, requests };
  }
  const json = (value: unknown, init?: ResponseInit) =>
    new Response(JSON.stringify(value), {
      ...init,
      headers: { "content-type": "application/json" },
    });

  describe("connectToOpenApi", () => {
    const rows: Array<{
      op: string;
      input?: Record<string, unknown>;
      method: string;
      url: string;
      body?: unknown;
      header?: [string, string];
      throws?: RegExp;
    }> = [
      {
        op: "getPet",
        input: { id: "a/b" },
        method: "GET",
        url: "https://api.example/v1/pets/a%2Fb",
      },
      { op: "deletePet", input: { id: 7 }, method: "DELETE", url: "https://api.example/v1/pets/7" },
      {
        op: "listPets",
        input: { limit: 2, tag: "cat" },
        method: "GET",
        url: "https://api.example/v1/pets?limit=2&tag=cat",
      },
      {
        op: "listPets",
        input: { limit: 2 },
        method: "GET",
        url: "https://api.example/v1/pets?limit=2",
      },
      {
        op: "createPet",
        input: { name: "rex", age: 3 },
        method: "POST",
        url: "https://api.example/v1/pets",
        body: { name: "rex", age: 3 },
      },
      {
        op: "putRaw",
        input: { body: [1, 2] },
        method: "PUT",
        url: "https://api.example/v1/raw",
        body: [1, 2],
      }, // `{ body }` alone is the body verbatim
      {
        op: "me",
        input: { "x-user": "u1" },
        method: "GET",
        url: "https://api.example/v1/me",
        header: ["x-user", "u1"],
      },
      {
        op: "whoami",
        input: { session: "s 1" },
        method: "GET",
        url: "https://api.example/v1/session",
        header: ["cookie", "session=s%201"],
      }, // a cookie parameter rides the cookie header
      {
        op: "whoami",
        input: { session: "s 1", theme: "dark" },
        method: "GET",
        url: "https://api.example/v1/session",
        header: ["cookie", "session=s%201; theme=dark"],
      }, // two cookie parameters are ONE `; `-joined header (RFC 6265), never `, `-joined
      { op: "getPet", input: {}, method: "GET", url: "", throws: /getPet needs "id"/ },
      {
        op: "listPets",
        input: {},
        method: "GET",
        url: "",
        throws: /listPets needs query parameter "limit"/,
      },
      { op: "listItems", input: {}, method: "GET", url: "https://api.example/v1/items" }, // the operation's optional `limit` overrides the path item's required one
      {
        op: "getText",
        input: { junk: 1 },
        method: "GET",
        url: "",
        throws: /getText has no request body and got unknown input key "junk"/,
      },
      { op: "nope", method: "GET", url: "", throws: /no operation "nope"/ },
    ];
    for (const row of rows)
      test(`${row.op}(${JSON.stringify(row.input ?? {})}) → ${row.throws ?? `${row.method} ${row.url}`}`, async () => {
        const { itx, requests } = fakeItx();
        const conn = await connectToOpenApi(itx, SPEC, { headers: { authorization: "Bearer t" } });
        if (row.throws) {
          await expect(conn.call(row.op, row.input)).rejects.toThrow(row.throws);
          return;
        }
        expect(await conn.call(row.op, row.input)).toEqual({ ok: true });
        const [request] = requests;
        expect(request.method).toBe(row.method);
        expect(request.url).toBe(row.url);
        expect(request.headers.get("authorization")).toBe("Bearer t");
        if (row.body !== undefined) {
          expect(JSON.parse(await request.text())).toEqual(row.body);
          expect(request.headers.get("content-type")).toBe("application/json");
        } else expect(request.body).toBeNull();
        if (row.header) expect(request.headers.get(row.header[0])).toBe(row.header[1]);
      });

    test("operations become methods; a reserved operationId (`call`, and `then` — a thenable connection would never settle) stays reachable through call()", async () => {
      const { itx, requests } = fakeItx();
      const conn = await connectToOpenApi(itx, SPEC);
      expect(conn.operations().map((o) => o.operationId)).toEqual([
        "getPet",
        "deletePet",
        "listPets",
        "createPet",
        "me",
        "putRaw",
        "getText",
        "call",
        "whoami",
        "then",
        "listItems",
      ]);
      expect((conn as { then?: unknown }).then).toBeUndefined();
      expect(await (conn as any).getPet({ id: 1 })).toEqual({ ok: true });
      expect(await conn.call("call")).toEqual({ ok: true });
      expect(await conn.call("then")).toEqual({ ok: true });
      expect(requests.map((r) => new URL(r.url).pathname)).toEqual([
        "/v1/pets/1",
        "/v1/call",
        "/v1/then",
      ]);
    });

    test("a text answer is text; a non-2xx answer throws with the status and a snippet", async () => {
      const { itx } = fakeItx((request) =>
        request.url.endsWith("/text")
          ? new Response("plain", { headers: { "content-type": "text/plain" } })
          : new Response("gone", { status: 410 }),
      );
      const conn = await connectToOpenApi(itx, SPEC);
      expect(await conn.call("getText")).toBe("plain");
      await expect(conn.call("getPet", { id: 1 })).rejects.toThrow(
        /GET \/v1\/pets\/1 \(getPet\) returned 410: gone/,
      );
    });

    test("from a URL: the document is fetched (auth headers only on the API's host), and a document without servers is addressed under the spec URL, QUERY KEPT", async () => {
      const specUrl = "https://api--prj-x.worker.example/v2/openapi.json?rev=3";
      const { itx, requests } = fakeItx((request) =>
        request.url === specUrl
          ? json({ ...SPEC, servers: [] })
          : json({ pet: new URL(request.url).pathname }),
      );
      const conn = await connectToOpenApi(itx, specUrl, {
        headers: { authorization: "Bearer t" },
      });
      expect(requests[0].headers.get("authorization")).toBe("Bearer t");
      expect(await conn.call("getPet", { id: 5 })).toEqual({ pet: "/v2/pets/5" });
      expect(requests[1].url).toBe("https://api--prj-x.worker.example/v2/pets/5?rev=3");
      // the spec on another host than the API (baseUrl names the API): the auth header stays home
      const other = fakeItx((request) =>
        request.url.includes("spec.example") ? json(SPEC) : json({}),
      );
      const conn2 = await connectToOpenApi(other.itx, "https://spec.example/openapi.json", {
        baseUrl: "https://api.example/v1",
        headers: { authorization: "Bearer t" },
      });
      expect(other.requests[0].headers.get("authorization")).toBeNull();
      await conn2.call("getPet", { id: 1 });
      expect(other.requests[1].headers.get("authorization")).toBe("Bearer t");
    });

    test("from a URL: a RELATIVE servers[0].url resolves against the spec URL, QUERY KEPT", async () => {
      const specUrl = "https://api--prj-x.worker.example/v2/openapi.json?rev=3";
      const { itx, requests } = fakeItx((request) =>
        request.url === specUrl ? json({ ...SPEC, servers: [{ url: "api" }] }) : json({ ok: true }),
      );
      const conn = await connectToOpenApi(itx, specUrl);
      await conn.call("getPet", { id: 5 });
      expect(requests[1].url).toBe("https://api--prj-x.worker.example/v2/api/pets/5?rev=3");
    });

    test("an INLINE document whose servers[0].url is relative is refused at connect with the baseUrl hint — never a raw TypeError", async () => {
      await expect(
        connectToOpenApi(fakeItx().itx, { ...SPEC, servers: [{ url: "/v1" }] }),
      ).rejects.toThrow(/needs \{ baseUrl \}/);
    });

    test("baseUrl overrides the document's server", async () => {
      const { itx, requests } = fakeItx();
      const conn = await connectToOpenApi(itx, SPEC, { baseUrl: "https://staging.example/api/" });
      await conn.call("getPet", { id: 1 });
      expect(requests[0].url).toBe("https://staging.example/api/pets/1");
    });

    test("not an OpenAPI document → refused at connect", async () => {
      await expect(connectToOpenApi(fakeItx().itx, { nope: true } as any)).rejects.toThrow(
        /not an OpenAPI 3 document/,
      );
    });
  });
});

// ── the library boundary ── THE LIBRARY RULE, pinned: a library module takes `itx` and nothing else,
// so at runtime it may import only npm packages a userspace worker could bundle too (capnweb,
// cloudflare:workers) and the one platform primitive that is pure data or a handle
// (context/expression.ts — the codec, for an expression carried as data, and the pipelinable
// handle). Type-only imports are free (they erase). Anything else — the stream, the DO, the rest of
// context/ — would make the library un-movable to userspace, which is the whole point of the tier.
const ALLOWED_RUNTIME_IMPORTS = new Set([
  "capnweb",
  "cloudflare:workers",
  "zod", // an npm package a userspace worker could bundle too — used to PARSE untrusted MCP responses
  "./context/expression.ts",
]);

describe("the library boundary", () => {
  test("library.ts imports only npm packages, the codec, and types", () => {
    const source = readFileSync(new URL("./library.ts", import.meta.url).pathname, "utf8");
    const offenders: string[] = [];
    for (const match of source.matchAll(
      /^import\s+(type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/gm,
    )) {
      const [, typeOnly, specifier] = match;
      if (typeOnly) continue;
      if (!ALLOWED_RUNTIME_IMPORTS.has(specifier)) offenders.push(specifier);
    }
    expect(offenders).toEqual([]);
  });
});
