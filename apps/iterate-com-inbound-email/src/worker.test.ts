import { expect, test, vi } from "vitest";
import worker from "./worker.ts";

test.for([
  {
    row: "a message is forwarded to Jonas",
    forwarded: async () => ({ messageId: "forwarded" }),
    rejected: [],
  },
  {
    row: "a message Email Routing will not forward (no SPF or DKIM pass) bounces",
    forwarded: async () => {
      throw new Error("non-authenticated emails cannot be forwarded");
    },
    rejected: ["iterate.com accepts only mail that passes SPF or DKIM."],
  },
])("iterate.com's inbound mail — $row", async ({ forwarded, rejected }) => {
  const forward = vi.fn(forwarded);
  const setReject = vi.fn();
  // the two members of a ForwardableEmailMessage the Worker uses
  await worker.email({ forward, setReject } as unknown as ForwardableEmailMessage);
  expect(forward).toHaveBeenCalledExactlyOnceWith("jonas@nustom.com");
  expect(setReject.mock.calls.flat()).toEqual(rejected);
});

test("any other forwarding failure is thrown, so the sender retries", async () => {
  const forward = vi.fn(async () => {
    throw new Error("internal error");
  });
  const setReject = vi.fn();
  await expect(
    worker.email({ forward, setReject } as unknown as ForwardableEmailMessage),
  ).rejects.toThrow("internal error");
  expect(setReject).not.toHaveBeenCalled();
});
