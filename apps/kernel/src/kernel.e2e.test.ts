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
    expect(names).toEqual(
      expect.arrayContaining(["list_projects", "create_project", "get_project"]),
    );
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

  test("scripting: run_script executes arbitrary code against the ITX tree, confined", async () => {
    // The os `exec_typescript` model: hand `itx => …` to MCP, it runs confined with only env.ITX.
    const r = await mcp({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "run_script",
        arguments: { project: "alice", code: "async (itx) => await itx.whoami()" },
      },
    });
    const out = JSON.parse(r.body.result.content[0].text);
    expect(out.ok).toBe(true);
    expect(out.out.projectId).toBe("alice"); // the script ran with alice's ITX and returned its whoami
  });

  test("scripting: provide_capability then invoke_capability (dynamic capabilities)", async () => {
    const provide = await mcp({
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: {
        name: "provide_capability",
        arguments: { project: "alice", name: "add", code: "async (itx, args) => args.a + args.b" },
      },
    });
    expect(provide.body.result.isError).toBeFalsy();

    const invoke = await mcp({
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: {
        name: "invoke_capability",
        arguments: { project: "alice", name: "add", args: { a: 2, b: 3 } },
      },
    });
    const out = JSON.parse(invoke.body.result.content[0].text);
    expect(out.ok).toBe(true);
    expect(out.out).toBe(5); // the dynamic capability ran and computed 2+3
  });

  test("scripting tools appear in tools/list (scripting facade present)", async () => {
    const tools = await mcp({ jsonrpc: "2.0", id: 13, method: "tools/list" });
    const names = tools.body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("run_script");
    expect(names).toContain("provide_capability");
    expect(names).toContain("invoke_capability");
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
    // Use a distinct stream path so this is independent of any state persisted by earlier runs (miniflare
    // keeps DO SQLite on disk between `vitest run`s). Append two events, read them back in a SEPARATE
    // request — proving durability + monotonic seq. (path chosen fresh via the loop index below.)
    const p = "e2e-" + Date.now(); // test-only; Date is fine here (not a workflow)
    const a1 = await hit("alice.example.com", `/__stream?path=${p}&append=hello`);
    const a2 = await hit("alice.example.com", `/__stream?path=${p}&append=world`);
    expect(a2.body.seq).toBe(a1.body.seq + 1); // monotonic, persisted across requests

    const read = await hit("alice.example.com", `/__stream?path=${p}`);
    expect(read.body.count).toBe(2);
    expect(read.body.events.map((e: { type: string }) => e.type)).toEqual(["hello", "world"]);

    // A DIFFERENT project's SAME path is isolated (its own DO instance — the DO name includes projectId).
    const bob = await hit("bob.example.com", `/__stream?path=${p}`);
    expect(bob.body.count).toBe(0);
  });

  test("only <slug>.<hostBase> resolves — stray hosts are a 404 (no arbitrary projects)", async () => {
    expect((await worker.fetch("http://127.0.0.1/")).status).toBe(404); // no base match
    expect((await hit("alice.evil.com")).status).toBe(404); // review #14: wrong base is not a project
    expect((await hit("alice.example.com")).status).toBe(200); // the right base resolves
  });
});
