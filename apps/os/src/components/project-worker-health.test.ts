import { describe, expect, it } from "vitest";
import { buildRedriveEvents, selectParkedSubscriptions } from "./project-worker-health-logic.ts";

describe("selectParkedSubscriptions", () => {
  it("keeps only subscriptions whose delivery parked", () => {
    const parked = selectParkedSubscriptions({
      "root#project": {
        parkedAtOffset: 300,
        lag: 12,
        attempt: 15,
        lastError: "userspace processor threw on offset 300",
      },
      "root#healthy": { parkedAtOffset: null, lag: 0, attempt: 0, lastError: null },
    });
    expect(parked).toEqual([
      {
        subscriptionKey: "root#project",
        parkedAtOffset: 300,
        lag: 12,
        attempt: 15,
        lastError: "userspace processor threw on offset 300",
      },
    ]);
  });

  it("is empty when nothing is parked or the runtime has not loaded", () => {
    expect(
      selectParkedSubscriptions({
        "root#project": { parkedAtOffset: null, lag: 0, attempt: 3, lastError: null },
      }),
    ).toEqual([]);
    expect(selectParkedSubscriptions(undefined)).toEqual([]);
  });
});

describe("buildRedriveEvents", () => {
  const subscription = {
    subscriptionKey: "root#project",
    parkedAtOffset: 300,
    lag: 12,
    attempt: 15,
    lastError: null,
  };

  it("resume just un-parks at the stopped cursor", () => {
    expect(buildRedriveEvents("resume", subscription)).toEqual([
      {
        type: "events.iterate.com/stream/subscription-resumed",
        payload: { subscriptionKey: "root#project" },
      },
    ]);
  });

  it("skip seeks past the stuck offset (exclusive) before resuming", () => {
    expect(buildRedriveEvents("skip", subscription)).toEqual([
      {
        type: "events.iterate.com/stream/subscription-cursor-set",
        payload: { subscriptionKey: "root#project", afterOffset: 300 },
      },
      {
        type: "events.iterate.com/stream/subscription-resumed",
        payload: { subscriptionKey: "root#project" },
      },
    ]);
  });

  it("skip with no known offset falls back to a plain resume", () => {
    expect(buildRedriveEvents("skip", { ...subscription, parkedAtOffset: null })).toEqual([
      {
        type: "events.iterate.com/stream/subscription-resumed",
        payload: { subscriptionKey: "root#project" },
      },
    ]);
  });
});
