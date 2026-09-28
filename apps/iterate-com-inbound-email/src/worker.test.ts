import { expect, test, vi } from "vitest";
import worker from "./worker.ts";

test("every message to iterate.com is forwarded to Jonas", async () => {
  const forward = vi.fn(async (_to: string) => ({ messageId: "forwarded" }));
  // the one member of a ForwardableEmailMessage the Worker uses
  await worker.email({ forward } as unknown as ForwardableEmailMessage);
  expect(forward).toHaveBeenCalledExactlyOnceWith("jonas@nustom.com");
});
