import { expect, test } from "vitest";
import { IterateWorkerEntrypoint } from "iterate/sdk";

test("the SDK worker base answers the platform readiness handshake through capability dispatch", async () => {
  const receiver = {
    // The reserved branch must not dispatch into an application method with
    // the same name.
    __iteratePlatformReady: () => false,
  };
  await expect(
    IterateWorkerEntrypoint.prototype.invokeCapability.call(receiver, {
      args: [],
      path: ["__iteratePlatformReady"],
    }),
  ).resolves.toBe(true);
});
