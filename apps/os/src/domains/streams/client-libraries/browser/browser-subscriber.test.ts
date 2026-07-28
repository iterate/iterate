import { describe, expect, it } from "vitest";
import {
  browserStreamSubscriberDescriptor,
  browserStreamSubscriberUserUpdate,
} from "./browser-subscriber.ts";

describe("browserStreamSubscriberDescriptor", () => {
  it("announces the authenticated user's id, name, email, and picture", () => {
    const announcement = { slug: "browser-feed" };
    const picture = "https://example.com/jonas.png";
    const user = {
      id: "usr_jonas",
      email: "jonas@example.com",
      name: "Jonas Temple",
      picture,
    };

    expect(
      browserStreamSubscriberDescriptor({
        announcement,
        user,
      }),
    ).toEqual({
      description: "browser",
      processor: { announcement },
      user,
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
  const user = {
    id: "usr_jonas",
    email: "jonas@example.com",
    name: "Jonas Temple",
    picture: "https://example.com/jonas.png",
  };

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

  it("reconnects a live subscription when the user's picture changes", () => {
    const next = { ...user, picture: "https://example.com/jonas-updated.png" };

    expect(browserStreamSubscriberUserUpdate({ current: user, next, started: true })).toEqual({
      user: next,
      reconnect: true,
    });
  });

  it("reconnects a live subscription when the user id changes", () => {
    const next = { ...user, id: "usr_other" };

    expect(browserStreamSubscriberUserUpdate({ current: user, next, started: true })).toEqual({
      user: next,
      reconnect: true,
    });
  });
});
