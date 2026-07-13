import { describe, expect, it } from "vitest";
import { AcknowledgedIdempotencyOffsetCache } from "./acknowledged-idempotency-offset-cache.ts";

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
