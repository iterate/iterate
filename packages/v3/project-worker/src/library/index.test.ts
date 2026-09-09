// library/index.test.ts — the memo `buildLibrary` keeps over the three verbs: a connect with the same
// (verb, url, options) is ONE live connection for the context's life; `releaseConnections()` (the
// idle quiesce's call) closes what it holds and the next use reopens; a connect that FAILS is never
// kept. ONE fake `itx.fetch` serves all three remotes by host and records every handshake.
import { RpcTarget, newHttpBatchRpcResponse } from "capnweb";
import { describe, expect, test } from "vitest";
import { buildLibrary, type LibraryItx, type LibraryRoots } from "./index.ts";
import type { OpenApiDocument } from "./openapi.ts";

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
      connect: (roots) => roots.connectToCapnweb("https://rpc.example/rpc", { transport: "batch" }),
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
