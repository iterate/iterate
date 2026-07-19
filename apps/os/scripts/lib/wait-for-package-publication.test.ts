import { describe, expect, it, vi } from "vitest";
import { waitForPkgPrNewPublication } from "./wait-for-package-publication.ts";

const packageSpec = "https://pkg.pr.new/iterate/iterate/iterate@abc123";

describe("waitForPkgPrNewPublication", () => {
  it("does not probe ordinary package specs", async () => {
    const fetch = vi.fn();

    await waitForPkgPrNewPublication(undefined, { fetch });
    await waitForPkgPrNewPublication("iterate@latest", { fetch });

    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns immediately when the exact package is available", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const sleep = vi.fn();

    await waitForPkgPrNewPublication(packageSpec, { fetch, sleep });

    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(packageSpec, expect.objectContaining({ method: "HEAD" }));
    expect(sleep).not.toHaveBeenCalled();
  });

  it("waits through publication lag before allowing template builds", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const log = vi.fn();
    const sleep = vi.fn().mockResolvedValue(undefined);

    await waitForPkgPrNewPublication(packageSpec, { fetch, log, sleep });

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(log.mock.calls).toEqual([
      ["waiting for pkg.pr.new package publication (HTTP 404)"],
      ["pkg.pr.new package became available after 3 probes"],
    ]);
  });

  it("fails immediately on a deterministic package response", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 403 }));
    const sleep = vi.fn();

    await expect(waitForPkgPrNewPublication(packageSpec, { fetch, sleep })).rejects.toThrow(
      "pkg.pr.new package probe failed permanently: HTTP 403",
    );
    expect(sleep).not.toHaveBeenCalled();
  });

  it("bounds publication waiting and reports the last outcome", async () => {
    let currentTime = 0;
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    const sleep = vi.fn(async (milliseconds: number) => {
      currentTime += milliseconds;
    });

    await expect(
      waitForPkgPrNewPublication(packageSpec, {
        fetch,
        now: () => currentTime,
        pollIntervalMs: 5,
        sleep,
        timeoutMs: 5,
      }),
    ).rejects.toThrow("pkg.pr.new package was not published within 0s (HTTP 404)");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
  });
});
