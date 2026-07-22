import { describe, expect, it } from "vitest";
import {
  buildRedriveEvents,
  selectStrugglingSubscriptions,
} from "./project-worker-health-logic.ts";

const healthy = {
  ackedOffset: 40,
  parkedAtOffset: null,
  lag: 0,
  attempt: 0,
  nextAttemptAt: null,
  lastError: null,
};

describe("selectStrugglingSubscriptions", () => {
  it("surfaces parked subscriptions", () => {
    const struggling = selectStrugglingSubscriptions({
      "root#project": {
        ackedOffset: 300,
        parkedAtOffset: 300,
        lag: 12,
        attempt: 15,
        nextAttemptAt: null,
        lastError: "userspace processor threw on offset 300",
      },
      "root#healthy": healthy,
    });
    expect(struggling).toEqual([
      {
        subscriptionKey: "root#project",
        status: "parked",
        ackedOffset: 300,
        parkedAtOffset: 300,
        lag: 12,
        attempt: 15,
        lastError: "userspace processor threw on offset 300",
      },
    ]);
  });

  it("surfaces subscriptions failing in backoff before they park", () => {
    const struggling = selectStrugglingSubscriptions({
      "root#project": {
        ackedOffset: 118,
        parkedAtOffset: null,
        lag: 4,
        attempt: 3,
        nextAttemptAt: 1_000,
        lastError: "receiver unavailable",
      },
    });
    expect(struggling).toEqual([
      {
        subscriptionKey: "root#project",
        status: "backoff",
        ackedOffset: 118,
        parkedAtOffset: null,
        lag: 4,
        attempt: 3,
        lastError: "receiver unavailable",
      },
    ]);
  });

  it("is empty when everything is healthy or the runtime has not loaded", () => {
    expect(selectStrugglingSubscriptions({ "root#project": healthy })).toEqual([]);
    expect(selectStrugglingSubscriptions(undefined)).toEqual([]);
  });
});

describe("buildRedriveEvents", () => {
  const parked = {
    subscriptionKey: "root#project",
    status: "parked" as const,
    ackedOffset: 300,
    parkedAtOffset: 300,
    lag: 12,
    attempt: 15,
    lastError: null,
  };

  it("resume just un-parks at the stopped cursor", () => {
    expect(buildRedriveEvents("resume", parked)).toEqual([
      {
        type: "events.iterate.com/stream/subscription-resumed",
        payload: { subscriptionKey: "root#project" },
      },
    ]);
  });

  it("skip seeks to ackedOffset + 1 — past the stuck event, not a no-op resume", () => {
    // ackedOffset is the last DELIVERED offset; the stuck event is the next one.
    // Seeking to ackedOffset would be a no-op (delivery already reads past it).
    expect(buildRedriveEvents("skip", parked)).toEqual([
      {
        type: "events.iterate.com/stream/subscription-cursor-set",
        payload: { subscriptionKey: "root#project", afterOffset: 301 },
      },
      {
        type: "events.iterate.com/stream/subscription-resumed",
        payload: { subscriptionKey: "root#project" },
      },
    ]);
  });

  it("skip on a backoff subscription seeks past its stuck event too", () => {
    expect(
      buildRedriveEvents("skip", {
        subscriptionKey: "root#project",
        status: "backoff",
        ackedOffset: 118,
        parkedAtOffset: null,
        lag: 4,
        attempt: 3,
        lastError: null,
      }),
    ).toEqual([
      {
        type: "events.iterate.com/stream/subscription-cursor-set",
        payload: { subscriptionKey: "root#project", afterOffset: 119 },
      },
      {
        type: "events.iterate.com/stream/subscription-resumed",
        payload: { subscriptionKey: "root#project" },
      },
    ]);
  });
});
