import { describe, expect, it } from "vitest";
import {
  buildRedriveEvents,
  selectStrugglingSubscriptions,
} from "./project-worker-health-logic.ts";

const healthy = {
  confirmedOffset: 40,
  lag: 0,
  attempt: 0,
  nextAttemptAt: null,
  lastError: null,
  lastErrorAt: null,
};

const sourceOwnedConfiguration = {
  configuration: { receiver: { action: "itx-call" } },
};

describe("selectStrugglingSubscriptions", () => {
  it("surfaces halted subscriptions from durable reduced state", () => {
    const struggling = selectStrugglingSubscriptions({
      configured: {
        "project-worker": {
          ...sourceOwnedConfiguration,
          deliveryHalted: {
            afterOffset: 300,
            attempts: 15,
            error: "userspace processor threw on offset 300",
          },
        },
        "iterate-platform-posthog": sourceOwnedConfiguration,
      },
      runtime: {
        "project-worker": {
          confirmedOffset: 300,
          lag: 12,
          attempt: 0,
          nextAttemptAt: null,
          lastError: null,
          lastErrorAt: null,
        },
        "iterate-platform-posthog": healthy,
      },
    });
    expect(struggling).toEqual([
      {
        name: "project-worker",
        status: "halted",
        confirmedOffset: 300,
        haltedAfterOffset: 300,
        lag: 12,
        attempt: 15,
        lastError: "userspace processor threw on offset 300",
        lastErrorAt: null,
        canSetCursor: true,
      },
    ]);
  });

  it("surfaces subscriptions failing in backoff before they halt", () => {
    const struggling = selectStrugglingSubscriptions({
      configured: { "project-worker": sourceOwnedConfiguration },
      runtime: {
        "project-worker": {
          confirmedOffset: 118,
          lag: 4,
          attempt: 3,
          nextAttemptAt: 1_000,
          lastError: "receiver unavailable",
          lastErrorAt: null,
        },
      },
    });
    expect(struggling).toEqual([
      {
        name: "project-worker",
        status: "backoff",
        confirmedOffset: 118,
        haltedAfterOffset: null,
        lag: 4,
        attempt: 3,
        lastError: "receiver unavailable",
        lastErrorAt: null,
        canSetCursor: true,
      },
    ]);
  });

  it("ranks a durable halt above the retry row", () => {
    const struggling = selectStrugglingSubscriptions({
      configured: {
        "project-worker": {
          ...sourceOwnedConfiguration,
          deliveryHalted: { afterOffset: 300, attempts: 15 },
        },
      },
      runtime: {
        "project-worker": {
          confirmedOffset: 300,
          lag: 1,
          attempt: 2,
          nextAttemptAt: 1_000,
          lastError: "late",
          lastErrorAt: null,
        },
      },
    });
    expect(struggling.map((subscription) => subscription.status)).toEqual(["halted"]);
  });

  it("is empty when everything is healthy or the runtime has not loaded", () => {
    expect(
      selectStrugglingSubscriptions({
        configured: { "project-worker": sourceOwnedConfiguration },
        runtime: { "project-worker": healthy },
      }),
    ).toEqual([]);
    expect(selectStrugglingSubscriptions({ configured: undefined, runtime: undefined })).toEqual(
      [],
    );
  });
});

describe("buildRedriveEvents", () => {
  const halted = {
    name: "project-worker",
    status: "halted" as const,
    confirmedOffset: 300,
    haltedAfterOffset: 300,
    lag: 12,
    attempt: 15,
    lastError: null,
    lastErrorAt: null,
    canSetCursor: true,
  };

  it("resume clears the halt at the stopped cursor", () => {
    expect(buildRedriveEvents("resume", halted)).toEqual([
      {
        type: "events.iterate.com/stream/subscription-delivery-resumed",
        payload: { name: "project-worker" },
      },
    ]);
  });

  it("skip seeks to confirmedOffset + 1 — past the stuck event", () => {
    expect(buildRedriveEvents("skip", halted)).toEqual([
      {
        type: "events.iterate.com/stream/subscription-cursor-set",
        payload: { name: "project-worker", afterOffset: 301 },
      },
      {
        type: "events.iterate.com/stream/subscription-delivery-resumed",
        payload: { name: "project-worker" },
      },
    ]);
  });

  it("skip on a backing-off subscription seeks past its stuck event too", () => {
    expect(
      buildRedriveEvents("skip", {
        name: "project-worker",
        status: "backoff",
        confirmedOffset: 118,
        haltedAfterOffset: null,
        lag: 4,
        attempt: 3,
        lastError: null,
        lastErrorAt: null,
        canSetCursor: true,
      }),
    ).toEqual([
      {
        type: "events.iterate.com/stream/subscription-cursor-set",
        payload: { name: "project-worker", afterOffset: 119 },
      },
      {
        type: "events.iterate.com/stream/subscription-delivery-resumed",
        payload: { name: "project-worker" },
      },
    ]);
  });

  it("does not construct a cursor move for a receiver-owned hosted checkpoint", () => {
    expect(() =>
      buildRedriveEvents("skip", {
        ...halted,
        name: "agent",
        canSetCursor: false,
      }),
    ).toThrow(/owns its cursor at the receiver/);
  });
});
