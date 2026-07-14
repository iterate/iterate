import { describe, expect, it } from "vitest";

import type { StreamEvent } from "../../src/domains/streams/schemas.ts";
import {
  emailRecoveryEvents,
  foldActiveIntegrationClaims,
  integrationDirectoryRecoveryEvents,
  projectBackboneEvents,
} from "./index.ts";

function event(
  offset: number,
  type: string,
  payload: Record<string, unknown>,
  path = "/",
): StreamEvent {
  return {
    createdAt: new Date(offset).toISOString(),
    offset,
    path,
    payload,
    type,
  };
}

describe("projectBackboneEvents", () => {
  it("retains current delivery lanes and durable security policy, then replays bootstrap", () => {
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
      event(8, "events.iterate.com/stream/subscription-configured", {
        subscriptionKey: "project-worker",
        delivery: { mode: "push", expression: ["processEventBatchV2"] },
      }),
      event(9, "events.iterate.com/stream/subscription-configured", {
        subscriptionKey: "replacement-project-processor-key",
        delivery: {
          mode: "wake",
          expression: ["processor", "wakeStreamSubscriber"],
          processorSlug: "project",
        },
      }),
      event(10, "events.iterate.com/project/human-approval-key-added", {
        keyId: "key-1",
        publicKey: "public",
      }),
      event(11, "events.iterate.com/project/human-approval-key-revoked", { keyId: "key-1" }),
    ]);

    expect(filtered.map(({ offset }) => offset)).toEqual([1, 5, 7, 8, 9, 10, 11]);
    expect(filtered.find(({ offset }) => offset === 5)?.payload).toEqual({
      projectId: "prj_iterate",
      slug: "iterate",
    });
  });
});

describe("emailRecoveryEvents", () => {
  it("keeps routing mechanics and sender policy but discards messages", () => {
    const path = "/integrations/email";
    const filtered = emailRecoveryEvents([
      event(1, "events.iterate.com/stream/created", { path, projectId: "prj_iterate" }, path),
      event(2, "events.iterate.com/stream/subscription-configured", {}, path),
      event(3, "events.iterate.com/email/sender-allowed", { pattern: "me@example.com" }, path),
      event(4, "events.iterate.com/email/received", { subject: "private" }, path),
      event(5, "events.iterate.com/email/thread-routed", { threadId: "private" }, path),
    ]);

    expect(filtered.map(({ offset }) => offset)).toEqual([1, 2, 3]);
  });
});

describe("integration directory recovery", () => {
  const path = "/integrations/_directory";
  const claim = (offset: number, projectId: string, connection: string, externalId = "T1") =>
    event(
      offset,
      "events.iterate.com/integration/connection-claimed",
      { connection, externalId, projectId, slug: "slack" },
      path,
    );

  it("does not turn a rejected selected-project claim into webhook ownership", () => {
    const events = [
      event(1, "events.iterate.com/stream/created", { path, projectId: null }, path),
      claim(2, "prj_other", "other"),
      claim(3, "prj_iterate", "iterate"),
    ];

    expect(foldActiveIntegrationClaims(events)).toEqual([
      { connection: "other", externalId: "T1", projectId: "prj_other", slug: "slack" },
    ]);
    expect(
      integrationDirectoryRecoveryEvents(events, new Set(["prj_iterate"])).map(
        ({ offset }) => offset,
      ),
    ).toEqual([1]);
  });

  it("retains only the latest fact for each selected active route", () => {
    const events = [
      event(1, "events.iterate.com/stream/created", { path, projectId: null }, path),
      claim(2, "prj_iterate", "old"),
      claim(3, "prj_iterate", "current"),
      claim(4, "prj_other", "other", "T2"),
    ];
    const recovery = integrationDirectoryRecoveryEvents(events, new Set(["prj_iterate"]));

    expect(recovery.map(({ offset }) => offset)).toEqual([1, 3]);
    expect(foldActiveIntegrationClaims(recovery)).toEqual([
      { connection: "current", externalId: "T1", projectId: "prj_iterate", slug: "slack" },
    ]);
  });
});
