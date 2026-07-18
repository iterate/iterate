import { expect, test } from "vitest";
import { MemoryStreamNetwork, driveProcessor } from "iterate/processors/testing";
import { NotificationProcessor } from "./notification-processor-implementation.ts";

test("one held approval becomes one project notification intent", async () => {
  const network = new MemoryStreamNetwork();
  const stream = network.get("/");
  const driver = driveProcessor(
    new NotificationProcessor({ stream, path: "/", projectId: "prj_test" }),
    stream,
  );
  await stream.append(
    {
      type: "events.iterate.com/notification/created",
      payload: { config: {} },
    },
    {
      type: "events.iterate.com/project/human-approval-requested",
      payload: {
        method: "POST",
        url: "https://api.stripe.com/v1/transfers",
        headers: {},
        bodySha256: null,
        bodyPreview: null,
        secretPaths: ["/secrets/stripe/prod"],
        ruleKey: "stripe-mutations",
        expiresAt: "2026-07-19T08:05:00.000Z",
      },
    },
  );

  await driver.deliver();

  expect(network.eventsAt("/")).toContainEqual(
    expect.objectContaining({
      type: "events.iterate.com/stream/subscription-configured",
      payload: expect.objectContaining({
        subscriptionKey: "notification-intent:/integrations/email",
        selector: { eventTypes: ["events.iterate.com/notification/requested"] },
        delivery: {
          mode: "push",
          expression: ["streams", ["get", "/integrations/email"], "acceptCrossPost"],
        },
      }),
    }),
  );
  expect(network.eventsAt("/").at(-1)).toMatchObject({
    type: "events.iterate.com/notification/requested",
    idempotencyKey: "notification/approval-requested@/:2",
    payload: {
      audience: { kind: "project" },
      title: "Approval needed",
      body: "POST api.stripe.com is waiting for approval.",
      destination: { kind: "approvals", approvalRequestEventOffset: 2 },
      expiresAt: Date.parse("2026-07-19T08:05:00.000Z"),
    },
  });
});
