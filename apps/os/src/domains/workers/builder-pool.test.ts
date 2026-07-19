import { describe, expect, it } from "vitest";
import { builderPoolMember, WORKER_BUILDER_POOL_SIZE } from "./builder-pool.ts";

describe("builderPoolMember", () => {
  it("is deterministic — retries of one key land on the member whose cache they warmed", () => {
    const key = "wb2-abc123def456";
    expect(builderPoolMember(key)).toBe(builderPoolMember(key));
  });

  it("names only real pool slots", () => {
    for (let i = 0; i < 64; i++) {
      const member = builderPoolMember(`wb2-key-${i}`);
      const slot = Number(member.replace("worker-builder-", ""));
      expect(member).toBe(`worker-builder-${slot}`);
      expect(slot).toBeGreaterThanOrEqual(0);
      expect(slot).toBeLessThan(WORKER_BUILDER_POOL_SIZE);
    }
  });

  it("spreads unrelated keys across the pool", () => {
    const members = new Set(
      Array.from({ length: 256 }, (_, i) => builderPoolMember(`wb2-spread-${i}`)),
    );
    expect(members.size).toBe(WORKER_BUILDER_POOL_SIZE);
  });

  it("failover attempts walk the ring away from the sick member and wrap", () => {
    const key = "wb2-failover-key";
    const primarySlot = Number(builderPoolMember(key).replace("worker-builder-", ""));
    for (let attempt = 0; attempt < WORKER_BUILDER_POOL_SIZE * 2; attempt++) {
      expect(builderPoolMember(key, attempt)).toBe(
        `worker-builder-${(primarySlot + attempt) % WORKER_BUILDER_POOL_SIZE}`,
      );
    }
    expect(builderPoolMember(key, 1)).not.toBe(builderPoolMember(key));
  });
});
