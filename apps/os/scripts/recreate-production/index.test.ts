import { describe, expect, it } from "vitest";

import type { StreamEvent } from "../../src/domains/streams/schemas.ts";
import { projectBackboneEvents } from "./index.ts";

function event(offset: number, type: string, payload: Record<string, unknown>): StreamEvent {
  return {
    createdAt: new Date(offset).toISOString(),
    offset,
    path: "/",
    payload,
    type,
  };
}

describe("projectBackboneEvents", () => {
  it("retains both delivery lanes and replays bootstrap instead of old readiness", () => {
    const filtered = projectBackboneEvents([
      event(1, "events.iterate.com/stream/created", { path: "/", projectId: "prj_iterate" }),
      event(2, "events.iterate.com/stream/subscription-configured", {
        subscriptionKey: "project-worker",
        delivery: { mode: "push", expression: ["processEventBatch"] },
      }),
      event(3, "events.iterate.com/stream/woken", { incarnationId: "old" }),
      event(4, "events.iterate.com/stream/subscription-configured", {
        subscriptionKey: "opaque-project-processor-key",
        delivery: {
          mode: "wake",
          expression: ["processor", "wakeStreamSubscriber"],
          processorSlug: "project",
        },
      }),
      event(5, "events.iterate.com/project/create-requested", {
        creatorEmail: "must-not-enter-package@example.com",
        onboardingActive: true,
        projectId: "prj_iterate",
        slug: "iterate",
      }),
      event(6, "events.iterate.com/project/created", {
        projectId: "prj_iterate",
        slug: "iterate",
      }),
      event(7, "events.iterate.com/project/egress-rules-configured", { rules: [] }),
    ]);

    expect(filtered.map(({ offset }) => offset)).toEqual([1, 2, 4, 5]);
    expect(filtered.at(-1)?.payload).toEqual({ projectId: "prj_iterate", slug: "iterate" });
  });
});
