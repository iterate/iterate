/* eslint-disable no-empty-pattern -- Playwright requires object-destructured fixture args. */
import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import { ingressRequest, projectDeployment, test } from "./test-helpers.ts";

test.describe("events service", () => {
  test("supports health + append/list streams from outside container", async ({}) => {
    await using deployment = await projectDeployment();
    const healthResponse = await ingressRequest(deployment, {
      host: "events.iterate.localhost",
      path: "/api/service/health",
    });
    expect(healthResponse.status).toBe(200);

    const healthPayload = (await healthResponse.json()) as { ok: boolean; service: string };
    expect(healthPayload.ok).toBe(true);
    expect(healthPayload.service).toBe("jonasland-events-service");

    const streamPath = `playwright/events/${randomUUID().slice(0, 8)}`;

    const appendResponse = await ingressRequest(deployment, {
      host: "events.iterate.localhost",
      path: "/orpc/append",
      json: {
        json: {
          path: streamPath,
          events: [
            {
              type: "https://events.iterate.com/events/test/playwright-event-recorded",
              payload: { source: "playwright", value: 42 },
            },
          ],
        },
      },
    });
    expect(appendResponse.status).toBe(200);
    expect(await appendResponse.text()).toBe("{}");

    const listResponse = await ingressRequest(deployment, {
      host: "events.iterate.localhost",
      path: "/orpc/listStreams",
      json: { json: {} },
    });
    expect(listResponse.status).toBe(200);

    const listed = (await listResponse.json()) as {
      json: Array<{ path: string; eventCount: number }>;
    };
    const normalizedPath = `/${streamPath.replace(/^\/+/, "")}`;
    const stream = listed.json.find((entry) => entry.path === normalizedPath);
    expect(stream).toBeDefined();
    expect(stream?.eventCount).toBeGreaterThanOrEqual(1);
  });
});
