import { afterEach, expect, test, vi } from "vitest";
import { createCloudflareAccountApi } from "./cloudflare-event-subscriptions.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

test("bounds Cloudflare account API requests when the caller supplies a timeout", async () => {
  let requestSignal: AbortSignal | null | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: URL | RequestInfo, init?: RequestInit) => {
      requestSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        const rejectWithAbortReason = () => reject(requestSignal?.reason);
        if (requestSignal?.aborted) {
          rejectWithAbortReason();
        } else {
          requestSignal?.addEventListener("abort", rejectWithAbortReason, { once: true });
        }
      });
    }),
  );
  const api = createCloudflareAccountApi({
    accountId: "account-1",
    apiToken: "cf-token",
    requestTimeoutMs: 5,
  });

  await expect(api("/queues")).rejects.toMatchObject({ name: "TimeoutError" });
  expect(requestSignal?.aborted).toBe(true);
});
