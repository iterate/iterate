import { describe, expect, it, vi } from "vitest";
import { fetchCloudflareWith429Retry } from "./cloudflare-429-retry.ts";

function response(status: number, headers: Record<string, string> = {}) {
  return new Response(null, { status, headers });
}

describe("fetchCloudflareWith429Retry", () => {
  it("returns a non-429 response immediately without sleeping", async () => {
    const sleep = vi.fn(async () => {});
    const doFetch = vi.fn(async () => response(200));

    const result = await fetchCloudflareWith429Retry("GET /d1/database", doFetch, { sleep });

    expect(result.status).toBe(200);
    expect(doFetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does NOT retry non-429 errors — a 500 surfaces to the caller at once", async () => {
    const sleep = vi.fn(async () => {});
    const doFetch = vi.fn(async () => response(500));

    const result = await fetchCloudflareWith429Retry("GET /zones", doFetch, { sleep });

    expect(result.status).toBe(500);
    expect(doFetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries 429s on the fallback schedule until a success", async () => {
    const sleeps: number[] = [];
    const doFetch = vi
      .fn(async () => response(200))
      .mockResolvedValueOnce(response(429))
      .mockResolvedValueOnce(response(429));

    const result = await fetchCloudflareWith429Retry("POST /d1/query", doFetch, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(result.status).toBe(200);
    expect(doFetch).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([5_000, 15_000]);
  });

  it("honors Retry-After (delta-seconds) over the fallback delay, capped", async () => {
    const sleeps: number[] = [];
    const doFetch = vi
      .fn(async () => response(200))
      .mockResolvedValueOnce(response(429, { "retry-after": "9" }))
      .mockResolvedValueOnce(response(429, { "retry-after": "9999" }));

    const result = await fetchCloudflareWith429Retry("GET /workers", doFetch, {
      maxRetryAfterMs: 120_000,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(result.status).toBe(200);
    expect(sleeps).toEqual([9_000, 120_000]);
  });

  it("gives up after the configured attempts, returning the final 429 for the caller's normal error path", async () => {
    const sleep = vi.fn(async () => {});
    const doFetch = vi.fn(async () => response(429));

    const result = await fetchCloudflareWith429Retry("GET /d1/database", doFetch, {
      backoffMs: [1, 1, 1, 1],
      sleep,
    });

    expect(result.status).toBe(429);
    expect(doFetch).toHaveBeenCalledTimes(5);
    expect(sleep).toHaveBeenCalledTimes(4);
  });

  it("propagates thrown fetch errors without retrying", async () => {
    const sleep = vi.fn(async () => {});
    const doFetch = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });

    await expect(
      fetchCloudflareWith429Retry("GET /d1/database", doFetch, { sleep }),
    ).rejects.toThrow("ECONNRESET");
    expect(doFetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
