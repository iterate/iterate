import { describe, expect, test } from "vitest";
import { decryptSecretCellMaterial, encryptSecretCellMaterial } from "./crypto.ts";

const key = "test-secret-encryption-key";
const binding = {
  egressOrigins: ["https://api.example.com", "https://auth.example.com"],
  offset: 17,
  path: "/secrets/example",
  projectId: "prj_example",
};

describe("secret-cell material encryption", () => {
  test("round-trips only in the same project, path, origin policy, and offset", async () => {
    const encrypted = await encryptSecretCellMaterial("write-only", key, binding);

    await expect(decryptSecretCellMaterial(encrypted, key, binding)).resolves.toBe("write-only");

    for (const changed of [
      { ...binding, projectId: "prj_attacker" },
      { ...binding, path: "/secrets/copied" },
      { ...binding, egressOrigins: ["https://attacker.example"] },
      { ...binding, offset: binding.offset + 1 },
    ]) {
      await expect(decryptSecretCellMaterial(encrypted, key, changed)).rejects.toBeDefined();
    }
  });

  test("canonicalizes duplicate origin order", async () => {
    const encrypted = await encryptSecretCellMaterial("write-only", key, {
      ...binding,
      egressOrigins: [
        "https://auth.example.com",
        "https://api.example.com",
        "https://auth.example.com",
      ],
    });

    await expect(decryptSecretCellMaterial(encrypted, key, binding)).resolves.toBe("write-only");
  });
});
