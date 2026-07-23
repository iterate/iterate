import { describe, expect, it } from "vitest";
import {
  buildRedriveEvents,
  selectStrugglingSubscriptions,
} from "./project-worker-health-logic.ts";

const healthy = {
  acknowledgedOffset: 40,
  lag: 0,
  attempt: 0,
  nextAttemptAt: null,
  lastError: null,
};

const sourceOwnedConfiguration = {
  configuration: { receiver: { action: "itx-call" } },
};

describe("selectStrugglingSubscriptions", () => {
  it("surfaces halted subscriptions from durable reduced state", () => {
    const struggling = selectStrugglingSubscriptions({
      configured: {
        "root#project": {
          ...sourceOwnedConfiguration,
          deliveryHalted: {
            afterOffset: 300,
            attempts: 15,
            error: "userspace processor threw on offset 300",
          },
        },
        "root#healthy": sourceOwnedConfiguration,
      },
      runtime: {
        "root#project": {
          acknowledgedOffset: 300,
          lag: 12,
          attempt: 0,
          nextAttemptAt: null,
          lastError: null,
        },
        "root#healthy": healthy,
      },
    });
    expect(struggling).toEqual([
      {
        subscriptionKey: "root#project",
        status: "halted",
        acknowledgedOffset: 300,
        haltedAfterOffset: 300,
        lag: 12,
        attempt: 15,
        lastError: "userspace processor threw on offset 300",
        canSetCursor: true,
      },
    ]);
  });

  it("surfaces subscriptions failing in backoff before they halt", () => {
    const struggling = selectStrugglingSubscriptions({
      configured: { "root#project": sourceOwnedConfiguration },
      runtime: {
        "root#project": {
          acknowledgedOffset: 118,
          lag: 4,
          attempt: 3,
          nextAttemptAt: 1_000,
          lastError: "receiver unavailable",
        },
      },
    });
    expect(struggling).toEqual([
      {
        subscriptionKey: "root#project",
        status: "backoff",
        acknowledgedOffset: 118,
        haltedAfterOffset: null,
        lag: 4,
        attempt: 3,
        lastError: "receiver unavailable",
        canSetCursor: true,
      },
    ]);
  });

  it("is empty when everything is healthy or the runtime has not loaded", () => {
    expect(
      selectStrugglingSubscriptions({
        configured: { "root#project": sourceOwnedConfiguration },
        runtime: { "root#project": healthy },
      }),
    ).toEqual([]);
    expect(selectStrugglingSubscriptions({ configured: undefined, runtime: undefined })).toEqual(
      [],
    );
  });
});

describe("buildRedriveEvents", () => {
  const halted = {
    subscriptionKey: "root#project",
    status: "halted" as const,
    acknowledgedOffset: 300,
    haltedAfterOffset: 300,
    lag: 12,
    attempt: 15,
    lastError: null,
    canSetCursor: true,
  };

  it("resume clears the halt at the stopped cursor", () => {
    expect(buildRedriveEvents("resume", halted)).toEqual([
      {
        type: "events.iterate.com/stream/subscription-delivery-resumed",
        payload: { subscriptionKey: "root#project" },
      },
    ]);
  });

  it("skip seeks to acknowledgedOffset + 1 — past the stuck event", () => {
    expect(buildRedriveEvents("skip", halted)).toEqual([
      {
        type: "events.iterate.com/stream/subscription-cursor-set",
        payload: { subscriptionKey: "root#project", afterOffset: 301 },
      },
      {
        type: "events.iterate.com/stream/subscription-delivery-resumed",
        payload: { subscriptionKey: "root#project" },
      },
    ]);
  });

  it("skip on a backing-off subscription seeks past its stuck event too", () => {
    expect(
      buildRedriveEvents("skip", {
        subscriptionKey: "root#project",
        status: "backoff",
        acknowledgedOffset: 118,
        haltedAfterOffset: null,
        lag: 4,
        attempt: 3,
        lastError: null,
        canSetCursor: true,
      }),
    ).toEqual([
      {
        type: "events.iterate.com/stream/subscription-cursor-set",
        payload: { subscriptionKey: "root#project", afterOffset: 119 },
      },
      {
        type: "events.iterate.com/stream/subscription-delivery-resumed",
        payload: { subscriptionKey: "root#project" },
      },
    ]);
  });

  it("does not construct a cursor move for a receiver-owned hosted checkpoint", () => {
    expect(() =>
      buildRedriveEvents("skip", {
        ...halted,
        subscriptionKey: "hosted-agent",
        canSetCursor: false,
      }),
    ).toThrow(/owns its cursor at the receiver/);
  });
});
