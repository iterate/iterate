import { describe, expect, test } from "vitest";
import { randomSealKey, seal, unseal } from "./seal.ts";

describe("seal/unseal", () => {
  test("round-trips arbitrary JSON payloads", async () => {
    const key = randomSealKey();
    const payload = { t: "access", sub: "Demo User", nested: { n: 42, list: [1, "two"] } };
    const token = await seal(payload, key);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, URL-safe as a query param
    expect(await unseal(token, key)).toEqual(payload);
  });

  test("every seal is unique (fresh IV) but unseals identically", async () => {
    const key = randomSealKey();
    const [a, b] = [await seal({ x: 1 }, key), await seal({ x: 1 }, key)];
    expect(a).not.toBe(b);
    expect(await unseal(a, key)).toEqual(await unseal(b, key));
  });

  test("returns null for a token sealed under a different key", async () => {
    const token = await seal({ sub: "x" }, randomSealKey());
    expect(await unseal(token, randomSealKey())).toBeNull();
  });

  test("returns null for tampered and malformed tokens", async () => {
    const key = randomSealKey();
    const token = await seal({ sub: "x" }, key);
    // Flip a mid-token character (the last one can land in truncated base64
    // padding bits and decode to identical bytes).
    const mid = Math.floor(token.length / 2);
    const flipped = token.slice(0, mid) + (token[mid] === "A" ? "B" : "A") + token.slice(mid + 1);
    expect(await unseal(flipped, key)).toBeNull();
    expect(await unseal("", key)).toBeNull();
    expect(await unseal("not-a-token", key)).toBeNull();
  });

  test("randomSealKey mints distinct 32-byte base64 keys", () => {
    const key = randomSealKey();
    expect(Buffer.from(key, "base64")).toHaveLength(32);
    expect(randomSealKey()).not.toBe(key);
  });
});
