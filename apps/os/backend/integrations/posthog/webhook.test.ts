import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { outboxClient } from "../../outbox/client.ts";
import { posthogProxyApp } from "./proxy.ts";

vi.mock("../../outbox/client.ts", () => ({
  outboxClient: {
    send: vi.fn(),
  },
}));

vi.mock("../../tag-logger.ts", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    set: vi.fn(),
  },
}));

describe("PostHog webhook forwarding", () => {
  const outboxSendMock = vi.mocked(outboxClient.send);

  beforeEach(() => {
    outboxSendMock.mockReset();
    outboxSendMock.mockResolvedValue({
      eventId: "1",
      matchedConsumers: 1,
      delays: ["0s"],
      duplicate: false,
    });
  });

  function createMockDb() {
    return {};
  }

  function createTestApp(mockDb: Record<string, unknown>, secret = "posthog-secret") {
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("db" as never, mockDb as never);
      c.env = {
        POSTHOG_WEBHOOK_SECRET: secret,
      } as never;
      await next();
    });
    app.route("/", posthogProxyApp);
    return app;
  }

  it("rejects webhook with invalid secret", async () => {
    const app = createTestApp(createMockDb());
    const response = await app.request("/api/integrations/posthog/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-iterate-webhook-secret": "bad-secret",
      },
      body: JSON.stringify({ alert: { id: 1 } }),
    });

    expect(response.status).toBe(401);
  });

  it("records the raw webhook in the outbox", async () => {
    const app = createTestApp(createMockDb());

    const response = await app.request("/api/integrations/posthog/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-iterate-webhook-secret": "posthog-secret",
        "x-posthog-delivery-id": "ph-delivery-1",
      },
      body: JSON.stringify({ alert: { id: 123, name: "Error spike" } }),
    });

    expect(response.status).toBe(200);
    expect(outboxSendMock).toHaveBeenCalledWith(expect.any(Object), {
      name: "posthog:webhook-received",
      payload: {
        deliveryId: "ph-delivery-1",
        payload: { alert: { id: 123, name: "Error spike" } },
      },
      deduplicationKey: "ph-delivery-1",
    });
  });
});
