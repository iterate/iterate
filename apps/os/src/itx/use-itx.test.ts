import { describe, expect, test, vi } from "vitest";
import { createSocketSuspenseCache } from "./use-itx.ts";

function harness() {
  const deaths = new Map<string, () => void>();
  let dials = 0;
  const pool = createSocketSuspenseCache<string>({
    connect: (context, onDead) => {
      dials += 1;
      deaths.set(context ?? "", onDead);
      return Promise.resolve(`stub:${context ?? "global"}:${dials}`);
    },
  });
  return { pool, deaths, dials: () => dials };
}

describe("createSocketSuspenseCache", () => {
  test("get() returns the SAME entry across calls — the stable promise Suspense needs", async () => {
    const { pool, dials } = harness();
    const entry = pool.get("prj_1");
    expect(pool.get("prj_1")).toBe(entry);
    expect(dials()).toBe(1);
    await expect(entry.promise).resolves.toBe("stub:prj_1:1");
  });

  test("contexts are independent; omitted context is its own key", () => {
    const { pool, dials } = harness();
    const global = pool.get();
    expect(pool.get("prj_1")).not.toBe(global);
    expect(pool.get()).toBe(global);
    expect(dials()).toBe(2);
  });

  test("death evicts the entry and notifies subscribers; the next get() dials fresh", async () => {
    const { pool, deaths, dials } = harness();
    const listener = vi.fn();
    pool.subscribe("prj_1", listener);
    const first = pool.get("prj_1");

    deaths.get("prj_1")!();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(pool.peek("prj_1")).toBeUndefined();

    const second = pool.get("prj_1");
    expect(second).not.toBe(first);
    expect(dials()).toBe(2);
    await expect(second.promise).resolves.toBe("stub:prj_1:2");
  });

  test("a stale connection's death never evicts its successor", () => {
    const { pool, deaths } = harness();
    pool.get("prj_1");
    const firstDeath = deaths.get("prj_1")!;
    firstDeath(); // evicts the first entry
    const second = pool.get("prj_1");
    firstDeath(); // stale: must not touch the second entry
    expect(pool.peek("prj_1")).toBe(second);
  });

  test("unsubscribed listeners stop firing", () => {
    const { pool, deaths } = harness();
    const listener = vi.fn();
    const unsubscribe = pool.subscribe("prj_1", listener);
    pool.get("prj_1");
    unsubscribe();
    deaths.get("prj_1")!();
    expect(listener).not.toHaveBeenCalled();
  });
});
