import { describe, expect, it } from "vitest";
import {
  decryptSecretMaterial,
  encryptSecretMaterial,
  generateSecretsKeyBase64,
  importSecretsKey,
} from "./secret-crypto.ts";

describe("secret-crypto", () => {
  it("round-trips material through the AES-GCM envelope", async () => {
    const key = await importSecretsKey(generateSecretsKeyBase64());
    const encrypted = await encryptSecretMaterial({ key, material: "ghp_super-secret-token" });

    expect(encrypted.envelope).toBe("aes-256-gcm.v1");
    expect(encrypted.ciphertext).not.toContain("ghp_super-secret-token");
    expect(await decryptSecretMaterial({ key, encrypted })).toBe("ghp_super-secret-token");
  });

  it("produces a fresh iv per encryption", async () => {
    const key = await importSecretsKey(generateSecretsKeyBase64());
    const first = await encryptSecretMaterial({ key, material: "same" });
    const second = await encryptSecretMaterial({ key, material: "same" });
    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it("refuses to decrypt with the wrong key", async () => {
    const encrypted = await encryptSecretMaterial({
      key: await importSecretsKey(generateSecretsKeyBase64()),
      material: "secret",
    });
    const wrongKey = await importSecretsKey(generateSecretsKeyBase64());
    await expect(decryptSecretMaterial({ key: wrongKey, encrypted })).rejects.toThrow();
  });

  it("rejects keys that are not 32 bytes", async () => {
    await expect(importSecretsKey(btoa("short"))).rejects.toThrow(/32 bytes/);
  });
});
