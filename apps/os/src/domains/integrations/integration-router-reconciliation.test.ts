import { afterEach, describe, expect, test, vi } from "vitest";
import { integrationConnectionStreamPath } from "./utils.ts";

const network = vi.hoisted(() => {
  type StoredEvent = {
    idempotencyKey?: string;
    offset: number;
    payload?: Record<string, unknown>;
    type: string;
  };
  const streams = new Map<string, StoredEvent[]>();
  const appendBatches: Array<{ inputs: Omit<StoredEvent, "offset">[]; name: string }> = [];
  return {
    STREAM: {
      getByName(name: string) {
        const stored = streams.get(name) ?? [];
        streams.set(name, stored);
        return {
          append(...inputs: Omit<StoredEvent, "offset">[]) {
            appendBatches.push({ inputs, name });
            return inputs.map((input) => {
              const existing = input.idempotencyKey
                ? stored.find((event) => event.idempotencyKey === input.idempotencyKey)
                : undefined;
              if (existing) return existing;
              const event = { ...input, offset: stored.length + 1 };
              stored.push(event);
              return event;
            });
          },
          getEvents(input: { afterOffset?: number; eventTypes?: string[]; limit?: number } = {}) {
            const { afterOffset = 0, eventTypes, limit = 500 } = input;
            return stored
              .filter(
                (event) =>
                  event.offset > afterOffset &&
                  (eventTypes === undefined || eventTypes.includes(event.type)),
              )
              .slice(0, limit);
          },
        };
      },
    },
    reset() {
      streams.clear();
      appendBatches.length = 0;
    },
    appendBatches,
    streams,
  };
});

vi.mock("../../env.ts", () => ({ itxEnv: { STREAM: network.STREAM } }));

const {
  appendConnectionDirectoryEvent,
  buildIntegrationRouterCreatedEvent,
  buildIntegrationRouterSubscriptionConfiguredEvent,
  integrationStreamStub,
  routeIntegrationWebhook,
} = await import("./integration-streams.ts");

const PROJECT_ID = "prj_test";
const CONNECTION = "acme";

describe("explicit webhook router creation", () => {
  afterEach(() => network.reset());

  test("ingress appends only the webhook and never creates or subscribes the router", async () => {
    await appendConnectionDirectoryEvent({
      claimed: true,
      connection: CONNECTION,
      externalId: "T1",
      projectId: PROJECT_ID,
      slug: "slack",
    });
    const path = integrationConnectionStreamPath("slack", CONNECTION);
    await integrationStreamStub(PROJECT_ID, path).append(
      buildIntegrationRouterCreatedEvent({ connection: CONNECTION, slug: "slack" }),
      buildIntegrationRouterSubscriptionConfiguredEvent({
        connection: CONNECTION,
        processorSlug: "slack",
        projectId: PROJECT_ID,
        slug: "slack",
      }),
    );
    network.appendBatches.length = 0;

    await routeIntegrationWebhook({
      event: {
        idempotencyKey: "slack-webhook:one",
        payload: { body: { event_id: "one" } },
        type: "events.iterate.com/slack/webhook-received",
      },
      externalId: "T1",
      routerCreatedEventType: "events.iterate.com/slack/created",
      slug: "slack",
    });

    expect(network.appendBatches).toHaveLength(1);
    expect(network.appendBatches[0]?.inputs).toEqual([
      expect.objectContaining({
        idempotencyKey: "slack-webhook:one",
        type: "events.iterate.com/slack/webhook-received",
        payload: {
          body: { event_id: "one" },
          connection: CONNECTION,
        },
      }),
    ]);
  });

  test("ingress rejects a claimed router whose birth certificate is missing", async () => {
    await appendConnectionDirectoryEvent({
      claimed: true,
      connection: CONNECTION,
      externalId: "T1",
      projectId: PROJECT_ID,
      slug: "slack",
    });
    const path = integrationConnectionStreamPath("slack", CONNECTION);
    await integrationStreamStub(PROJECT_ID, path).append(
      buildIntegrationRouterSubscriptionConfiguredEvent({
        connection: CONNECTION,
        processorSlug: "slack",
        projectId: PROJECT_ID,
        slug: "slack",
      }),
    );
    network.appendBatches.length = 0;

    await expect(
      routeIntegrationWebhook({
        event: {
          idempotencyKey: "slack-webhook:one",
          payload: { body: { event_id: "one" } },
          type: "events.iterate.com/slack/webhook-received",
        },
        externalId: "T1",
        routerCreatedEventType: "events.iterate.com/slack/created",
        slug: "slack",
      }),
    ).rejects.toThrow("slack router acme for project prj_test has not been created");

    expect(network.appendBatches).toHaveLength(0);
  });
});
