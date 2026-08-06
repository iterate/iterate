import { describe, expect, it } from "vitest";
import {
  buildFacetProcessorSubscriptionConfiguredEvent,
  containsFacetProcessorSubscription,
  resolveStreamPath,
} from "./utils.ts";

describe("stream utilities", () => {
  it("resolves child and sibling paths inside the held stream root", () => {
    expect(resolveStreamPath("/agents/demo", "messages")).toBe("/agents/demo/messages");
    expect(resolveStreamPath("/agents/demo/messages", "../events")).toBe("/agents/demo/events");
    expect(resolveStreamPath("/agents/demo", "/absolute")).toBe("/absolute");
    expect(resolveStreamPath("/agents/demo", ".")).toBe("/agents/demo");
  });

  it("rejects relative paths that escape the stream root", () => {
    expect(() => resolveStreamPath("/", "..")).toThrow(/escapes the stream root/);
  });

  it("detects the batches that must ride the platform append lane", () => {
    const facetSubscription = buildFacetProcessorSubscriptionConfiguredEvent({ name: "secret" });
    expect(containsFacetProcessorSubscription([facetSubscription])).toBe(true);
    expect(
      containsFacetProcessorSubscription([
        { type: "events.iterate.com/secret/created", payload: { config: {} } },
        facetSubscription,
      ]),
    ).toBe(true);
    // Expression-placed wakes, other receivers, and plain product events stay
    // on the public lane.
    expect(
      containsFacetProcessorSubscription([
        {
          type: "events.iterate.com/stream/subscription-configured",
          payload: {
            name: "scheduler",
            receiver: {
              action: "processor-wake",
              expression: ["schedulers", ["get", "/scheduler/x"], "processor"],
            },
          },
        },
        { type: "example.com/issue-created", payload: { issue: 42 } },
      ]),
    ).toBe(false);
    // A COPIED facet configuration is inert product data on the receiver, not
    // a configuration command.
    expect(
      containsFacetProcessorSubscription([
        {
          ...facetSubscription,
          source: {
            copiedFrom: [
              {
                name: "mirror",
                streamId: "11111111-1111-4111-8111-111111111111",
                streamCreatedAt: "2026-01-01T00:00:00.000Z",
                cursorChangedAtSourceOffset: 0,
                createdAt: "2026-01-01T00:00:00.000Z",
                offset: 1,
                path: "/source",
                projectId: null,
                type: "events.iterate.com/stream/subscription-configured",
              },
            ],
          },
        },
      ]),
    ).toBe(false);
  });
});
