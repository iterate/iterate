import { expect, test } from "vitest";
import { setupE2E } from "../test-support/e2e-test.ts";
import { createLocalDevServer } from "../test-support/create-local-dev-server.ts";

test(
  "receives a real events.iterate.com webhook and appends pong to the same stream",
  { tags: ["local-dev-server", "live-internet"], timeout: 100_000 },
  async (ctx) => {
    const e2e = await setupE2E(ctx);
    const streamPath = e2e.createStreamPath();

    await using server = await createLocalDevServer({
      eventsBaseUrl: e2e.eventsBaseUrl,
      eventsProjectSlug: e2e.runSlug,
      executionSuffix: e2e.executionSuffix,
      streamPath,
    });

    const callbackUrl = new URL("/api/events-forwarded", server.publicUrl).toString();

    await e2e.events.append(streamPath, {
      type: "https://events.iterate.com/events/stream/subscription/configured",
      payload: {
        slug: `agents-forwarded-${e2e.executionSuffix}`,
        type: "webhook",
        callbackUrl,
      },
    });
    await e2e.events.append(streamPath, {
      type: "ping",
      payload: {
        message: `ping ${e2e.executionSuffix}`,
        source: server.baseUrl,
      },
    });

    const pong = await e2e.events.waitForEvent(streamPath, (event) => event.type === "pong", {
      timeoutMs: 45_000,
    });

    expect(pong.payload).toMatchObject({ ok: true });
  },
);
