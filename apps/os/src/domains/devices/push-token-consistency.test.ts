import { expect, test, vi } from "vitest";
import {
  appendAfterPushTokenSecretUpdate,
  assertPushTokenSecretRevision,
} from "./push-token-consistency.ts";

test("a failed device append clears only the Secret revision just written by enrollment", async () => {
  const appendError = new Error("device stream unavailable");
  const clearUpdatedSecret = vi.fn(async () => true);

  await expect(
    appendAfterPushTokenSecretUpdate({
      append: async () => {
        throw appendError;
      },
      clearUpdatedSecret,
    }),
  ).rejects.toBe(appendError);

  expect(clearUpdatedSecret).toHaveBeenCalledOnce();
});

test("a failed conditional clear keeps both failures observable", async () => {
  const appendError = new Error("device stream unavailable");
  const cleanupError = new Error("secret stream unavailable");

  await expect(
    appendAfterPushTokenSecretUpdate({
      append: async () => {
        throw appendError;
      },
      clearUpdatedSecret: async () => {
        throw cleanupError;
      },
    }),
  ).rejects.toMatchObject({
    errors: [appendError, cleanupError],
    message: "device enrollment failed and its new push token could not be cleared",
  });
});

test("push egress rejects a Secret revision newer than the stream-recorded device attempt", () => {
  expect(() => assertPushTokenSecretRevision(12, 11)).toThrow(
    "secret changed before the guarded fetch began",
  );
  expect(() => assertPushTokenSecretRevision(11, 11)).not.toThrow();
});
