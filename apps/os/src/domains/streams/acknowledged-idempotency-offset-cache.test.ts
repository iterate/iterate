import { describe, expect, it } from "vitest";
import {
  AcknowledgedCrossPostDeliveryCache,
  AcknowledgedIdempotencyOffsetCache,
} from "./acknowledged-idempotency-offset-cache.ts";

describe("AcknowledgedIdempotencyOffsetCache", () => {
  it("returns a batch only when every key has a committed offset", () => {
    const cache = new AcknowledgedIdempotencyOffsetCache();
    cache.remember("first", 10);
    cache.remember("second", 11);

    expect(cache.getAll(new Set(["second", "first"]))).toEqual(
      new Map([
        ["second", 11],
        ["first", 10],
      ]),
    );
    expect(cache.getAll(new Set(["first", "missing"]))).toBeUndefined();
  });

  it("bounds key length and evicts the oldest of 128 entries", () => {
    const cache = new AcknowledgedIdempotencyOffsetCache();
    cache.remember("x".repeat(513), 1);
    expect(cache.get("x".repeat(513))).toBeUndefined();

    for (let index = 0; index < 129; index += 1) {
      cache.remember(`key-${index}`, index + 1);
    }

    expect(cache.get("key-0")).toBeUndefined();
    expect(cache.get("key-1")).toBe(2);
    expect(cache.get("key-128")).toBe(129);
  });
});

function delivery(
  overrides: Partial<Parameters<AcknowledgedCrossPostDeliveryCache["has"]>[0]> = {},
) {
  return {
    configuredEvent: { offset: 11 },
    deliveryId: "subscriber:1-10",
    path: "/source",
    projectId: "prj_test",
    subscriptionKey: "subscriber",
    ...overrides,
  };
}

describe("AcknowledgedCrossPostDeliveryCache", () => {
  it("recognizes only the same source delivery and configuration", () => {
    const cache = new AcknowledgedCrossPostDeliveryCache();
    cache.remember(delivery());

    expect(cache.has(delivery())).toBe(true);
    expect(cache.has(delivery({ projectId: "prj_other" }))).toBe(false);
    expect(cache.has(delivery({ path: "/other" }))).toBe(false);
    expect(cache.has(delivery({ subscriptionKey: "other" }))).toBe(false);
    expect(cache.has(delivery({ configuredEvent: { offset: 12 } }))).toBe(false);
    expect(cache.has(delivery({ deliveryId: "subscriber:2-10" }))).toBe(false);
  });

  it("evicts the oldest delivery after 128 entries", () => {
    const cache = new AcknowledgedCrossPostDeliveryCache();
    for (let index = 0; index < 129; index += 1) {
      cache.remember(delivery({ deliveryId: `subscriber:${index}-${index}` }));
    }

    expect(cache.has(delivery({ deliveryId: "subscriber:0-0" }))).toBe(false);
    expect(cache.has(delivery({ deliveryId: "subscriber:128-128" }))).toBe(true);
  });

  it("does not retain oversized delivery identities", () => {
    const cache = new AcknowledgedCrossPostDeliveryCache();
    const oversized = delivery({ deliveryId: "x".repeat(2_049) });
    cache.remember(oversized);
    expect(cache.has(oversized)).toBe(false);
  });
});
