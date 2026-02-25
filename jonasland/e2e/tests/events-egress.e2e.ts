import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  mockEgressProxy,
  projectDeployment,
  type ProjectDeployment,
} from "../test-helpers/index.ts";

const RUN_E2E = process.env.RUN_JONASLAND_E2E === "true";
const E2E_PROVIDER = (process.env.JONASLAND_E2E_PROVIDER ?? "docker").trim().toLowerCase();
const RUN_DOCKER_E2E = RUN_E2E && E2E_PROVIDER === "docker";
const image = process.env.JONASLAND_SANDBOX_IMAGE || "jonasland-sandbox:local";

const OTEL_SERVICE_ENV = {
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:15318",
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:15318/v1/traces",
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://127.0.0.1:15318/v1/logs",
  OTEL_PROPAGATORS: "tracecontext,baggage",
};

const EVENTS_HOST_HEADER = "Host: events.iterate.localhost";
const EVENTS_JSON_HEADER = "content-type: application/json";

async function waitForDirectHttp(
  deployment: ProjectDeployment,
  params: { url: string; timeoutMs?: number },
): Promise<void> {
  const timeoutMs = params.timeoutMs ?? 45_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await deployment
      .exec(["curl", "-fsS", params.url])
      .catch(() => ({ exitCode: 1, output: "" }));
    if (result.exitCode === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for direct http ${params.url}`);
}

async function startEgressProxyProcess(deployment: ProjectDeployment): Promise<void> {
  const updated = await deployment.pidnap.processes.updateConfig({
    processSlug: "egress-proxy",
    definition: {
      command: "/opt/pidnap/node_modules/.bin/tsx",
      args: ["/opt/services/egress-service/src/server.ts"],
      env: OTEL_SERVICE_ENV,
    },
    options: { restartPolicy: "always" },
    envOptions: { reloadDelay: false },
  });
  if (updated.state !== "running") {
    await deployment.pidnap.processes.start({ target: "egress-proxy" });
  }
  await deployment.waitForPidnapProcessRunning({
    target: "egress-proxy",
    timeoutMs: 45_000,
  });
  await waitForDirectHttp(deployment, {
    url: "http://127.0.0.1:19000/healthz",
  });
}

async function postEventsOrpc(
  deployment: ProjectDeployment,
  procedure: string,
  body: unknown,
): Promise<{ exitCode: number; output: string }> {
  return await deployment.exec([
    "curl",
    "-fsS",
    "-H",
    EVENTS_HOST_HEADER,
    "-H",
    EVENTS_JSON_HEADER,
    "--data",
    JSON.stringify({ json: body }),
    `http://127.0.0.1/orpc/${procedure}`,
  ]);
}

