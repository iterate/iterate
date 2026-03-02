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
const ON_DEMAND_PROCESSES: Record<OnDemandProcessName, OnDemandProcessConfig> = {
  ...ON_DEMAND_PROCESSES_BY_NAME,
  agents: {
    ...ON_DEMAND_PROCESSES_BY_NAME.agents,
    definition: {
      ...ON_DEMAND_PROCESSES_BY_NAME.agents.definition,
      env: {
        ...ON_DEMAND_PROCESSES_BY_NAME.agents.definition.env,
        AGENTS_DEFAULT_PROVIDER: "opencode",
      },
    },
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

function encodeStreamPathForUrl(path: string): string {
  return path
    .replace(/^\/+/, "")
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

async function readStreamEvents(
  deployment: ProjectDeployment,
  streamPath: string,
): Promise<Array<Record<string, unknown>>> {
  const encoded = encodeStreamPathForUrl(streamPath);
  const result = await deployment.exec([
    "curl",
    "-fsS",
    "-H",
    EVENTS_HOST_HEADER,
    `http://127.0.0.1/api/streams/${encoded}`,
  ]);

  if (result.exitCode !== 0) {
    throw new Error(`failed to read stream ${streamPath}: ${result.output}`);
  }

  const events: Array<Record<string, unknown>> = [];
  for (const line of result.output.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const raw = line.slice("data: ".length).trim();
    if (raw.length === 0) continue;
    events.push(JSON.parse(raw) as Record<string, unknown>);
  }
  return events;
}

describe.runIf(RUN_E2E)("jonasland slack webhook flow", () => {
  test("slack webhook goes through events mediation, triggers llm call, and posts slack updates", async () => {
    await using proxy = await mockEgressProxy();

    proxy.fetch = async (request) => {
      const url = new URL(request.url);

      if (url.pathname === "/api/chat.postMessage") {
        return Response.json({ ok: true, ts: "123.456" });
      }

      if (url.pathname === "/v1/models") {
        return Response.json({
          object: "list",
          data: [{ id: "gpt-4o-mini", object: "model" }],
        });
      }

      if (url.pathname === "/v1/chat/completions") {
        return Response.json({
          id: "chatcmpl_test",
          object: "chat.completion",
          created: 1_730_000_001,
          model: "gpt-4o-mini",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: { role: "assistant", content: "The answer is 42" },
            },
          ],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 6,
            total_tokens: 18,
          },
        });
      }

      if (url.pathname === "/v1/responses") {
        return Response.json({
          id: "resp_test",
          output_text: "The answer is 42",
        });
      }

      if (url.pathname === "/v1/messages") {
        return Response.json({
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: "claude-test",
          content: [{ type: "text", text: "The answer is 42" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 6 },
        });
      }

      if (url.pathname === "/v1/messages/count_tokens") {
        return Response.json({ input_tokens: 10 });
      }

      return Response.json({ ok: true });
    };

    await using deployment = await projectDeployment({
      image,
      name: `jonasland-e2e-slack-${randomUUID()}`,
      extraHosts: ["host.docker.internal:host-gateway"],
      runtimeProcessTargets: ["caddy", "registry", "events"],
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

    const slackDeadline = Date.now() + 90_000;
    let lastSlackBodies: Array<Record<string, unknown>> = [];
    let statusMessageExists = false;
    let finalAnswerExists = false;
    while (Date.now() < slackDeadline) {
      const slackRecords = proxy.records.filter(
        (record) => new URL(record.request.url).pathname === "/api/chat.postMessage",
      );
      if (slackRecords.length >= 2) {
        lastSlackBodies = await Promise.all(
          slackRecords.map(
            async (record) => (await record.request.clone().json()) as Record<string, unknown>,
          ),
        );

        statusMessageExists = lastSlackBodies.some((body) => {
          const text = typeof body.text === "string" ? body.text : "";
          return /thinking|responding|tool|working/i.test(text);
        });

        finalAnswerExists = lastSlackBodies.some((body) => {
          const text = typeof body.text === "string" ? body.text : "";
          if (/^:warning:/i.test(text)) return false;
          return text.length > 0 && !/thinking|responding|tool|working/i.test(text);
        });

        if (statusMessageExists && finalAnswerExists) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(lastSlackBodies.length).toBeGreaterThanOrEqual(2);
    expect(
      lastSlackBodies.every(
        (body) => body.channel === "C123" && body.thread_ts === "1730000000.000100",
      ),
    ).toBe(true);
    expect(statusMessageExists).toBe(true);
    expect(finalAnswerExists).toBe(true);

    const listResult = await postEventsOrpc(deployment, "listStreams", {});
    expect(listResult.exitCode).toBe(0);
    const streamsPayload = JSON.parse(listResult.output) as {
      json: Array<{ path: string; eventCount: number }>;
    };
    const streams = streamsPayload.json;
    expect(streams.some((stream) => stream.path === "/integrations/slack/webhooks")).toBe(true);
    const agentStream = streams.find((stream) => stream.path.startsWith("/agents/opencode/"));
    expect(agentStream).toBeDefined();

    const integrationEvents = await readStreamEvents(deployment, "/integrations/slack/webhooks");
    expect(
      integrationEvents.some(
        (event) =>
          event["type"] === "https://events.iterate.com/integrations/slack/webhook-received",
      ),
    ).toBe(true);
    const webhookEvent = integrationEvents.find(
      (event) => event["type"] === "https://events.iterate.com/integrations/slack/webhook-received",
    );
    expect(webhookEvent).toBeDefined();
    expect(webhookEvent?.["payload"]).toEqual(
      expect.objectContaining({
        channel: "C123",
        threadTs: "1730000000.000100",
        text: "<@BOT> what is 50 minus 8",
      }),
    );

    const agentEvents = await readStreamEvents(deployment, agentStream!.path);
    expect(
      agentEvents.some(
        (event) => event["type"] === "https://events.iterate.com/agents/prompt-added",
      ),
    ).toBe(true);
    expect(
      agentEvents.some(
        (event) => event["type"] === "https://events.iterate.com/agents/status-updated",
      ),
    ).toBe(true);
    expect(
      agentEvents.some(
        (event) => event["type"] === "https://events.iterate.com/agents/response-added",
      ),
    ).toBe(true);

    const promptEvent = agentEvents.find(
      (event) => event["type"] === "https://events.iterate.com/agents/prompt-added",
    );
    expect(promptEvent).toBeDefined();
    expect(promptEvent?.["payload"]).toEqual(
      expect.objectContaining({
        source: "slack",
        prompt: "<@BOT> what is 50 minus 8",
        replyTarget: expect.objectContaining({
          channel: "C123",
          threadTs: "1730000000.000100",
        }),
      }),
    );

    const providerRecords = proxy.records.filter(
      (record) => new URL(record.request.url).pathname !== "/api/chat.postMessage",
    );
    expect(providerRecords.length).toBeGreaterThanOrEqual(2);
    expect(providerRecords.some((record) => record.request.method !== "OPTIONS")).toBe(true);

    const unmatchedCount = proxy.records.filter((record) => record.response.status === 599).length;
    expect(unmatchedCount).toBe(0);
  });
});
