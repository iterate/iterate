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
    expect(await r.lookup("admin.example.com")).toBeNull(); // not declared
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
