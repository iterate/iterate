import { describe, expect, it, vi } from "vitest";
import type { StreamEvent } from "./schemas.ts";
import { type StreamEventWaitLeaseInput, waitForStreamEvent } from "./wait-for-event.ts";

function event(offset: number, type = "events.iterate.test/match"): StreamEvent {
  return {
    createdAt: new Date(offset * 1_000).toISOString(),
    offset,
    path: "/tests/wait",
    payload: { offset },
    type,
  };
}

describe("waitForStreamEvent", () => {
  it("carries the scanned cursor into a new lease after an incarnation goes idle", async () => {
    let now = 0;
    const calls: StreamEventWaitLeaseInput[] = [];
    const lease = vi.fn(async (args: StreamEventWaitLeaseInput) => {
      calls.push(args);
      if (calls.length === 1) {
        now += args.timeoutMs;
        return { events: [], scannedThroughOffset: 16 };
      }
      now += 10;
      return { events: [event(153)], scannedThroughOffset: 153 };
    });

    await expect(
      waitForStreamEvent({
        args: { eventTypes: ["events.iterate.test/match"], timeoutMs: 90_000 },
        lease,
        leaseMs: 4_000,
        now: () => now,
      }),
    ).resolves.toMatchObject({ offset: 153 });

    expect(calls).toEqual([
      {
        afterOffset: undefined,
        eventTypes: ["events.iterate.test/match"],
        replayEphemeralAfterOffset: false,
        timeoutMs: 4_000,
      },
      {
        afterOffset: 16,
        eventTypes: ["events.iterate.test/match"],
        replayEphemeralAfterOffset: true,
        timeoutMs: 4_000,
      },
    ]);
  });

  it("evaluates each predicate candidate once and advances past rejected events", async () => {
    const predicate = vi.fn((candidate: StreamEvent) => candidate.offset === 23);
    const calls: StreamEventWaitLeaseInput[] = [];
    const lease = vi.fn(async (args: StreamEventWaitLeaseInput) => {
      calls.push(args);
      return calls.length === 1
        ? { events: [event(21), event(22)], scannedThroughOffset: 22 }
        : { events: [event(23)], scannedThroughOffset: 23 };
    });

    await expect(
      waitForStreamEvent({
        args: { predicate, timeoutMs: 10_000 },
        lease,
        now: () => 0,
      }),
    ).resolves.toMatchObject({ offset: 23 });

    expect(predicate.mock.calls.map(([candidate]) => candidate.offset)).toEqual([21, 22, 23]);
    expect(calls[1]?.afterOffset).toBe(22);
  });

  it("keeps one overall timeout and reports predicate candidates across leases", async () => {
    let now = 0;
    const lease = vi.fn(async (args: StreamEventWaitLeaseInput) => {
      now += args.timeoutMs;
      return {
        events: now === 4_000 ? [event(3, "events.iterate.test/rejected")] : [],
        scannedThroughOffset: now === 4_000 ? 3 : 4,
      };
    });

    await expect(
      waitForStreamEvent({
        args: { predicate: () => false, timeoutMs: 5_000 },
        lease,
        leaseMs: 4_000,
        now: () => now,
      }),
    ).rejects.toThrow(
      "Timed out waiting for stream event after 5000ms (saw 1 events; recent types: events.iterate.test/rejected).",
    );
    expect(lease).toHaveBeenCalledTimes(2);
    expect(lease.mock.calls[1]?.[0].timeoutMs).toBe(1_000);
  });

  it("reopens after a lifecycle rejection and bounds a reset storm", async () => {
    const reset = () => Object.assign(new Error("restarted"), { durableObjectReset: true });
    let calls = 0;
    await expect(
      waitForStreamEvent({
        args: { eventTypes: ["events.iterate.test/match"], timeoutMs: 10_000 },
        lease: async () => {
          calls += 1;
          if (calls < 3) throw reset();
          return { events: [event(8)], scannedThroughOffset: 8 };
        },
        now: () => 0,
      }),
    ).resolves.toMatchObject({ offset: 8 });
    expect(calls).toBe(3);

    await expect(
      waitForStreamEvent({
        args: { eventTypes: ["events.iterate.test/match"], timeoutMs: 10_000 },
        lease: async () => {
          throw reset();
        },
        now: () => 0,
      }),
    ).rejects.toThrow("stream-unavailable: restarted");
  });
});
