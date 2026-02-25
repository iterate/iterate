import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  mockEgressProxy,
  projectDeployment,
  type ProjectDeployment,
} from "../test-helpers/index.ts";

const RUN_E2E = process.env.RUN_JONASLAND_E2E === "true";
const image = process.env.JONASLAND_SANDBOX_IMAGE || "jonasland-sandbox:local";

const OTEL_SERVICE_ENV = {
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:15318",
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:15318/v1/traces",
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://127.0.0.1:15318/v1/logs",
  OTEL_PROPAGATORS: "tracecontext,baggage",
};

type OnDemandProcessName = "egress-proxy" | "opencode" | "agents" | "opencode-wrapper" | "slack";

type OnDemandProcessConfig = {
  definition: {
    command: string;
    args: string[];
    env: Record<string, string>;
  };
  routeCheck?: { host: string; path: string };
  directHttpCheck?: { url: string };
};

const ON_DEMAND_PROCESSES: Record<OnDemandProcessName, OnDemandProcessConfig> = {
  "egress-proxy": {
    definition: {
      command: "/opt/pidnap/node_modules/.bin/tsx",
      args: ["/opt/services/egress-service/src/server.ts"],
      env: OTEL_SERVICE_ENV,
    },
    directHttpCheck: { url: "http://127.0.0.1:19000/healthz" },
  },
  opencode: {
    definition: {
      command: "/opt/pidnap/node_modules/.bin/tsx",
      args: ["/opt/jonasland-sandbox/scripts/opencode-mock.ts"],
      env: {
        ...OTEL_SERVICE_ENV,
        OPENCODE_PORT: "4096",
      },
    },
    directHttpCheck: { url: "http://127.0.0.1:4096/healthz" },
  },
  agents: {
    definition: {
      command: "/opt/pidnap/node_modules/.bin/tsx",
      args: ["/opt/services/agents/src/server.ts"],
      env: {
        ...OTEL_SERVICE_ENV,
        AGENTS_SERVICE_PORT: "19061",
        OPENCODE_WRAPPER_BASE_URL: "http://127.0.0.1:19062",
      },
    },
    routeCheck: { host: "agents.iterate.localhost", path: "/healthz" },
  },
  "opencode-wrapper": {
    definition: {
      command: "/opt/pidnap/node_modules/.bin/tsx",
      args: ["/opt/services/opencode-wrapper/src/server.ts"],
      env: {
        ...OTEL_SERVICE_ENV,
        OPENCODE_WRAPPER_SERVICE_PORT: "19062",
        AGENTS_SERVICE_BASE_URL: "http://127.0.0.1:19061",
        DAEMON_SERVICE_BASE_URL: "http://127.0.0.1:19060",
        OPENCODE_BASE_URL: "http://127.0.0.1:4096",
        OPENAI_BASE_URL: "http://api.openai.com",
        SLACK_API_BASE_URL: "http://slack.com",
        OPENAI_MODEL: "gpt-4o-mini",
      },
    },
    routeCheck: { host: "opencode-wrapper.iterate.localhost", path: "/healthz" },
  },
  slack: {
    definition: {
      command: "/opt/pidnap/node_modules/.bin/tsx",
      args: ["/opt/services/slack/src/server.ts"],
      env: {
        ...OTEL_SERVICE_ENV,
        SLACK_SERVICE_PORT: "19063",
        AGENTS_SERVICE_BASE_URL: "http://127.0.0.1:19061",
      },
    },
    routeCheck: { host: "slack.iterate.localhost", path: "/healthz" },
  },
};

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
    const result = await deployment
      .exec(`curl -fsS '${params.url}' >/dev/null`)
      .catch(() => ({ exitCode: 1, output: "" }));
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
