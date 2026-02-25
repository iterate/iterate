import { request as httpRequest } from "node:http";
import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { projectDeployment, type ProjectDeployment } from "../test-helpers/index.ts";

const RUN_E2E = process.env.RUN_JONASLAND_E2E === "true";
const image = process.env.JONASLAND_SANDBOX_IMAGE || "jonasland-sandbox:local";

const ORDER_WORKFLOW_STARTED_EVENT_TYPE = "https://events.iterate.com/orders/workflow-started";
const ORDER_WORKFLOW_COMPLETED_EVENT_TYPE = "https://events.iterate.com/orders/workflow-completed";

const OTEL_SERVICE_ENV = {
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:15318",
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:15318/v1/traces",
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://127.0.0.1:15318/v1/logs",
  OTEL_PROPAGATORS: "tracecontext,baggage",
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function waitForHostRoute(
  deployment: ProjectDeployment,
  params: { host: string; path: string; timeoutMs?: number },
): Promise<void> {
  const timeoutMs = params.timeoutMs ?? 45_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await deployment
      .exec(`curl -fsS -H 'Host: ${params.host}' 'http://127.0.0.1${params.path}' >/dev/null`)
      .catch(() => ({ exitCode: 1, output: "" }));
    if (result.exitCode === 0) return;
    await sleep(200);
  }
  throw new Error(`timed out waiting for host route ${params.host}${params.path}`);
}

async function startOrdersProcess(deployment: ProjectDeployment): Promise<void> {
  const updated = await deployment.pidnap.processes.updateConfig({
    processSlug: "orders",
    definition: {
      command: "/opt/pidnap/node_modules/.bin/tsx",
      args: ["/opt/services/orders-service/src/server.ts"],
      env: {
        ...OTEL_SERVICE_ENV,
        EVENTS_SERVICE_BASE_URL: "http://127.0.0.1:19010/orpc",
      },
    },
    options: { restartPolicy: "always" },
    envOptions: { reloadDelay: false },
  });

  if (updated.state !== "running") {
    await deployment.pidnap.processes.start({ target: "orders" });
  }

  await deployment.waitForPidnapProcessRunning({ target: "orders", timeoutMs: 45_000 });
  await waitForHostRoute(deployment, {
    host: "orders.iterate.localhost",
    path: "/healthz",
    timeoutMs: 45_000,
  });
}

async function collectMatchingSseEvents(params: {
  url: string;
  hostHeader: string;
  count: number;
  timeoutMs: number;
  matcher: (event: Record<string, unknown>) => boolean;
}): Promise<Array<Record<string, unknown>>> {
  return await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
    const target = new URL(params.url);
    const events: Array<Record<string, unknown>> = [];
    const timeout = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `timed out after ${String(params.timeoutMs)}ms waiting for ${String(params.count)} firehose event(s), matched=${String(events.length)}`,
        ),
      );
    }, params.timeoutMs);

    let buffer = "";
    let settled = false;

    const request = httpRequest(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: "GET",
        headers: {
          host: params.hostHeader,
          accept: "text/event-stream",
        },
      },
      (response) => {
        if ((response.statusCode ?? 500) >= 400) {
          cleanup();
          reject(new Error(`firehose request failed with status ${String(response.statusCode)}`));
          return;
        }

        response.setEncoding("utf8");

        response.on("data", (chunk: string) => {
          buffer += chunk;
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";

          for (const frame of frames) {
            const lines = frame
              .split("\n")
              .map((line) => line.trimEnd())
              .filter((line) => line.length > 0);
            const eventType = lines.find((line) => line.startsWith("event: "))?.slice(7);
            if (eventType !== undefined && eventType !== "message") {
              continue;
            }
            const dataLine = lines.find((line) => line.startsWith("data: "));
            if (dataLine === undefined) continue;

            const event = JSON.parse(dataLine.slice(6)) as Record<string, unknown>;
            if (!params.matcher(event)) continue;

            events.push(event);
            if (events.length >= params.count) {
              cleanup();
              resolve(events);
              return;
            }
          }
        });

        response.on("error", (error) => {
          cleanup();
          reject(error);
        });
      },
    );

    request.on("error", (error) => {
      cleanup();
      reject(error);
    });

    request.end();

    function cleanup() {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      request.destroy();
    }
  });
}

