import { expect } from "@playwright/test";
import { ingressRequest, startOnDemandProcess, test } from "./test-helpers.ts";

test.describe("orders service", () => {
  test("supports place + find order and emits order stream events", async ({ deployment }) => {
    await startOnDemandProcess(deployment, "orders");

    const healthResponse = await ingressRequest(deployment, {
      host: "orders.iterate.localhost",
      path: "/healthz",
    });
    expect(healthResponse.status).toBe(200);
    expect((await healthResponse.text()).trim()).toBe("ok");

    const placeResponse = await ingressRequest(deployment, {
      host: "orders.iterate.localhost",
      path: "/api/orders",
      json: {
        sku: "sku-123",
        quantity: 2,
      },
    });
    expect(placeResponse.status).toBe(200);

    const placed = (await placeResponse.json()) as {
      id: string;
      eventId: string;
      sku: string;
      quantity: number;
      status: string;
    };
    expect(placed.id.length).toBeGreaterThan(0);
    expect(placed.eventId.length).toBeGreaterThan(0);
    expect(placed.sku).toBe("sku-123");
    expect(placed.quantity).toBe(2);
    expect(placed.status).toBe("accepted");

    const findResponse = await ingressRequest(deployment, {
      host: "orders.iterate.localhost",
      path: `/api/orders/${placed.id}`,
    });
    expect(findResponse.status).toBe(200);

    const found = (await findResponse.json()) as { id: string; eventId: string };
    expect(found.id).toBe(placed.id);
    expect(found.eventId).toBe(placed.eventId);

    const streamResponse = await ingressRequest(deployment, {
      host: "events.iterate.localhost",
      path: "/api/streams/orders",
    });
    expect(streamResponse.status).toBe(200);

    const streamText = await streamResponse.text();
    expect(streamText).toContain("https://events.iterate.com/orders/order-placed");
    expect(streamText).toContain(placed.id);
    expect(streamText).toContain(placed.eventId);
  });
});
