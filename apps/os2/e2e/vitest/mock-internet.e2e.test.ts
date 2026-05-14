import { join } from "node:path";
import { HttpResponse, http } from "@iterate-com/mock-http-proxy";
import { useCloudflareTunnel, useCloudflareTunnelLease } from "@iterate-com/shared/test-helpers";
import type { Event } from "@iterate-com/shared/streams/types";
import { expect, test } from "vitest";
import { createMockInternet } from "../test-support/create-mock-internet.ts";
import { createTestProject } from "../test-support/create-test-project.ts";
import { setupE2E } from "../test-support/e2e-test.ts";
import { readProjectStreamUntil } from "../test-support/os2-client.ts";

const hasAdminApiTarget =
  !!(process.env.OS2_BASE_URL?.trim() || process.env.APP_CONFIG_BASE_URL?.trim()) &&
  !!(
    process.env.OS2_E2E_ADMIN_API_SECRET?.trim() ||
    process.env.OS2_ADMIN_API_SECRET?.trim() ||
    process.env.APP_CONFIG_ADMIN_API_SECRET?.trim()
  ) &&
  !!process.env.SEMAPHORE_API_TOKEN?.trim();
const testIfAdminApiTarget = hasAdminApiTarget ? test : test.skip;

testIfAdminApiTarget("runs codemode fetch through a mocked project egress proxy", async (ctx) => {
  const e2e = await setupE2E(ctx);
  await using tunnelLease = await useCloudflareTunnelLease({});
  await using internet = await createMockInternet({
    harPath: join(e2e.artifactDir, "codemode-fetch.har"),
    handlers: [
      http.get("*/__e2e-health", () => HttpResponse.text("ok")),
      http.get("https://example.com/os2-e2e", ({ request }) =>
        HttpResponse.json(
          {
            mocked: true,
            query: new URL(request.url).searchParams.get("source"),
            runSlug: e2e.runSlug,
          },
          {
            headers: {
              "x-e2e-mocked": "yes",
            },
          },
        ),
      ),
    ],
    port: tunnelLease.localPort,
  });
  await using tunnel = await useCloudflareTunnel({
    healthcheckPath: "/__e2e-health",
    token: tunnelLease.tunnelToken,
    publicUrl: tunnelLease.publicUrl,
  });
  await using project = await createTestProject({
    externalEgressProxyUrl: tunnel.publicUrl,
    slugPrefix: "mock-internet",
  });

  const started = await project.client.project.codemode.executeScript({
    code: `async () => {
  const response = await fetch("https://example.com/os2-e2e?source=codemode");
  return {
    body: await response.json(),
    mockedHeader: response.headers.get("x-e2e-mocked"),
    status: response.status
  };
}`,
    projectSlugOrId: project.project.id,
    providers: [],
  });
  const scriptExecutionId = readScriptExecutionId(started.event);
  const events = await readProjectStreamUntil({
    afterOffset: started.event.offset > 1 ? started.event.offset - 1 : "start",
    client: project.client,
    projectSlugOrId: project.project.id,
    streamPath: started.streamPath,
    predicate: (event) =>
      event.type === "events.iterate.com/codemode/script-execution-completed" &&
      readPayloadRecord(event).scriptExecutionId === scriptExecutionId,
  });
  const completed = requiredEvent(events, "events.iterate.com/codemode/script-execution-completed");
  const har = internet.getHar();

  expect(completed.payload).toMatchObject({
    outcome: {
      status: "returned",
      value: {
        body: {
          mocked: true,
          query: "codemode",
          runSlug: e2e.runSlug,
        },
        mockedHeader: "yes",
        status: 200,
      },
    },
    scriptExecutionId,
  });
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "events.iterate.com/codemode/function-call-completed",
      payload: expect.objectContaining({
        path: ["fetch"],
      }),
    }),
  );
  expect(events.filter((event) => event.type === "events.iterate.com/core/error-occurred")).toEqual(
    [],
  );
  expect(
    har.log.entries
      .filter(
        (entry) => entry.request.url !== new URL("/__e2e-health", tunnel.publicUrl).toString(),
      )
      .map((entry) => entry.request.url),
  ).toContain("https://example.com/os2-e2e?source=codemode");
});

function readScriptExecutionId(event: Event) {
  const scriptExecutionId = readPayloadRecord(event).scriptExecutionId;
  if (typeof scriptExecutionId !== "string") {
    throw new Error("Expected codemode script execution event to include scriptExecutionId.");
  }
  return scriptExecutionId;
}

function requiredEvent(events: readonly Event[], type: string) {
  const event = events.find((item) => item.type === type);
  if (!event) throw new Error(`Expected ${type}.`);
  return event;
}

function readPayloadRecord(event: Event) {
  return event.payload != null && typeof event.payload === "object"
    ? (event.payload as Record<string, unknown>)
    : {};
}