describe.runIf(RUN_E2E)("jonasland firehose workflow", () => {
  test("firehose SSE captures delayed workflow events emitted by orders service", async () => {
    await using deployment = await projectDeployment({
      image,
      name: `jonasland-e2e-firehose-${randomUUID()}`,
    });

    await startOrdersProcess(deployment);

    const streamPath = `e2e/orders-workflow/${randomUUID().slice(0, 8)}`;
    const firehoseUrl = new URL("/api/firehose", await deployment.ingressUrl()).toString();

    const firehoseEventsPromise = collectMatchingSseEvents({
      url: firehoseUrl,
      hostHeader: "events.iterate.localhost",
      count: 2,
      timeoutMs: 45_000,
      matcher: (event) => {
        const eventPath = String(event["path"] ?? "");
        const eventType = String(event["type"] ?? "");

        if (eventPath !== streamPath) return false;
        return (
          eventType === ORDER_WORKFLOW_STARTED_EVENT_TYPE ||
          eventType === ORDER_WORKFLOW_COMPLETED_EVENT_TYPE
        );
      },
    });

    await sleep(100);

    const kickoffResult = await deployment.exec([
      "curl",
      "-fsS",
      "-H",
      "Host: orders.iterate.localhost",
      "-H",
      "content-type: application/json",
      "--data",
      JSON.stringify({
        sku: "sku-firehose",
        quantity: 2,
        delayMs: 300,
        streamPath,
      }),
      "http://127.0.0.1/api/orders/kickoff-workflow",
    ]);

    expect(kickoffResult.exitCode).toBe(0);

    const kickoff = JSON.parse(kickoffResult.output) as {
      accepted: boolean;
      workflowId: string;
      orderId: string;
      streamPath: string;
      delayMs: number;
      createdEventId: string;
      createdAt: string;
    };

    expect(kickoff.accepted).toBe(true);
    expect(kickoff.workflowId.length).toBeGreaterThan(0);
    expect(kickoff.orderId.length).toBeGreaterThan(0);
    expect(kickoff.streamPath).toBe(streamPath);
    expect(kickoff.delayMs).toBe(300);
    expect(kickoff.createdEventId.length).toBeGreaterThan(0);
    expect(kickoff.createdAt.length).toBeGreaterThan(0);

    const events = await firehoseEventsPromise;

    expect(events).toHaveLength(2);
    expect(events.map((event) => event["type"])).toEqual([
      ORDER_WORKFLOW_STARTED_EVENT_TYPE,
      ORDER_WORKFLOW_COMPLETED_EVENT_TYPE,
    ]);
    expect(events.map((event) => event["offset"])).toEqual([
      "0000000000000000",
      "0000000000000001",
    ]);

    const startedPayload = (events[0]?.["payload"] ?? {}) as Record<string, unknown>;
    expect(startedPayload["workflowId"]).toBe(kickoff.workflowId);
    expect(startedPayload["orderId"]).toBe(kickoff.orderId);
    expect(startedPayload["sku"]).toBe("sku-firehose");
    expect(startedPayload["quantity"]).toBe(2);
    expect(startedPayload["delayMs"]).toBe(300);
    expect(startedPayload["streamPath"]).toBe(streamPath);
    expect(startedPayload["eventId"]).toBe(kickoff.createdEventId);

    const completedPayload = (events[1]?.["payload"] ?? {}) as Record<string, unknown>;
    expect(completedPayload["workflowId"]).toBe(kickoff.workflowId);
    expect(completedPayload["orderId"]).toBe(kickoff.orderId);
    expect(completedPayload["sku"]).toBe("sku-firehose");
    expect(completedPayload["quantity"]).toBe(2);
    expect(completedPayload["delayMs"]).toBe(300);
    expect(completedPayload["streamPath"]).toBe(streamPath);
    expect(completedPayload["startedEventId"]).toBe(kickoff.createdEventId);
  });
});
