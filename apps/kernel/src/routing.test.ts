import { describe, expect, test } from "vitest";
import { routingFor, type RoutingKV } from "./routing.ts";

// Map-backed KV, structurally a RoutingKV — real get/put/delete, no worker needed (mirrors
// directory.test.ts's mockKV).
function mockKV(): RoutingKV {
  const m = new Map<string, string>();
  return {
    get: async (k) => m.get(k) ?? null,
    put: async (k, v) => void m.set(k, v),
    delete: async (k) => void m.delete(k),
  };
}

describe("routing — config + KV, config wins", () => {
  test("config routes resolve (app defaults to the public app)", async () => {
    const r = routingFor({ routes: { "example.com": { projectId: "alice" } } }, {});
    expect(await r.lookup("example.com")).toEqual({ projectId: "alice", app: "" });
    // admin.example.com now resolves as the `admin` app of the example.com apex (ADR 0031 — tested in the
    // custom-domain suite below); an UNREGISTERED host is what returns null.
    expect(await r.lookup("nope.org")).toBeNull();
  });

  test("config routes carry an explicit app", async () => {
    const r = routingFor({ routes: { "admin.acme.com": { projectId: "acme", app: "admin" } } }, {});
    expect(await r.lookup("admin.acme.com")).toEqual({ projectId: "acme", app: "admin" });
  });

  test("lookup is case-insensitive", async () => {
    const r = routingFor({ routes: { "example.com": { projectId: "alice" } } }, {});
    expect(await r.lookup("Example.COM")).toEqual({ projectId: "alice", app: "" });
  });

  test("no routes + no KV => everything is null (fall back to the convention)", async () => {
    const r = routingFor({}, {});
    expect(await r.lookup("anything.com")).toBeNull();
  });
});

describe("routing — dynamic KV map/unmap", () => {
  test("map persists, lookup finds it, unmap removes it", async () => {
    const r = routingFor({}, { ROUTING_KV: mockKV() });
    expect(await r.lookup("shop.example.com")).toBeNull();
    await r.map("shop.example.com", { projectId: "shop", app: "" });
    expect(await r.lookup("shop.example.com")).toEqual({ projectId: "shop", app: "" });
    await r.unmap("shop.example.com");
    expect(await r.lookup("shop.example.com")).toBeNull();
  });

  test("config wins over KV for the same host", async () => {
    const kv = mockKV();
    const r = routingFor({ routes: { "x.com": { projectId: "from-config" } } }, { ROUTING_KV: kv });
    await r.map("x.com", { projectId: "from-kv", app: "" });
    expect(await r.lookup("x.com")).toEqual({ projectId: "from-config", app: "" });
  });

  test("map is read-only without a KV binding (config routes only)", async () => {
    const r = routingFor({ routes: { "example.com": { projectId: "alice" } } }, {});
    await expect(r.map("new.com", { projectId: "alice", app: "" })).rejects.toThrow(/read-only/);
  });
});

describe("routing — custom-domain subdomains-as-apps (ADR 0031)", () => {
  test("a custom apex serves its subdomains as apps", async () => {
    const r = routingFor({ routes: { "bob.com": { projectId: "bob" } } }, {});
    expect(await r.lookup("bob.com")).toEqual({ projectId: "bob", app: "" }); // apex = default app
    expect(await r.lookup("docs.bob.com")).toEqual({ projectId: "bob", app: "docs" }); // subdomain = app
    expect(await r.lookup("blog.bob.com")).toEqual({ projectId: "bob", app: "blog" });
  });

  test("an exact subdomain route wins over the parent-derived app", async () => {
    const r = routingFor(
      { routes: { "bob.com": { projectId: "bob" }, "docs.bob.com": { projectId: "otherproj" } } },
      {},
    );
    expect(await r.lookup("docs.bob.com")).toEqual({ projectId: "otherproj", app: "" });
  });

  test("a subdomain of a NON-registered host does not resolve (falls through to the convention)", async () => {
    const r = routingFor({ routes: { "bob.com": { projectId: "bob" } } }, {});
    expect(await r.lookup("docs.alice.com")).toBeNull(); // alice.com not registered
  });

  test("only ONE level of subdomain-as-app (deeper names don't resolve)", async () => {
    const r = routingFor({ routes: { "bob.com": { projectId: "bob" } } }, {});
    expect(await r.lookup("a.docs.bob.com")).toBeNull(); // parent `docs.bob.com` isn't registered
  });

  test("a parent that is itself an APP route does not lend subdomains (only apex → apps)", async () => {
    const r = routingFor({ routes: { "x.com": { projectId: "p", app: "admin" } } }, {});
    expect(await r.lookup("docs.x.com")).toBeNull(); // x.com maps to an app, not a project apex
  });
});
