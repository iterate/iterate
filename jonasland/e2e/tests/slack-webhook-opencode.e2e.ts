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

describe.runIf(RUN_E2E)("jonasland slack webhook flow", () => {
  test("slack webhook triggers llm call and sends mocked response to slack", async () => {
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

    const llmReq = proxy.waitFor((request) => {
      const url = new URL(request.url);
      return url.pathname === "/v1/responses";
    });

    const slackReq = proxy.waitFor((request) => {
      const url = new URL(request.url);
      return url.pathname === "/api/chat.postMessage";
    });

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

    const slackRecord = await slackReq;
    const slackBody = (await slackRecord.request.json()) as Record<string, unknown>;
    expect(slackBody).toEqual(
      expect.objectContaining({
        channel: "C123",
        thread_ts: "1730000000.000100",
        text: expect.stringContaining("42"),
      }),
    );

    const unmatchedCount = proxy.records.filter((record) => record.response.status === 599).length;
    expect(unmatchedCount).toBe(0);
  });
});
