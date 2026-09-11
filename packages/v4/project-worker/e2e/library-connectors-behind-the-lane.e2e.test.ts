// library-connectors-behind-the-lane.e2e.test.ts — two platform features the library tier relies on,
// pinned by ONE test: the fetch lane accepts `/expression/<path>` and hands the Request to the target
// VERBATIM (a service behind the lane sees a real path), and the SDK bundle exports capnweb's SERVER
// half (`newWorkersRpcResponse`) built with the `workerd` condition, so a LOADED worker can serve a
// capnweb API that `connectToCapnweb` dials — here through egress, back into this worker's own lane.

import { expect, test } from "vitest";
import { expressionUrl, freshCtx, openItx, sleep } from "./support/client.ts";
import { SOURCES } from "./support/sources.ts";

const MCP_SERVER = {
  "cap.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class McpServer extends WorkerEntrypoint {
  async fetch(request) {
    const mode = new URL(request.url).searchParams.get("mode");
    if (mode === "large") return new Response("x".repeat(10000), { status: 503 });
    if (request.method === "DELETE") return new Response("gone", { status: mode === "close" ? 500 : 204 });
    if (request.method === "GET") {
      if (mode === "async") {
        const itx = await this.env.ITX.get();
        if (!(await itx.kv.get("mcp-async-failed"))) {
          await itx.kv.put("mcp-async-failed", "yes");
          return new Response("broken", { status: 500 });
        }
      }
      return new Response(null, { status: 405 });
    }
    const body = await request.json();
    if (body.method === "initialize") return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "lane", version: "1" } } }, { headers: { "mcp-session-id": "s-1" } });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [] } });
    return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "ok" }] } });
  }
}`,
};

async function mcpConnection(mode: string) {
  const context = freshCtx(`mcp-lane-${mode}`);
  const itx = openItx(context);
  await itx.provide("itx.mcpService", `itx.workers.get({ source: ${JSON.stringify(MCP_SERVER)} })`);
  const url = new URL(expressionUrl(context, "itx.mcpService.fetch"));
  url.searchParams.set("mode", mode);
  return await itx.connectToMcp(url.toString());
}

test("a loaded worker serves capnweb behind /expression/<path>, dialed with connectToCapnweb over the batch transport", async () => {
  const ctx = freshCtx("capnweb-behind-lane");
  const itx = openItx(ctx);
  await itx.provide(
    "itx.rpcService",
    `itx.workers.get({ source: ${JSON.stringify(SOURCES.capnwebServer)} })`,
  );
  const url = new URL(expressionUrl(ctx, "itx.rpcService.fetch"));
  url.pathname = "/expression/rpc/v1";
  const connection = await itx.connectToCapnweb(url.toString(), { transport: "batch" });
  expect(await connection.hello("lane")).toBe("hello lane");
  // the path suffix reached the loaded worker untouched
  expect(await connection.path()).toBe("/expression/rpc/v1");
});

test("connectToMcp through ITX preserves close failures and bounds a refused response", async () => {
  const close = await mcpConnection("close");
  await expect(close.close()).rejects.toThrow("MCP HTTP 500: gone");
  await expect(mcpConnection("large")).rejects.toThrow(
    `MCP initialize returned 503: ${"x".repeat(300)}`,
  );
});

test("connectToMcp surfaces one asynchronous transport failure, then the next explicit call reopens", async () => {
  const connection = await mcpConnection("async");
  await sleep(20);
  await expect(connection.listTools()).rejects.toThrow(
    /MCP (transport|tools\/list) returned 500: broken/,
  );
  expect(await connection.listTools()).toEqual([]);
});
