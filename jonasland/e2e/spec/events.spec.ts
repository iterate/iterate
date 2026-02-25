/* eslint-disable no-empty-pattern -- Playwright requires object-destructured fixture args. */
import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import { projectDeployment, runE2E, test } from "./test-helpers.ts";

test.skip(!runE2E, "Set RUN_JONASLAND_E2E=true to run Playwright e2e specs");

test.describe("events service", () => {
  test("supports health + append/list streams from outside container", async ({}) => {
    await using deployment = await projectDeployment();
    const healthPayload = (await deployment.events.service.health({})) as {
      ok: boolean;
      service: string;
    };
    expect(healthPayload.ok).toBe(true);
    expect(healthPayload.service).toBe("jonasland-events-service");

    const streamPath = `playwright/events/${randomUUID().slice(0, 8)}`;

    await deployment.events.append({
      path: streamPath,
      events: [
        {
          type: "https://events.iterate.com/events/test/playwright-event-recorded",
          payload: { source: "playwright", value: 42 },
        },
      ],
    });

    const listed = (await deployment.events.listStreams({})) as Array<{
      path: string;
      eventCount: number;
    }>;
    const normalizedPath = `/${streamPath.replace(/^\/+/, "")}`;
    const stream = listed.find((entry) => entry.path === normalizedPath);
    expect(stream).toBeDefined();
    expect(stream?.eventCount).toBeGreaterThanOrEqual(1);
  });
});
