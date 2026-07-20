import { expect, test } from "vitest";
import { decryptDevicePushToken, encryptDevicePushToken } from "./device-crypto.ts";

test("a device push token decrypts only at its authenticated project, path, owner, and offset", async () => {
  const binding = {
    offset: 7,
    ownerId: "usr_misha",
    path: "/devices/phone",
    projectId: "prj_test",
  };
  const encrypted = await encryptDevicePushToken("ExponentPushToken[secret]", "test-key", binding);

  await expect(decryptDevicePushToken(encrypted, "test-key", binding)).resolves.toBe(
    "ExponentPushToken[secret]",
  );
  await expect(
    decryptDevicePushToken(encrypted, "test-key", { ...binding, offset: 8 }),
  ).rejects.toBeDefined();
  await expect(
    decryptDevicePushToken(encrypted, "test-key", { ...binding, ownerId: "usr_someone_else" }),
  ).rejects.toBeDefined();
});
