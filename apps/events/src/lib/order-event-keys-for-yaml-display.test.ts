import type { Event } from "@iterate-com/events-contract";
import { describe, expect, test } from "vitest";
import { orderEventKeysForYamlDisplay } from "~/lib/order-event-keys-for-yaml-display.ts";

describe("orderEventKeysForYamlDisplay", () => {
  test("omits streamPath and surfaces the core envelope keys first", () => {
    const event: Event = {
      streamPath: "demo/orders",
      type: "demo.order.created",
      payload: { orderId: "ord_123" },
      metadata: { actor: "tester" },
      idempotencyKey: "idem_123",
      offset: 7,
      createdAt: "2026-04-08T12:00:00.000Z",
    };

    const orderedEvent = orderEventKeysForYamlDisplay(event);

    expect(Object.keys(orderedEvent)).toEqual([
      "type",
      "payload",
      "metadata",
      "idempotencyKey",
      "offset",
      "createdAt",
    ]);
    expect(orderedEvent).toEqual({
      type: "demo.order.created",
      payload: { orderId: "ord_123" },
      metadata: { actor: "tester" },
      idempotencyKey: "idem_123",
      offset: 7,
      createdAt: "2026-04-08T12:00:00.000Z",
    });
  });

  test("keeps additional keys after the envelope fields", () => {
    const event: Event & { retryCount: number } = {
      streamPath: "demo/orders",
      type: "demo.order.created",
      payload: { orderId: "ord_123" },
      offset: 8,
      createdAt: "2026-04-08T12:00:01.000Z",
      retryCount: 2,
    };

    const orderedEvent = orderEventKeysForYamlDisplay(event);

    expect(Object.keys(orderedEvent)).toEqual([
      "type",
      "payload",
      "offset",
      "createdAt",
      "retryCount",
    ]);
    expect(orderedEvent.retryCount).toBe(2);
  });
});
