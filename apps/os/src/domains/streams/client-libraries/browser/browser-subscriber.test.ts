import { describe, expect, it } from "vitest";
import { browserStreamSubscriberDescriptor } from "./browser-subscriber.ts";

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
