// library-connectors-mcp-openapi-capnweb.e2e — THE LIBRARY, end to end: `itx.connectToMcp`,
// `itx.connectToOpenApi`, `itx.connectToCapnweb` reach tiny fixture servers (e2e/support/sources.ts)
// that a SECOND project hosts as loaded workers behind the fetch lane, so every byte goes out through
// the client context's own egress and back in through the worker's front door. Locally egress is the
// DummyControlPlane (a plain fetch); deployed it is the control plane. The last test dials THIS
// worker's own /api through the library: a context calling another project over capnweb.
import { afterAll, expect, test } from "vitest";

/** The local lane's egress terminal (DummyControlPlane) is workerd's fetch proxied through Node's, which
 *  cannot upgrade to a WebSocket, so the WebSocket transport is proved against the deployed worker
 *  only; the batch transport and everything HTTP is proved on both lanes. */
const LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost)\b/.test(process.env.WORKER_BASE_URL ?? "");
import { disposeSessions, expressionUrl, freshCtx, openItx, workerUrl } from "./support/client.ts";
import { SOURCES } from "./support/sources.ts";

afterAll(() => disposeSessions());

/** A second project hosting `fixture` as a loaded worker behind its fetch lane; returns the lane URL. */
async function hostFixture(name: string, fixture: keyof typeof SOURCES, scheme: "http" | "ws" = "http"): Promise<string> {
  const serverCtx = freshCtx(`lib-${name}-server`);
  const server = openItx(serverCtx);
  await server.provide(`itx.${name}`, `itx.workers.get({ source: ${JSON.stringify(SOURCES[fixture])} })`);
  return expressionUrl(serverCtx, `itx.${name}`, scheme);
}

test("connectToMcp: initialize + tools/list at connect, callTool, a tool as a method, held across calls — the session id honoured on every request", async () => {
  const url = await hostFixture("mcp", "mcpServer");
  const itx = openItx(freshCtx("lib-mcp"));
  const tools = await itx.invoke(`itx.connectToMcp(${JSON.stringify(url)}).listTools()`);
  expect(tools.map((t: any) => t.name)).toEqual(["echo", "add"]);
  expect(await itx.invoke(`itx.connectToMcp(${JSON.stringify(url)}).callTool('echo', { text: 'hi' })`)).toEqual({ echoed: { text: "hi" } });
  expect(await itx.invoke(`itx.connectToMcp(${JSON.stringify(url)}).add({ a: 2, b: 3 })`)).toEqual({ sum: 5 });
  // held across calls: the connection is an RpcTarget the client keeps
  const conn = await itx.connectToMcp(url);
  expect((await conn.serverInfo()).serverInfo).toEqual({ name: "fixture-mcp", version: "1" });
  expect(await conn.echo({ text: "again" })).toEqual({ echoed: { text: "again" } });
  await expect(conn.callTool("nope")).rejects.toThrow(/unknown tool nope/);
  await conn.close();
});

test("rules composition: provide('itx.tools', \"itx.connectToMcp('<url>')\") then itx.tools.listTools() and itx.tools.add(...) run through the table", async () => {
  const url = await hostFixture("mcp2", "mcpServer");
  const itx = openItx(freshCtx("lib-mcp-rule"));
  await itx.provide("itx.tools", `itx.connectToMcp(${JSON.stringify(url)})`);
  expect((await itx.tools.listTools()).map((t: any) => t.name)).toEqual(["echo", "add"]);
  expect(await itx.tools.add({ a: 40, b: 2 })).toEqual({ sum: 42 });
  expect((await itx.rewriteRules.resolve("itx.tools.add")).at(-1)).toBe(`itx.builtins.connectToMcp('${url}').add`);
});

test("connectToOpenApi: the document fetched over egress, operationIds become methods; path, query and body ride real paths through the lane", async () => {
  const base = await hostFixture("pets", "openapiServer");
  const specUrl = base.replace("/expression?", "/expression/openapi.json?");
  const itx = openItx(freshCtx("lib-openapi"));
  const pets = await itx.connectToOpenApi(specUrl);
  expect((await pets.operations()).map((o: any) => o.operationId)).toEqual(["getPet", "listPets", "createPet"]);
  expect(await pets.getPet({ id: 2 })).toEqual({ id: 2, name: "tom" });
  expect(await pets.listPets({ limit: 2 })).toEqual([{ id: 1, name: "rex" }, { id: 2, name: "tom" }]);
  expect(await pets.createPet({ name: "ace" })).toEqual({ id: 4, name: "ace", created: true });
  await expect(pets.getPet({ id: 9 })).rejects.toThrow(/getPet\) returned 404/);
  // and as one dotted expression through the table
  await itx.provide("itx.pets", `itx.connectToOpenApi(${JSON.stringify(specUrl)})`);
  expect(await itx.pets.getPet({ id: 3 })).toEqual({ id: 3, name: "kit" });
});

test.skipIf(LOCAL)("connectToCapnweb: a WebSocket session THROUGH EGRESS; a call-then-call chain pipelines; headers reach the handshake; disposed on close", async () => {
  const url = await hostFixture("rpc", "capnwebServer", "ws");
  const itx = openItx(freshCtx("lib-capnweb"));
  expect(await itx.invoke(`itx.connectToCapnweb(${JSON.stringify(url)}).hello('world')`)).toBe("hello world");
  expect(await itx.invoke(`itx.connectToCapnweb(${JSON.stringify(url)}).counter().inc(5)`)).toBe(5);
  const conn = await itx.connectToCapnweb(url, { headers: { authorization: "Bearer fixture" } });
  expect(await conn.headers()).toEqual({ authorization: "Bearer fixture" });
  const counter = conn.counter();
  expect(await counter.inc(2)).toBe(2);
  expect(await counter.inc(2)).toBe(4);
  conn[Symbol.dispose]();
});

test("connectToCapnweb, batch transport: one POST per chain, over egress", async () => {
  const url = await hostFixture("rpcb", "capnwebServer", "http");
  const itx = openItx(freshCtx("lib-capnweb-batch"));
  expect(await itx.invoke(`itx.connectToCapnweb(${JSON.stringify(url)}, { transport: 'batch' }).counter().inc(3)`)).toBe(3);
  const conn = await itx.connectToCapnweb(url, { transport: "batch" });
  expect(await conn.hello("batch")).toBe("hello batch");
});

test("self-dial, batch: a context calls ANOTHER project through this worker's own /api in one POST, over the library", async () => {
  const other = freshCtx("lib-other");
  const itx = openItx(freshCtx("lib-self-dial"));
  const whoami = await itx.invoke(
    `itx.connectToCapnweb(${JSON.stringify(workerUrl("/api"))}, { transport: 'batch' }).authenticate().projects.get(${JSON.stringify(other)}).whoami()`,
  );
  expect(whoami).toEqual({ projectId: other, path: "/" });
});

test.skipIf(LOCAL)("self-dial, WebSocket: the same call over a WebSocket session through the deployed egress", async () => {
  const other = freshCtx("lib-other-ws");
  const itx = openItx(freshCtx("lib-self-dial-ws"));
  const api = workerUrl("/api").replace(/^http/, "ws");
  const whoami = await itx.invoke(`itx.connectToCapnweb(${JSON.stringify(api)}).authenticate().projects.get(${JSON.stringify(other)}).whoami()`);
  expect(whoami).toEqual({ projectId: other, path: "/" });
});
