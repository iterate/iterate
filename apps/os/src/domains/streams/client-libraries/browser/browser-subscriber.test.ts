import { describe, expect, it } from "vitest";
import {
  browserStreamSubscriberDescriptor,
  browserStreamSubscriberUserUpdate,
} from "./browser-subscriber.ts";

describe("browserStreamSubscriberDescriptor", () => {
  it("announces the authenticated user's name and email", () => {
    const announcement = { slug: "browser-feed" };

    expect(
      browserStreamSubscriberDescriptor({
        announcement,
        user: { email: "jonas@example.com", name: "Jonas Temple" },
      }),
    ).toEqual({
      description: "browser",
      processor: { announcement },
      user: { email: "jonas@example.com", name: "Jonas Temple" },
    });
  });

  it("keeps non-user browser subscribers anonymous", () => {
    const announcement = { slug: "browser-feed" };

    expect(browserStreamSubscriberDescriptor({ announcement })).toEqual({
      description: "browser",
      processor: { announcement },
    });
  });
});

describe("browserStreamSubscriberUserUpdate", () => {
  const user = { email: "jonas@example.com", name: "Jonas Temple" };

  it("uses a new identity without reconnecting an unstarted runtime", () => {
    expect(
      browserStreamSubscriberUserUpdate({ current: undefined, next: user, started: false }),
    ).toEqual({ user, reconnect: false });
  });

  it("reconnects a live subscription when its identity changes or clears", () => {
    expect(
      browserStreamSubscriberUserUpdate({ current: undefined, next: user, started: true }),
    ).toEqual({ user, reconnect: true });
    expect(
      browserStreamSubscriberUserUpdate({ current: user, next: undefined, started: true }),
    ).toEqual({ user: undefined, reconnect: true });
  });

  it("does not reconnect for an equivalent identity value", () => {
    expect(
      browserStreamSubscriberUserUpdate({
        current: user,
        next: { ...user },
        started: true,
      }),
    ).toEqual({ user: { ...user }, reconnect: false });
  });
});
