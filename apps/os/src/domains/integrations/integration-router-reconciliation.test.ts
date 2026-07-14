import { afterEach, describe, expect, test, vi } from "vitest";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
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
        const append = (...inputs: Omit<StoredEvent, "offset">[]) => {
          appendBatches.push({ inputs, name });
          inputs.map((input) => {
            const existing = input.idempotencyKey
              ? stored.find((event) => event.idempotencyKey === input.idempotencyKey)
              : undefined;
            if (existing) return existing;
            const event = { ...input, offset: stored.length + 1 };
            stored.push(event);
            return event;
          });
          return undefined;
        };
        return {
          append,
          appendAck: append,
          getEvents(input: { afterOffset?: number; limit?: number } = {}) {
            const { afterOffset = 0, limit = 500 } = input;
            return stored.filter((event) => event.offset > afterOffset).slice(0, limit);
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

const { appendConnectionDirectoryEvent, integrationStreamStub, routeIntegrationWebhook } =
  await import("./integration-streams.ts");

const PROJECT_ID = "prj_test";
const CONNECTION = "acme";
const SUBSCRIPTION_KEY = `${DurableObjectNameCodec.stringify({
  projectId: PROJECT_ID,
  path: integrationConnectionStreamPath("slack", CONNECTION),
})}#slack`;

describe("webhook router subscription reconciliation", () => {
  afterEach(() => network.reset());

  test("a webhook replaces a stale property-walk subscription before routing, once", async () => {
    await appendConnectionDirectoryEvent({
      claimed: true,
      connection: CONNECTION,
      externalId: "T1",
      projectId: PROJECT_ID,
      slug: "slack",
    });
    await integrationStreamStub(
      PROJECT_ID,
      integrationConnectionStreamPath("slack", CONNECTION),
    ).append({
      idempotencyKey: `slack-router-subscription:${PROJECT_ID}:${CONNECTION}`,
      payload: {
        subscriptionKey: SUBSCRIPTION_KEY,
        delivery: {
          mode: "wake",
          expression: ["integrations", "slack", CONNECTION, "processor", "wakeStreamSubscriber"],
          processorSlug: "slack",
        },
      },
      type: "events.iterate.com/stream/subscription-configured",
    });

    await routeIntegrationWebhook({
      event: {
        idempotencyKey: "slack-webhook:one",
        payload: { body: { event_id: "one" } },
        type: "events.iterate.com/slack/webhook-received",
      },
      externalId: "T1",
      routerProcessorSlug: "slack",
      slug: "slack",
    });
    await routeIntegrationWebhook({
      event: {
        idempotencyKey: "slack-webhook:two",
        payload: { body: { event_id: "two" } },
        type: "events.iterate.com/slack/webhook-received",
      },
      externalId: "T1",
      routerProcessorSlug: "slack",
      slug: "slack",
    });

    const streamName = DurableObjectNameCodec.stringify({
      projectId: PROJECT_ID,
      path: integrationConnectionStreamPath("slack", CONNECTION),
    });
    const events = network.streams.get(streamName)!;
    const firstWebhookBatch = network.appendBatches.find(({ inputs }) =>
      inputs.some((event) => event.idempotencyKey === "slack-webhook:one"),
    );
    expect(firstWebhookBatch?.inputs.map((event) => event.type)).toEqual([
      "events.iterate.com/stream/subscription-configured",
      "events.iterate.com/slack/webhook-received",
    ]);
    const configurations = events.filter(
      (event) => event.type === "events.iterate.com/stream/subscription-configured",
    );
    expect(configurations).toHaveLength(2);
    expect(configurations[1]).toMatchObject({
      payload: {
        subscriptionKey: SUBSCRIPTION_KEY,
        delivery: {
          mode: "wake",
          expression: [
            "integrations",
            "slack",
            ["get", CONNECTION],
            "processor",
            "wakeStreamSubscriber",
          ],
          processorSlug: "slack",
        },
      },
    });
    expect(events.map((event) => event.idempotencyKey)).toEqual([
      `slack-router-subscription:${PROJECT_ID}:${CONNECTION}`,
      expect.stringContaining("integration-router-subscription:"),
      "slack-webhook:one",
      "slack-webhook:two",
    ]);
  });
});
