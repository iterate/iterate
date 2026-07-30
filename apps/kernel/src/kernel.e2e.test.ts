import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { unstable_dev, type Unstable_DevWorker } from "wrangler";

// Boots the real kernel on workerd (real Worker Loader, real ctx.exports, real config worker)
// and drives it over HTTP. Genuine end-to-end — nothing is mocked. (The `/api` capnweb tree runs
// over a WebSocket, which unstable_dev's loopback fetch can't dial with a project Host; the real
// capnweb round-trip — authenticate().whoami()/caller() — is proven live against prd instead.)
let worker: Unstable_DevWorker;

beforeAll(async () => {
  worker = await unstable_dev("src/kernel.ts", {
    config: "wrangler.test.jsonc", // routes-free, hosted-mode identity
    experimental: { disableExperimentalWarning: true },
  });
});
afterAll(async () => {
  await worker.stop();
});

async function hit(host: string, path = "/", headers: Record<string, string> = {}) {
  const res = await worker.fetch(`http://${host}${path}`, { headers: { host, ...headers } });
  const ct = res.headers.get("content-type") ?? "";
  const body: any = ct.includes("json") ? await res.json() : await res.text();
  return { status: res.status, body };
}

describe("kernel", () => {
  test("the public site is the config worker; the dashboard is KERNEL-served (control plane)", async () => {
    const site = await hit("alice.example.com"); // the default app — the config worker's public website
    expect(site.status).toBe(200);
    expect(String(site.body)).toContain("alice"); // projectId
    expect(String(site.body)).toContain("public website");

    // dashboard--<slug> is intercepted by the KERNEL (no OS_DASHBOARD_ORIGIN in test => inline page),
    // NOT the config worker. So /__debug (a config-worker path) does NOT reach the config worker here.
    const dash = await hit("dashboard--alice.example.com");
    expect(dash.status).toBe(200);
    expect(String(dash.body)).toContain("Kernel-served control plane"); // the kernel's inline dashboard
    const dbg = await hit("dashboard--alice.example.com", "/__debug");
    expect(String(dbg.body)).not.toContain("seenBindings"); // never fell through to the config worker
  });

  test("the kernel mints a narrow project-app-session for an authed member on the dashboard", async () => {
    // Authenticated (stub caller u1) + the dashboard + a project they can reach => the kernel mints a
    // project-app-session (review #3). The inline dashboard reports its presence, never the token.
    const authed = { authorization: "Bearer session:u1" };
    const dash = await hit("dashboard--alice.example.com", "/", authed);
    expect(String(dash.body)).toContain("project-app-session: <b>present</b>");

    // Anonymous on the dashboard gets none — nothing to act as.
    const anon = await hit("dashboard--alice.example.com");
    expect(String(anon.body)).toContain("project-app-session: <b>absent</b>");
  });

  test("confinement: the config worker sees ONLY its itx capability, no raw bindings, no vessel origin", async () => {
    const { body } = await hit("alice.example.com", "/__debug");
    expect(body.projectId).toBe("alice");
    expect(body.seenBindings).toEqual(["ITX"]); // exactly one binding — nothing else leaks in
    expect(body.seenBindings).not.toContain("LOADER"); // no raw kernel binding
  });

  test("a config-declared custom domain routes to its project — the routing table (ADR 0020/0025)", async () => {
    // `myapp.test` is NOT under the hostBase (example.com), so the <slug>.<hostBase> convention 404s
    // any off-base host with no route...
    expect((await hit("other.test", "/__debug")).status).toBe(404);
    // ...but APP_CONFIG.routes maps `myapp.test -> alice`, and routing is consulted BEFORE the
    // convention, so it serves alice's config worker — confinement intact (only the ITX binding). This
    // is the custom-domain / single-project-self-host path: a real hostname, no wildcard base needed.
    const dbg = await hit("myapp.test", "/__debug");
    expect(dbg.status).toBe(200);
    expect(dbg.body.projectId).toBe("alice");
    expect(dbg.body.seenBindings).toEqual(["ITX"]);
  });

  test("/api is a kernel-owned capnweb route — intercepted here, not proxied to the config worker", async () => {
    // The real transport is a WebSocket (proven live against prd). A plain GET still reaches the
    // kernel's capnweb handler: NOT a 404, and NOT the config-worker landing.
    const res = await worker.fetch("http://alice.example.com/api", {
      headers: { host: "alice.example.com" },
    });
    expect(res.status).not.toBe(404);
    expect(await res.text()).not.toContain("iterate project"); // didn't fall through to the landing
  });

  // /mcp — the control-plane MCP surface, a sibling to /api (ADR 0022). Deployment-wide (no project
  // host), so it works on ANY host reaching the worker. Stateless Streamable HTTP JSON-RPC.
  async function mcp(body: unknown, host = "alice.example.com") {
    const res = await worker.fetch(`http://${host}/mcp`, {
      method: "POST",
      headers: { host, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  test("/mcp initialize + tools/list — the control-plane MCP sibling to /api", async () => {
    const init = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(init.status).toBe(200);
    expect(init.body.result.serverInfo.name).toBe("iterate-kernel");
    expect(init.body.result.protocolVersion).toBeTruthy();

    const tools = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const names = tools.body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(["list_projects", "create_project", "get_project"]);
  });

  test("/mcp tools/call list_projects goes through the directory (the test config knows 'alice')", async () => {
    // The local directory in wrangler.test.jsonc is { provider: local, projects: ["alice"] }. An
    // anonymous caller can't list (membership), so we prove get_project resolves the known project.
    const got = await mcp({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "get_project", arguments: { slug: "alice" } },
    });
    expect(got.status).toBe(200);
    expect(got.body.result.content[0].text).toBe("alice"); // resolved via the directory
    expect(got.body.result.isError).toBeFalsy();
  });

  test("/mcp is deployment-wide — same answer regardless of which host reaches it", async () => {
    const a = await mcp({ jsonrpc: "2.0", id: 4, method: "tools/list" }, "alice.example.com");
    const b = await mcp(
      { jsonrpc: "2.0", id: 4, method: "tools/list" },
      "dashboard--alice.example.com",
    );
    expect(a.body.result.tools.length).toBe(b.body.result.tools.length);
  });

  test("streams: the durable log persists across requests (real ITX.streams, kills processEvent stub)", async () => {
    // Append two events through the confined config worker's ITX binding, then read them back in a
    // SEPARATE request — proving durability (SQLite DO survives between requests) + per-project scoping.
    const a1 = await hit("alice.example.com", "/__stream?append=hello");
    expect(a1.body.seq).toBe(1);
    const a2 = await hit("alice.example.com", "/__stream?append=world");
    expect(a2.body.seq).toBe(2); // monotonic seq, persisted

    const read = await hit("alice.example.com", "/__stream");
    expect(read.body.count).toBe(2);
    expect(read.body.events.map((e: { type: string }) => e.type)).toEqual(["hello", "world"]);

    // A DIFFERENT project's stream is isolated (its own DO instance — empty).
    const bob = await hit("bob.example.com", "/__stream");
    // bob isn't in the local directory, but the public site + streams don't gate on membership here;
    // the DO name derives from the projectId prop, so bob's "main" stream is a distinct, empty log.
    expect(bob.body.count).toBe(0);
  });

  test("only <slug>.<hostBase> resolves — stray hosts are a 404 (no arbitrary projects)", async () => {
    expect((await worker.fetch("http://127.0.0.1/")).status).toBe(404); // no base match
    expect((await hit("alice.evil.com")).status).toBe(404); // review #14: wrong base is not a project
    expect((await hit("alice.example.com")).status).toBe(200); // the right base resolves
  });
});
