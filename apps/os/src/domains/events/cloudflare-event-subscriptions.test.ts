import { expect, test, vi } from "vitest";
import { createCloudflareAccountApi } from "./cloudflare-event-subscriptions.ts";

test("retries a transient Cloudflare API read without hiding the failed attempt", async () => {
  vi.useFakeTimers();
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      Response.json(
        { success: false, errors: [{ code: 15000, message: "Unknown Internal Error" }] },
        { status: 500 },
      ),
    )
    .mockResolvedValueOnce(Response.json({ success: true, result: [{ id: "subscription-1" }] }));
  vi.stubGlobal("fetch", fetch);
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

  try {
    const api = createCloudflareAccountApi({ accountId: "account-1", apiToken: "token-1" });
    const result = expect(
      api<Array<{ id: string }>>("/event_subscriptions/subscriptions"),
    ).resolves.toEqual([{ id: "subscription-1" }]);

    await vi.runAllTimersAsync();
    await result;

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalledWith("Cloudflare API read failed transiently; retrying", {
      attempt: 1,
      method: "GET",
      path: "/event_subscriptions/subscriptions",
      status: 500,
    });
  } finally {
    warning.mockRestore();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});

test("does not replay a failed Cloudflare API mutation", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(
      Response.json(
        { success: false, errors: [{ code: 15000, message: "Unknown Internal Error" }] },
        { status: 500 },
      ),
    );
  vi.stubGlobal("fetch", fetch);

  try {
    const api = createCloudflareAccountApi({ accountId: "account-1", apiToken: "token-1" });

    await expect(api("/event_subscriptions/subscriptions", { method: "POST" })).rejects.toThrow(
      "Cloudflare API POST /event_subscriptions/subscriptions failed (500)",
    );
    expect(fetch).toHaveBeenCalledOnce();
  } finally {
    vi.unstubAllGlobals();
  }
});
