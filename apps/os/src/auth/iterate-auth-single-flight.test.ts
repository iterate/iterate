import { describe, expect, it, vi } from "vitest";
import { createSingleFlight } from "@iterate-com/auth/server";

// Proves the fix for the ~5-minute logout: the OAuth refresh-token grant rotates
// the refresh token and revokes the whole family if a rotated token is presented
// twice. A normal page load fires several concurrent requests; once the access
// token is near expiry they all tried to refresh with the same cookie token, and
// the losers' "reuse" nuked the session. createSingleFlight collapses concurrent
// refreshes for one token into a single token-endpoint call.

describe("createSingleFlight", () => {
  it("collapses concurrent calls for the same key into one invocation", async () => {
    const singleFlight = createSingleFlight<string>();
    let resolve!: (value: string) => void;
    const fn = vi.fn(() => new Promise<string>((r) => (resolve = r)));

    const a = singleFlight("token-1", fn);
    const b = singleFlight("token-1", fn);
    const c = singleFlight("token-1", fn);

    expect(fn).toHaveBeenCalledTimes(1);
    resolve("rotated");
    await expect(Promise.all([a, b, c])).resolves.toEqual(["rotated", "rotated", "rotated"]);
  });

  it("runs independent keys independently", async () => {
    const singleFlight = createSingleFlight<string>();
    const fn = vi.fn(async (value: string) => value);

    const [one, two] = await Promise.all([
      singleFlight("token-1", () => fn("one")),
      singleFlight("token-2", () => fn("two")),
    ]);

    expect(fn).toHaveBeenCalledTimes(2);
    expect([one, two]).toEqual(["one", "two"]);
  });

  it("clears the entry after settling so a rotated token refreshes again", async () => {
    const singleFlight = createSingleFlight<number>();
    const fn = vi.fn(async () => 1);

    await singleFlight("token-1", fn);
    await singleFlight("token-1", fn);

    // Same key, but the first flight already settled — a real second refresh runs.
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("propagates rejection to all waiters and lets the next call retry", async () => {
    const singleFlight = createSingleFlight<string>();
    const failing = vi.fn(async () => {
      throw new Error("refresh failed");
    });

    const a = singleFlight("token-1", failing);
    const b = singleFlight("token-1", failing);
    await expect(a).rejects.toThrow("refresh failed");
    await expect(b).rejects.toThrow("refresh failed");
    expect(failing).toHaveBeenCalledTimes(1);

    // Failure cleared the entry, so a subsequent attempt is allowed to retry.
    const recovering = vi.fn(async () => "ok");
    await expect(singleFlight("token-1", recovering)).resolves.toBe("ok");
    expect(recovering).toHaveBeenCalledTimes(1);
  });
});
