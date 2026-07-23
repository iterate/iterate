import { describe, expect, test, vi } from "vitest";
import { PointerPresence } from "./pointer-presence.ts";

describe("pointer presence", () => {
  test("announces wake parked waits coalesced; leaving clears; stale entries age out", async () => {
    vi.useFakeTimers();
    try {
      const channel = new PointerPresence();
      const parked = channel.wait(0);
      channel.present("u-ada-abc", { anchor: "card:x", fx: 0.5, fy: 0.5 });
      channel.present("u-ada-abc", { anchor: "card:y", fx: 0.1, fy: 0.9 }); // coalesces
      await vi.advanceTimersByTimeAsync(120);
      const snapshot = await parked;
      expect(snapshot.clients).toEqual([
        {
          at: expect.any(Number),
          clientId: "u-ada-abc",
          payload: { anchor: "card:y", fx: 0.1, fy: 0.9 },
        },
      ]);

      // Caught-up waits park instead of spinning, and leave wakes them empty.
      const caughtUp = channel.wait(snapshot.generation);
      channel.present("u-ada-abc", null);
      await vi.advanceTimersByTimeAsync(120);
      expect((await caughtUp).clients).toEqual([]);

      // A cursor nobody refreshed ages out of the snapshot.
      channel.present("u-bob-def", { anchor: "page", fx: 0, fy: 0 });
      await vi.advanceTimersByTimeAsync(46_000);
      expect(channel.snapshot().clients).toEqual([]);

      // Oversized payloads are dropped quietly.
      channel.present("u-eve-ghi", { blob: "x".repeat(3000) });
      expect(channel.snapshot().clients).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
