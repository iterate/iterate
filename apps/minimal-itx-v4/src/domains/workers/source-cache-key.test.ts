import { describe, expect, it } from "vitest";
import { sha256Hex, stableSha256 } from "./source-cache-key.ts";

describe("worker source cache keys", () => {
  it("uses standard SHA-256 hex digests", async () => {
    await expect(sha256Hex("abc")).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("canonicalizes structured source identity before hashing", async () => {
    const first = await stableSha256({
      source: {
        mainModule: "b.ts",
        modules: { "a.ts": "export const a = 1;", "b.ts": "export default {};" },
        type: "inline",
      },
      type: "inline-worker-source",
    });
    const second = await stableSha256({
      source: {
        mainModule: "b.ts",
        modules: { "b.ts": "export default {};", "a.ts": "export const a = 1;" },
        type: "inline",
      },
      type: "inline-worker-source",
    });

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });
});
