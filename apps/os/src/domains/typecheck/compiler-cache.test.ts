// The compiler cache's one job beyond memoization: after a mid-compile crash,
// the NEXT get() must hand back a fresh instance, not the dead one. This is
// what keeps the execution gate from failing open forever when the tswasm
// program exits (see compiler-cache.ts).

import { describe, expect, it } from "vitest";
import { createCompilerCache } from "./compiler-cache.ts";

describe("createCompilerCache", () => {
  it("memoizes one instance across get() calls", async () => {
    let built = 0;
    const cache = createCompilerCache(async () => ({ id: ++built }));
    const a = await cache.get();
    const b = await cache.get();
    expect(a).toBe(b);
    expect(built).toBe(1);
  });

  it("re-instantiates after resetIfCurrent — the crash-recovery path", async () => {
    let built = 0;
    const cache = createCompilerCache(async () => ({ id: ++built }));
    const dead = cache.get();
    await dead;
    // A compile on `dead` crashed; drop it.
    cache.resetIfCurrent(dead);
    const fresh = await cache.get();
    expect((await dead).id).toBe(1);
    expect(fresh.id).toBe(2);
    expect(built).toBe(2);
  });

  it("resetIfCurrent is a no-op for a stale promise (a newer instance survives)", async () => {
    let built = 0;
    const cache = createCompilerCache(async () => ({ id: ++built }));
    const first = cache.get();
    await first;
    cache.resetIfCurrent(first); // drops first
    const second = cache.get();
    await second;
    // A late crash report for the ALREADY-replaced `first` must not evict the
    // live `second`.
    cache.resetIfCurrent(first);
    expect(await cache.get()).toBe(await second);
    expect(built).toBe(2);
  });

  it("does not cache a failed instantiation — the next get() retries", async () => {
    let attempt = 0;
    const cache = createCompilerCache(async () => {
      attempt++;
      if (attempt === 1) throw new Error("wasm instantiation failed");
      return { id: attempt };
    });
    await expect(cache.get()).rejects.toThrow("wasm instantiation failed");
    // Let the .catch() eviction settle before retrying.
    await Promise.resolve();
    const ok = await cache.get();
    expect(ok.id).toBe(2);
  });
});
