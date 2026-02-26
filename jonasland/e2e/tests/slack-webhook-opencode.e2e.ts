import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  mockEgressProxy,
  projectDeployment,
  type ProjectDeployment,
} from "../test-helpers/index.ts";
import {
  ON_DEMAND_PROCESSES_BY_NAME,
  type OnDemandProcessName,
} from "../../shared/on-demand-processes.ts";

const RUN_E2E = process.env.RUN_JONASLAND_E2E === "true";
const image = process.env.JONASLAND_SANDBOX_IMAGE || "jonasland-sandbox:local";
const EVENTS_HOST_HEADER = "Host: events.iterate.localhost";
const EVENTS_JSON_HEADER = "content-type: application/json";

type OnDemandProcessConfig = {
  definition: {
    command: string;
    args: string[];
    env: Record<string, string>;
  };
  routeCheck?: { host: string; path: string };
  directHttpCheck?: { url: string };
};
const ON_DEMAND_PROCESSES: Record<OnDemandProcessName, OnDemandProcessConfig> =
  ON_DEMAND_PROCESSES_BY_NAME;

async function waitForHostRoute(
  deployment: ProjectDeployment,
  params: { host: string; path: string; timeoutMs?: number },
): Promise<void> {
  const timeoutMs = params.timeoutMs ?? 45_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await deployment
      .exec(["curl", "-fsS", "-H", `Host: ${params.host}`, `http://127.0.0.1${params.path}`])
      .catch(() => ({ exitCode: 1, output: "" }));
    if (result.exitCode === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for host route ${params.host}${params.path}`);
}

async function waitForDirectHttp(
  deployment: ProjectDeployment,
  params: { url: string; timeoutMs?: number },
): Promise<void> {
  const timeoutMs = params.timeoutMs ?? 45_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await deployment.exec(["curl", "-fsS", params.url]).catch(() => ({
      exitCode: 1,
      output: "",
    }));
    if (result.exitCode === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for direct http ${params.url}`);
}

async function startOnDemandProcess(
  deployment: ProjectDeployment,
  processName: OnDemandProcessName,
): Promise<void> {
  const processConfig = ON_DEMAND_PROCESSES[processName];
  const updated = await deployment.pidnap.processes.updateConfig({
    processSlug: processName,
    definition: processConfig.definition,
    options: { restartPolicy: "always" },
    envOptions: { reloadDelay: false },
  });

  if (updated.state !== "running") {
    await deployment.pidnap.processes.start({ target: processName });
  }

  await deployment.waitForPidnapProcessRunning({
    target: processName,
    timeoutMs: 60_000,
  });

  if (processConfig.routeCheck) {
    await waitForHostRoute(deployment, processConfig.routeCheck);
  }
  if (processConfig.directHttpCheck) {
    await waitForDirectHttp(deployment, processConfig.directHttpCheck);
  }
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

describe.runIf(RUN_E2E)("jonasland slack webhook flow", () => {
  test("slack webhook goes through events mediation, triggers llm call, and posts slack updates", async () => {
    await using proxy = await mockEgressProxy();

    proxy.fetch = async (request) => {
      const url = new URL(request.url);

      if (url.pathname === "/v1/responses") {
        return Response.json({
          id: "resp_test",
          output_text: "The answer is 42",
        });
      }

      if (url.pathname === "/api/chat.postMessage") {
        return Response.json({ ok: true, ts: "123.456" });
      }

      return new Response("unmatched", { status: 599 });
    };

    const llmReq = proxy.waitFor(
      (request) => {
        const url = new URL(request.url);
        return url.pathname === "/v1/responses";
      },
      { timeout: 30_000 },
    );

    const firstSlackReq = proxy.waitFor(
      (request) => {
        const url = new URL(request.url);
        return url.pathname === "/api/chat.postMessage";
      },
      { timeout: 30_000 },
    );

    await using deployment = await projectDeployment({
      image,
      name: `jonasland-e2e-slack-${randomUUID()}`,
      extraHosts: ["host.docker.internal:host-gateway"],
      env: {
        ITERATE_EXTERNAL_EGRESS_PROXY: proxy.proxyUrl,
      },
    });

    await startOnDemandProcess(deployment, "egress-proxy");
    await startOnDemandProcess(deployment, "opencode");
    await startOnDemandProcess(deployment, "agents");
    await startOnDemandProcess(deployment, "opencode-wrapper");
    await startOnDemandProcess(deployment, "slack");

    const webhookPayload = {
      event: {
        type: "app_mention",
        user: "U123",
        text: "<@BOT> what is 50 minus 8",
        channel: "C123",
        ts: "1730000000.000100",
        thread_ts: "1730000000.000100",
      },
    };

    const webhook = await deployment.exec([
      "curl",
      "-sS",
      "-i",
      "-H",
      "Host: slack.iterate.localhost",
      "-H",
      "content-type: application/json",
      "--data",
      JSON.stringify(webhookPayload),
      "http://127.0.0.1/webhook",
    ]);

    if (!/HTTP\/\d(?:\.\d)? 200/.test(webhook.output)) {
      const logs = await deployment.logs();
      throw new Error(`webhook failed:\n${webhook.output}\n\ncontainer logs:\n${logs}`);
    }

    const llmRecord = await llmReq;
    const llmBody = (await llmRecord.request.json()) as Record<string, unknown>;
    expect(llmBody).toEqual(
      expect.objectContaining({
        model: expect.any(String),
        input: expect.anything(),
      }),
    );

    await firstSlackReq;

    const slackDeadline = Date.now() + 45_000;
    let observedTwoSlackMessages = false;
    while (Date.now() < slackDeadline) {
      const slackRecords = proxy.records.filter(
        (record) => new URL(record.request.url).pathname === "/api/chat.postMessage",
      );
      if (slackRecords.length >= 2) {
        const firstBody = (await slackRecords[0]!.request.json()) as Record<string, unknown>;
        const secondBody = (await slackRecords[1]!.request.json()) as Record<string, unknown>;

        expect(firstBody).toEqual(
          expect.objectContaining({
            channel: "C123",
            thread_ts: "1730000000.000100",
            text: expect.stringContaining("Thinking"),
          }),
        );
        expect(secondBody).toEqual(
          expect.objectContaining({
            channel: "C123",
            thread_ts: "1730000000.000100",
            text: expect.stringContaining("42"),
          }),
        );
        observedTwoSlackMessages = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(observedTwoSlackMessages).toBe(true);

    const listResult = await postEventsOrpc(deployment, "listStreams", {});
    expect(listResult.exitCode).toBe(0);
    const streamsPayload = JSON.parse(listResult.output) as {
      json: Array<{ path: string; eventCount: number }>;
    };
    const streams = streamsPayload.json;
    expect(streams.some((stream) => stream.path === "/integrations/slack/webhooks")).toBe(true);
    expect(streams.some((stream) => stream.path.startsWith("/agents/opencode/"))).toBe(true);

    const unmatchedCount = proxy.records.filter((record) => record.response.status === 599).length;
    expect(unmatchedCount).toBe(0);
  });
});
