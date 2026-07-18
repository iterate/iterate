import { describe, expect, it, vi } from "vitest";
import { waitForPublishedPackage } from "./seed-template-worker-artifact.ts";

describe("waitForPublishedPackage", () => {
  it("waits for the immutable package URL to become readable", async () => {
    let now = 0;
    const log = vi.fn();
    const fetchPackage = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await waitForPublishedPackage({
      packageSpec: "https://pkg.pr.new/iterate/iterate/iterate@head",
      fetch: fetchPackage,
      log,
      now: () => now,
      pollIntervalMs: 1_000,
      sleep: async (ms) => {
        now += ms;
      },
      timeoutMs: 5_000,
    });

    expect(fetchPackage).toHaveBeenCalledTimes(2);
    expect(log.mock.calls.flat().join("\n")).toMatch(/not published yet.*HTTP 404/);
    expect(log.mock.calls.flat().join("\n")).toMatch(/available after 1\.0s \(2 attempts\)/);
  });

  it("fails immediately for a permanent response", async () => {
    const fetchPackage = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 403 }));
    const sleep = vi.fn(async () => {});

    await expect(
      waitForPublishedPackage({
        packageSpec: "https://pkg.pr.new/iterate/iterate/iterate@head",
        fetch: fetchPackage,
        sleep,
      }),
    ).rejects.toThrow(/readiness check failed.*HTTP 403/);
    expect(fetchPackage).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("bounds publication waiting and reports the last outcome", async () => {
    let now = 0;
    const fetchPackage = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 404 }));

    await expect(
      waitForPublishedPackage({
        packageSpec: "https://pkg.pr.new/iterate/iterate/iterate@head",
        fetch: fetchPackage,
        now: () => now,
        pollIntervalMs: 1_000,
        sleep: async (ms) => {
          now += ms;
        },
        timeoutMs: 1_500,
      }),
    ).rejects.toThrow(/not published within 1500ms \(HTTP 404\)/);
    expect(fetchPackage).toHaveBeenCalledTimes(2);
  });
});
