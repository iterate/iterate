import { describe, expect, test } from "vitest";
import { BUILTIN_CAPABILITY_NAMES, capabilityRegistry, type CapabilityKV } from "./dynamic.ts";

function mockKV(): CapabilityKV {
  const m = new Map<string, string>();
  return {
    get: async (k) => m.get(k) ?? null,
    put: async (k, v) => void m.set(k, v),
    list: async ({ prefix } = {}) => ({
      keys: [...m.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name })),
    }),
  };
}

describe("dynamic capability registry", () => {
  test("provide + code + list round-trip, scoped by project", async () => {
    const kv = mockKV();
    const a = capabilityRegistry(kv, "proj-a");
    await a.provide("greet", "async (itx) => 'hi'");
    expect(await a.code("greet")).toBe("async (itx) => 'hi'");
    expect(await a.list()).toEqual(["greet"]);
    // a different project sees none (per-project scoping via the key prefix)
    expect(await capabilityRegistry(kv, "proj-b").list()).toEqual([]);
  });

  test("a dynamic capability can NEVER shadow a builtin (event-shadowing rule)", async () => {
    const reg = capabilityRegistry(mockKV(), "p");
    for (const builtin of ["whoami", "fetch", "streams", "secrets", "ai"]) {
      expect(BUILTIN_CAPABILITY_NAMES.has(builtin)).toBe(true);
      await expect(reg.provide(builtin, "async()=>1")).rejects.toThrow(/builtin/);
    }
  });
});
