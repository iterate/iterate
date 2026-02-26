/* eslint-disable no-empty-pattern -- Playwright requires object-destructured fixture args. */
import { expect } from "@playwright/test";
import { projectDeployment, runE2E, test } from "./test-helpers.ts";

test.skip(!runE2E, "Set RUN_JONASLAND_E2E=true to run Playwright e2e specs");

test.describe("orders service", () => {
  test("supports place + find order and emits order stream events", async ({ page }) => {
    await using deployment = await projectDeployment();
    await deployment.startOnDemandProcess("orders");
    const ingressUrl = new URL(await deployment.ingressUrl());

    const health = await deployment.orders.service.health({});
    expect(health.ok).toBe(true);

    const placed = (await deployment.orders.orders.place({
      sku: "sku-123",
      quantity: 2,
    })) as {
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

    const found = (await deployment.orders.orders.find({ id: placed.id })) as {
      id: string;
      eventId: string;
    };
    expect(found.id).toBe(placed.id);
    expect(found.eventId).toBe(placed.eventId);

    const streamResponse = await page.request.get(
      `http://events.iterate.localhost:${ingressUrl.port}/api/streams/orders`,
    );
    expect(streamResponse.ok()).toBe(true);

    const streamText = await streamResponse.text();
    expect(streamText).toContain("https://events.iterate.com/orders/order-placed");
    expect(streamText).toContain(placed.id);
    expect(streamText).toContain(placed.eventId);
  });
});
