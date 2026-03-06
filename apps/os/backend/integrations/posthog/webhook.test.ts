import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { buildMachineFetcher } from "../../services/machine-readiness-probe.ts";
import { posthogProxyApp } from "./proxy.ts";

vi.mock("../../../env.ts", () => ({
  waitUntil: vi.fn((promise: Promise<unknown>) => promise),
}));

vi.mock("../../services/machine-readiness-probe.ts", () => ({
  buildMachineFetcher: vi.fn(),
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
  const buildMachineFetcherMock = vi.mocked(buildMachineFetcher);

  beforeEach(() => {
    buildMachineFetcherMock.mockReset();
  });

  function createMockDb(connection: Record<string, unknown> | null) {
    return {
      query: {
        projectConnection: {
          findFirst: vi.fn().mockResolvedValue(connection),
        },
      },
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
        }),
      }),
    };
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
    const app = createTestApp(createMockDb(null));
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

  it("forwards webhook to active machine for hardcoded slack team", async () => {
    const forwardFetcher = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    buildMachineFetcherMock.mockResolvedValue(forwardFetcher as never);

    const app = createTestApp(
      createMockDb({
        projectId: "prj_iterate",
        project: {
          machines: [{ id: "mach_1", type: "docker", externalId: "ext_1", metadata: {} }],
        },
      }),
    );

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
    expect(forwardFetcher).toHaveBeenCalledTimes(1);
    expect(forwardFetcher).toHaveBeenCalledWith(
      "/api/integrations/posthog/webhook",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