describe.runIf(RUN_DOCKER_E2E)("jonasland events egress", () => {
  test("events service health + append/listStreams work inside the container", async () => {
    await using deployment = await projectDeployment({
      image,
      name: `jonasland-e2e-events-contract-${randomUUID()}`,
    });

    const health = await deployment.exec([
      "curl",
      "-fsS",
      "-H",
      EVENTS_HOST_HEADER,
      "http://127.0.0.1/api/service/health",
    ]);
    expect(health.exitCode).toBe(0);
    const healthPayload = JSON.parse(health.output) as { ok: boolean; service: string };
    expect(healthPayload.ok).toBe(true);
    expect(healthPayload.service).toBe("jonasland-events-service");

    const streamPath = `e2e/events/${randomUUID().slice(0, 8)}`;
    const appendResult = await postEventsOrpc(deployment, "append", {
      path: streamPath,
      events: [
        {
          type: "https://events.iterate.com/events/test/e2e-event-recorded",
          payload: { source: "jonasland-e2e", value: 42 },
        },
      ],
    });
    expect(appendResult.exitCode).toBe(0);
    expect(appendResult.output).toBe("{}");

    const listResult = await postEventsOrpc(deployment, "listStreams", {});
    expect(listResult.exitCode).toBe(0);

    const streamsPayload = JSON.parse(listResult.output) as {
      json: Array<{
        path: string;
        eventCount: number;
      }>;
    };
    const streams = streamsPayload.json;
    const normalizedPath = `/${streamPath.replace(/^\/+/, "")}`;
    const stream = streams.find((entry) => entry.path === normalizedPath);
    expect(stream).toBeDefined();
    expect(stream?.eventCount).toBeGreaterThanOrEqual(1);
  });

  test("events push subscription emits registration and appended events through external egress proxy", async () => {
    await using proxy = await mockEgressProxy();
    proxy.fetch = async (request) => {
      if (new URL(request.url).pathname !== "/events-callback") {
        return new Response("unmatched", { status: 599 });
      }
      return Response.json({ ok: true });
    };

    await using deployment = await projectDeployment({
      image,
      name: `jonasland-e2e-events-egress-${randomUUID()}`,
      extraHosts: ["host.docker.internal:host-gateway"],
      env: {
        ITERATE_EXTERNAL_EGRESS_PROXY: proxy.proxyUrl,
      },
    });
    await startEgressProxyProcess(deployment);

    const streamPath = `e2e/events/${randomUUID().slice(0, 8)}`;
    const subscriptionSlug = `sub-${randomUUID().slice(0, 8)}`;
    const callbackUrl = "http://api.openai.com/events-callback";

    const registrationDelivery = proxy.waitFor(
      (request) => new URL(request.url).pathname === "/events-callback",
      { timeout: 45_000 },
    );
    const registerResult = await postEventsOrpc(deployment, "registerSubscription", {
      path: streamPath,
      subscription: {
        type: "webhook",
        URL: callbackUrl,
        subscriptionSlug,
      },
    });
    expect(registerResult.exitCode).toBe(0);
    expect(registerResult.output).toBe("{}");

    const registrationRecord = await registrationDelivery;
    expect(registrationRecord.response.status).toBe(200);
    expect(registrationRecord.request.headers.get("x-iterate-egress-proxy-seen")).toBe("1");
    expect(registrationRecord.request.headers.get("x-iterate-egress-mode")).toBe("external-proxy");
    const registrationBody = (await registrationRecord.request.json()) as Record<string, unknown>;
    expect(registrationBody["type"]).toBe(
      "https://events.iterate.com/events/stream/push-subscription-callback-added",
    );
    expect(registrationBody["offset"]).toBe("0000000000000000");
    expect(registrationBody["path"]).toBe(streamPath.replace(/^\/+/, ""));

    const appendedEventType = "https://events.iterate.com/events/test/e2e-event-recorded";
    const appendedEventPayload = { source: "jonasland-e2e", value: 777 };
    const appendedDelivery = proxy.waitFor(
      (request) => new URL(request.url).pathname === "/events-callback",
      { timeout: 45_000 },
    );

    const appendResult = await postEventsOrpc(deployment, "append", {
      path: streamPath,
      events: [{ type: appendedEventType, payload: appendedEventPayload }],
    });
    expect(appendResult.exitCode).toBe(0);
    expect(appendResult.output).toBe("{}");

    const appendedRecord = await appendedDelivery;
    expect(appendedRecord.response.status).toBe(200);
    expect(appendedRecord.request.headers.get("x-iterate-egress-proxy-seen")).toBe("1");
    expect(appendedRecord.request.headers.get("x-iterate-egress-mode")).toBe("external-proxy");

    const appendedBody = (await appendedRecord.request.json()) as Record<string, unknown>;
    expect(appendedBody["type"]).toBe(appendedEventType);
    expect(appendedBody["offset"]).toBe("0000000000000001");
    expect(appendedBody["path"]).toBe(streamPath.replace(/^\/+/, ""));
    expect(appendedBody["payload"]).toEqual(appendedEventPayload);

    const unmatchedCount = proxy.records.filter((record) => record.response.status === 599).length;
    expect(unmatchedCount).toBe(0);
  });
});
