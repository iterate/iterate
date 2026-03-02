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
  slack: {
    ...ON_DEMAND_PROCESSES_BY_NAME.slack,
    directHttpCheck: { url: "http://127.0.0.1:19063/healthz" },
  },
  agents: {
    ...ON_DEMAND_PROCESSES_BY_NAME.agents,
    directHttpCheck: { url: "http://127.0.0.1:19061/healthz" },
  },
  "pi-wrapper": {
    ...ON_DEMAND_PROCESSES_BY_NAME["pi-wrapper"],
    directHttpCheck: { url: "http://127.0.0.1:19064/healthz" },
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
  options?: {
    envOverrides?: Record<string, string>;
  },
): Promise<void> {
  const processConfig = ON_DEMAND_PROCESSES[processName];
  const definitionEnv = {
    ...processConfig.definition.env,
    ...(options?.envOverrides ?? {}),
  };
  const updated = await deployment.pidnap.processes.updateConfig({
    processSlug: processName,
    definition: {
      ...processConfig.definition,
      env: definitionEnv,
    },
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
    EVENTS_JSON_HEADER,
    "--data",
    JSON.stringify({ json: body }),
    `http://127.0.0.1:19010/orpc/${procedure}`,
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
    `http://127.0.0.1:19010/api/streams/${encoded}`,
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

function sseResponse(events: unknown[]): Response {
  const body =
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

type StreamRecord = { path: string; eventCount: number };

function createFakeOpenAICodexAccessToken(accountId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64");
  const payload = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": {
        chatgpt_account_id: accountId,
      },
    }),
  ).toString("base64");
  return `${header}.${payload}.signature`;
}

async function seedPiCodexAuthFile(
  deployment: ProjectDeployment,
  params: {
    accountId: string;
    authPath?: string;
  },
): Promise<void> {
  const authPath = params.authPath ?? "/var/lib/jonasland/pi-agent/auth.json";
  const accessToken = createFakeOpenAICodexAccessToken(params.accountId);
  const auth = {
    "openai-codex": {
      type: "oauth",
      access: accessToken,
      refresh: "refresh-token-unused-for-e2e",
      expires: 4_102_444_800_000,
      accountId: params.accountId,
    },
  };

  const writeAuth = await deployment.exec([
    "sh",
    "-ec",
    `mkdir -p "$(dirname ${JSON.stringify(authPath)})" && cat > ${JSON.stringify(authPath)} <<'EOF'\n${JSON.stringify(auth, null, 2)}\nEOF`,
  ]);
  if (writeAuth.exitCode !== 0) {
    throw new Error(`failed to seed pi codex auth file: ${writeAuth.output}`);
  }
}

function createPiMockEgressFetch(): (request: Request) => Promise<Response> {
  return async (request) => {
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
      return sseResponse([
        {
          id: "chatcmpl_test",
          object: "chat.completion.chunk",
          created: 1_730_000_001,
          model: "gpt-4o-mini",
          choices: [
            {
              index: 0,
              delta: { content: "The answer is 42" },
              finish_reason: null,
            },
          ],
        },
        {
          id: "chatcmpl_test",
          object: "chat.completion.chunk",
          created: 1_730_000_001,
          model: "gpt-4o-mini",
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 6,
            total_tokens: 18,
          },
        },
      ]);
    }

    if (url.pathname === "/v1/responses") {
      return sseResponse([
        {
          type: "response.output_item.added",
          item: {
            id: "msg_1",
            type: "message",
            status: "in_progress",
            role: "assistant",
            content: [],
          },
        },
        {
          type: "response.content_part.added",
          part: {
            type: "output_text",
            text: "",
            annotations: [],
          },
        },
        {
          type: "response.output_text.delta",
          delta: "The answer is 42",
        },
        {
          type: "response.output_item.done",
          item: {
            id: "msg_1",
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: "The answer is 42", annotations: [] }],
          },
        },
        {
          type: "response.completed",
          response: {
            status: "completed",
            usage: {
              input_tokens: 12,
              output_tokens: 6,
              total_tokens: 18,
              input_tokens_details: { cached_tokens: 0 },
            },
          },
        },
      ]);
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
}

async function postSlackWebhook(
  deployment: ProjectDeployment,
  payload: Record<string, unknown>,
): Promise<string> {
  const webhook = await deployment.exec([
    "curl",
    "-sS",
    "-i",
    "-H",
    "content-type: application/json",
    "--data",
    JSON.stringify(payload),
    "http://127.0.0.1:19063/webhook",
  ]);

  if (!/HTTP\/\d(?:\.\d)? 200/.test(webhook.output)) {
    const logs = await deployment.logs();
    throw new Error(`webhook failed:\n${webhook.output}\n\ncontainer logs:\n${logs}`);
  }

  return webhook.output
    .split(/\r?\n\r?\n/)
    .slice(1)
    .join("\n\n")
    .trim();
}

async function listStreams(deployment: ProjectDeployment): Promise<StreamRecord[]> {
  const listResult = await postEventsOrpc(deployment, "listStreams", {});
  if (listResult.exitCode !== 0) {
    throw new Error(`failed to list streams: ${listResult.output}`);
  }

  const streamsPayload = JSON.parse(listResult.output) as { json: StreamRecord[] };
  return streamsPayload.json;
}

async function waitForPiAgentStream(deployment: ProjectDeployment): Promise<StreamRecord> {
  let streams: StreamRecord[] = [];
  const streamsDeadline = Date.now() + 20_000;
  while (Date.now() < streamsDeadline) {
    streams = await listStreams(deployment);
    const stream = streams.find((value) => value.path.startsWith("/agents/pi/"));
    if (stream) return stream;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(`available streams: ${JSON.stringify(streams.map((stream) => stream.path))}`);
}

function isAgentOutputEvent(event: Record<string, unknown>): boolean {
  return (
    event["type"] === "https://events.iterate.com/agents/status-updated" ||
    event["type"] === "https://events.iterate.com/agents/response-added" ||
    event["type"] === "https://events.iterate.com/agents/error"
  );
}

async function waitForPromptCount(
  deployment: ProjectDeployment,
  streamPath: string,
  minimumPromptCount: number,
): Promise<Array<Record<string, unknown>>> {
  let agentEvents: Array<Record<string, unknown>> = [];
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    agentEvents = await readStreamEvents(deployment, streamPath);
    const promptCount = agentEvents.filter(
      (event) => event["type"] === "https://events.iterate.com/agents/prompt-added",
    ).length;
    const hasOutput = agentEvents.some((event) => isAgentOutputEvent(event));
    if (promptCount >= minimumPromptCount && hasOutput) {
      return agentEvents;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(`timed out waiting for ${String(minimumPromptCount)} prompt events`);
}

describe.runIf(RUN_E2E)("jonasland slack webhook flow (pi)", () => {
  test("slack webhook goes through events mediation, triggers pi sdk call, and posts slack updates", async () => {
    await using proxy = await mockEgressProxy();
    proxy.fetch = createPiMockEgressFetch();

    await using deployment = await projectDeployment({
      image,
      name: `jonasland-e2e-slack-pi-${randomUUID()}`,
      extraHosts: ["host.docker.internal:host-gateway"],
      runtimeProcessTargets: ["caddy", "registry", "events"],
      env: {
        ITERATE_EXTERNAL_EGRESS_PROXY: proxy.proxyUrl,
      },
    });

    await startOnDemandProcess(deployment, "egress-proxy");
    await startOnDemandProcess(deployment, "agents");
    await startOnDemandProcess(deployment, "pi-wrapper");
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

    const webhookResponseBody = await postSlackWebhook(deployment, webhookPayload);
    expect(webhookResponseBody).toContain('"streamPath":"/integrations/slack/webhooks"');

    const slackRecords = proxy.records.filter(
      (record) => new URL(record.request.url).pathname === "/api/chat.postMessage",
    );
    if (slackRecords.length > 0) {
      const slackBodies = await Promise.all(
        slackRecords.map(
          async (record) => (await record.request.json()) as Record<string, unknown>,
        ),
      );
      expect(
        slackBodies.every(
          (body) => body.channel === "C123" && body.thread_ts === "1730000000.000100",
        ),
      ).toBe(true);
    }

    const agentStream = await waitForPiAgentStream(deployment);

    let agentEvents: Array<Record<string, unknown>> = [];
    let hasStatusEvent = false;
    let hasResponseEvent = false;
    let hasErrorEvent = false;
    const agentEventsDeadline = Date.now() + 90_000;
    while (Date.now() < agentEventsDeadline) {
      agentEvents = await readStreamEvents(deployment, agentStream.path);
      hasStatusEvent = agentEvents.some(
        (event) => event["type"] === "https://events.iterate.com/agents/status-updated",
      );
      hasResponseEvent = agentEvents.some(
        (event) => event["type"] === "https://events.iterate.com/agents/response-added",
      );
      hasErrorEvent = agentEvents.some(
        (event) => event["type"] === "https://events.iterate.com/agents/error",
      );

      if (
        agentEvents.some(
          (event) => event["type"] === "https://events.iterate.com/agents/prompt-added",
        ) &&
        (hasStatusEvent || hasResponseEvent || hasErrorEvent)
      ) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(
      agentEvents.some(
        (event) => event["type"] === "https://events.iterate.com/agents/prompt-added",
      ),
    ).toBe(true);
    if (!(hasStatusEvent || hasResponseEvent || hasErrorEvent)) {
      const logs = await deployment.logs();
      throw new Error(
        `agent events missing output:\n${JSON.stringify(agentEvents, null, 2)}\n\nlogs:\n${logs}`,
      );
    }

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

    let providerRecords: typeof proxy.records = [];
    const providerDeadline = Date.now() + 90_000;
    while (Date.now() < providerDeadline) {
      providerRecords = proxy.records.filter(
        (record) => new URL(record.request.url).pathname !== "/api/chat.postMessage",
      );
      if (providerRecords.length > 0) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (providerRecords.length < 1) {
      agentEvents = await readStreamEvents(deployment, agentStream.path);
      const logs = await deployment.logs();
      throw new Error(
        `expected at least one provider request, got none.\nagent events:\n${JSON.stringify(agentEvents, null, 2)}\n\nlogs:\n${logs}`,
      );
    }
    expect(providerRecords.some((record) => record.request.method !== "OPTIONS")).toBe(true);

    const unmatchedCount = proxy.records.filter((record) => record.response.status === 599).length;
    expect(unmatchedCount).toBe(0);
  }, 240_000);

  test("slack webhook supports multi-turn in one thread and reuses the same pi agent stream", async () => {
    await using proxy = await mockEgressProxy();
    proxy.fetch = createPiMockEgressFetch();

    await using deployment = await projectDeployment({
      image,
      name: `jonasland-e2e-slack-pi-multiturn-${randomUUID()}`,
      extraHosts: ["host.docker.internal:host-gateway"],
      runtimeProcessTargets: ["caddy", "registry", "events"],
      env: {
        ITERATE_EXTERNAL_EGRESS_PROXY: proxy.proxyUrl,
      },
    });

    await startOnDemandProcess(deployment, "egress-proxy");
    await startOnDemandProcess(deployment, "agents");
    await startOnDemandProcess(deployment, "pi-wrapper");
    await startOnDemandProcess(deployment, "slack");

    const firstPrompt = "<@BOT> please summarize the problem";
    const secondPrompt = "<@BOT> now give me one concrete action item";

    const firstWebhookBody = await postSlackWebhook(deployment, {
      event: {
        type: "app_mention",
        user: "U123",
        text: firstPrompt,
        channel: "C123",
        ts: "1730000000.000100",
        thread_ts: "1730000000.000100",
      },
    });
    expect(firstWebhookBody).toContain('"streamPath":"/integrations/slack/webhooks"');

    const agentStream = await waitForPiAgentStream(deployment);
    let events = await waitForPromptCount(deployment, agentStream.path, 1);
    expect(
      events.some((event) => {
        if (event["type"] !== "https://events.iterate.com/agents/prompt-added") return false;
        const payload = event["payload"] as { prompt?: unknown } | undefined;
        return payload?.prompt === firstPrompt;
      }),
    ).toBe(true);

    const providerRecordsAfterFirstTurn = proxy.records.filter((record) => {
      const path = new URL(record.request.url).pathname;
      return path !== "/api/chat.postMessage" && record.request.method !== "OPTIONS";
    }).length;
    expect(providerRecordsAfterFirstTurn).toBeGreaterThan(0);

    const secondWebhookBody = await postSlackWebhook(deployment, {
      event: {
        type: "app_mention",
        user: "U123",
        text: secondPrompt,
        channel: "C123",
        ts: "1730000000.000200",
        thread_ts: "1730000000.000100",
      },
    });
    expect(secondWebhookBody).toContain('"streamPath":"/integrations/slack/webhooks"');

    events = await waitForPromptCount(deployment, agentStream.path, 2);
    const promptEvents = events.filter(
      (event) => event["type"] === "https://events.iterate.com/agents/prompt-added",
    );
    const promptTexts = promptEvents
      .map((event) => (event["payload"] as { prompt?: unknown } | undefined)?.prompt)
      .filter((prompt): prompt is string => typeof prompt === "string");
    expect(promptTexts).toContain(firstPrompt);
    expect(promptTexts).toContain(secondPrompt);

    let providerRecordsAfterSecondTurn = providerRecordsAfterFirstTurn;
    const providerDeadline = Date.now() + 90_000;
    while (Date.now() < providerDeadline) {
      providerRecordsAfterSecondTurn = proxy.records.filter((record) => {
        const path = new URL(record.request.url).pathname;
        return path !== "/api/chat.postMessage" && record.request.method !== "OPTIONS";
      }).length;
      if (providerRecordsAfterSecondTurn > providerRecordsAfterFirstTurn) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(providerRecordsAfterSecondTurn).toBeGreaterThan(providerRecordsAfterFirstTurn);

    const streams = await listStreams(deployment);
    const piAgentStreams = streams.filter((stream) => stream.path.startsWith("/agents/pi/"));
    expect(piAgentStreams.length).toBe(1);
    expect(piAgentStreams[0]?.path).toBe(agentStream.path);

    const slackRecords = proxy.records.filter(
      (record) => new URL(record.request.url).pathname === "/api/chat.postMessage",
    );
    if (slackRecords.length > 0) {
      const slackBodies = await Promise.all(
        slackRecords.map(
          async (record) => (await record.request.json()) as Record<string, unknown>,
        ),
      );
      expect(
        slackBodies.every(
          (body) => body.channel === "C123" && body.thread_ts === "1730000000.000100",
        ),
      ).toBe(true);
    }

    const unmatchedCount = proxy.records.filter((record) => record.response.status === 599).length;
    expect(unmatchedCount).toBe(0);
  }, 300_000);

  test("pi openai-codex websocket transport is mocked end-to-end from slack webhook to slack reply", async () => {
    await using proxy = await mockEgressProxy();

    proxy.fetch = async (request) => {
      const url = new URL(request.url);

      if (url.pathname === "/api/chat.postMessage") {
        return Response.json({ ok: true, ts: "123.456" });
      }

      if (url.pathname === "/backend-api/codex/responses") {
        return Response.json(
          { error: "expected websocket transport, received http fallback" },
          { status: 500 },
        );
      }

      return Response.json({ ok: true });
    };

    proxy.websocket = ({ request, socket }) => {
      const path = new URL(request.url).pathname;
      if (path !== "/backend-api/codex/responses") {
        socket.close(1008, `unexpected websocket path: ${path}`);
        return;
      }

      socket.on("message", (raw: Buffer) => {
        const text = Buffer.from(raw).toString("utf-8");
        const parsed = JSON.parse(text) as { type?: unknown; model?: unknown };
        if (parsed.type !== "response.create") return;

        socket.send(
          JSON.stringify({
            type: "response.output_item.added",
            item: {
              id: "msg_1",
              type: "message",
              status: "in_progress",
              role: "assistant",
              content: [],
            },
          }),
        );
        socket.send(
          JSON.stringify({
            type: "response.content_part.added",
            part: {
              type: "output_text",
              text: "",
              annotations: [],
            },
          }),
        );
        socket.send(
          JSON.stringify({
            type: "response.output_text.delta",
            delta: "The answer is 42 over websocket",
          }),
        );
        socket.send(
          JSON.stringify({
            type: "response.output_item.done",
            item: {
              id: "msg_1",
              type: "message",
              status: "completed",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: "The answer is 42 over websocket",
                  annotations: [],
                },
              ],
            },
          }),
        );
        socket.send(
          JSON.stringify({
            type: "response.completed",
            response: {
              status: "completed",
              usage: {
                input_tokens: 10,
                output_tokens: 8,
                total_tokens: 18,
                input_tokens_details: { cached_tokens: 0 },
              },
            },
          }),
        );
        socket.close(1000, "done");
      });
    };

    await using deployment = await projectDeployment({
      image,
      name: `jonasland-e2e-slack-pi-websocket-${randomUUID()}`,
      extraHosts: ["host.docker.internal:host-gateway"],
      runtimeProcessTargets: ["caddy", "registry", "events"],
      env: {
        ITERATE_EXTERNAL_EGRESS_PROXY: proxy.proxyUrl,
      },
    });

    await startOnDemandProcess(deployment, "egress-proxy");
    await startOnDemandProcess(deployment, "agents");
    await seedPiCodexAuthFile(deployment, { accountId: "acct_e2e_codex" });
    await startOnDemandProcess(deployment, "pi-wrapper", {
      envOverrides: {
        PI_MODEL_PROVIDER: "openai-codex",
        PI_MODEL_ID: "gpt-5.1-codex-mini",
        PI_MODEL_TRANSPORT: "websocket",
      },
    });
    await startOnDemandProcess(deployment, "slack");

    const webhookResponseBody = await postSlackWebhook(deployment, {
      event: {
        type: "app_mention",
        user: "U123",
        text: "<@BOT> answer in one sentence",
        channel: "C123",
        ts: "1730000000.000250",
        thread_ts: "1730000000.000250",
      },
    });
    expect(webhookResponseBody).toContain('"streamPath":"/integrations/slack/webhooks"');

    const agentStream = await waitForPiAgentStream(deployment);
    const events = await waitForPromptCount(deployment, agentStream.path, 1);
    expect(events.some((event) => isAgentOutputEvent(event))).toBe(true);

    let wsRecord = proxy.wsRecords.find(
      (record) => new URL(record.request.url).pathname === "/backend-api/codex/responses",
    );
    const wsDeadline = Date.now() + 90_000;
    while (!wsRecord && Date.now() < wsDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      wsRecord = proxy.wsRecords.find(
        (record) => new URL(record.request.url).pathname === "/backend-api/codex/responses",
      );
    }
    if (!wsRecord) {
      const providerHttpPaths = proxy.records
        .map((record) => new URL(record.request.url).pathname)
        .filter((path, index, values) => values.indexOf(path) === index);
      throw new Error(
        `expected codex websocket traffic, got none.\nhttp paths: ${JSON.stringify(providerHttpPaths)}\nagent events: ${JSON.stringify(events, null, 2)}`,
      );
    }

    const inboundCreate = wsRecord?.messages.find((message) => {
      if (message.direction !== "inbound") return false;
      try {
        const payload = JSON.parse(message.text) as { type?: unknown };
        return payload.type === "response.create";
      } catch {
        return false;
      }
    });
    expect(inboundCreate).toBeDefined();
    if (inboundCreate) {
      const payload = JSON.parse(inboundCreate.text) as { model?: unknown };
      expect(payload.model).toBe("gpt-5.1-codex-mini");
    }

    const outboundCompleted = wsRecord?.messages.some((message) => {
      if (message.direction !== "outbound") return false;
      try {
        const payload = JSON.parse(message.text) as { type?: unknown };
        return payload.type === "response.completed";
      } catch {
        return false;
      }
    });
    expect(outboundCompleted).toBe(true);

    const codexHttpFallbacks = proxy.records.filter(
      (record) => new URL(record.request.url).pathname === "/backend-api/codex/responses",
    );
    expect(codexHttpFallbacks).toHaveLength(0);

    const unmatchedCount = proxy.records.filter((record) => record.response.status === 599).length;
    expect(unmatchedCount).toBe(0);
  }, 300_000);

  test("pi tool call can generate a local image and slack uploads it to the thread", async () => {
    await using proxy = await mockEgressProxy();

    const imagePath = "/tmp/slack-tool-image.png";
    const imagePngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO1ZkZQAAAAASUVORK5CYII=";
    const bashCommand = `printf %s ${imagePngBase64} | base64 -d > ${imagePath}`;
    let responsesCallCount = 0;

    proxy.fetch = async (request) => {
      const url = new URL(request.url);

      if (url.pathname === "/api/chat.postMessage") {
        return Response.json({ ok: true, ts: "123.456" });
      }

      if (url.pathname === "/api/files.upload") {
        return Response.json({ ok: true, file: { id: "F_TEST_IMAGE" } });
      }

      if (url.pathname === "/v1/models") {
        return Response.json({
          object: "list",
          data: [{ id: "gpt-4o-mini", object: "model" }],
        });
      }

      if (url.pathname === "/v1/responses") {
        responsesCallCount += 1;

        if (responsesCallCount === 1) {
          const argumentsJson = JSON.stringify({ command: bashCommand });
          return sseResponse([
            {
              type: "response.output_item.added",
              output_index: 0,
              item: {
                id: "fc_1",
                type: "function_call",
                status: "in_progress",
                name: "bash",
                call_id: "call_1",
                arguments: "",
              },
            },
            {
              type: "response.function_call_arguments.delta",
              output_index: 0,
              item_id: "fc_1",
              delta: argumentsJson,
            },
            {
              type: "response.function_call_arguments.done",
              output_index: 0,
              item_id: "fc_1",
              arguments: argumentsJson,
            },
            {
              type: "response.output_item.done",
              output_index: 0,
              item: {
                id: "fc_1",
                type: "function_call",
                status: "completed",
                name: "bash",
                call_id: "call_1",
                arguments: argumentsJson,
              },
            },
            {
              type: "response.completed",
              response: {
                status: "completed",
                usage: {
                  input_tokens: 20,
                  output_tokens: 8,
                  total_tokens: 28,
                  input_tokens_details: { cached_tokens: 0 },
                },
              },
            },
          ]);
        }

        return sseResponse([
          {
            type: "response.output_item.added",
            item: {
              id: "msg_1",
              type: "message",
              status: "in_progress",
              role: "assistant",
              content: [],
            },
          },
          {
            type: "response.content_part.added",
            part: {
              type: "output_text",
              text: "",
              annotations: [],
            },
          },
          {
            type: "response.output_text.delta",
            delta: `Generated image: ${imagePath}`,
          },
          {
            type: "response.output_item.done",
            item: {
              id: "msg_1",
              type: "message",
              status: "completed",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: `Generated image: ${imagePath}`,
                  annotations: [],
                },
              ],
            },
          },
          {
            type: "response.completed",
            response: {
              status: "completed",
              usage: {
                input_tokens: 24,
                output_tokens: 12,
                total_tokens: 36,
                input_tokens_details: { cached_tokens: 0 },
              },
            },
          },
        ]);
      }

      return Response.json({ ok: true });
    };

    await using deployment = await projectDeployment({
      image,
      name: `jonasland-e2e-slack-pi-tool-image-${randomUUID()}`,
      extraHosts: ["host.docker.internal:host-gateway"],
      runtimeProcessTargets: ["caddy", "registry", "events"],
      env: {
        ITERATE_EXTERNAL_EGRESS_PROXY: proxy.proxyUrl,
      },
    });

    await startOnDemandProcess(deployment, "egress-proxy");
    await startOnDemandProcess(deployment, "agents");
    await startOnDemandProcess(deployment, "pi-wrapper");
    await startOnDemandProcess(deployment, "slack");

    const webhookResponseBody = await postSlackWebhook(deployment, {
      event: {
        type: "app_mention",
        user: "U123",
        text: "<@BOT> use bash to create a tiny PNG at /tmp/slack-tool-image.png and share it",
        channel: "C123",
        ts: "1730000000.000300",
        thread_ts: "1730000000.000300",
      },
    });
    expect(webhookResponseBody).toContain('"streamPath":"/integrations/slack/webhooks"');

    const agentStream = await waitForPiAgentStream(deployment);
    const events = await waitForPromptCount(deployment, agentStream.path, 1);
    expect(
      events.some((event) => event["type"] === "https://events.iterate.com/agents/prompt-added"),
    ).toBe(true);
    expect(
      events.some((event) => {
        if (event["type"] !== "https://events.iterate.com/agents/status-updated") return false;
        const payload = event["payload"] as { phase?: unknown; text?: unknown } | undefined;
        return payload?.phase === "tool-running" && typeof payload?.text === "string";
      }),
    ).toBe(true);
    expect(
      events.some((event) => {
        if (event["type"] !== "https://events.iterate.com/agents/response-added") return false;
        const payload = event["payload"] as { text?: unknown } | undefined;
        return payload?.text === `Generated image: ${imagePath}`;
      }),
    ).toBe(true);

    let fileUploadRecord: (typeof proxy.records)[number] | undefined;
    const fileUploadDeadline = Date.now() + 90_000;
    while (Date.now() < fileUploadDeadline) {
      fileUploadRecord = proxy.records.find((record) =>
        new URL(record.request.url).pathname.endsWith("/files.upload"),
      );
      if (fileUploadRecord) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(fileUploadRecord).toBeDefined();

    if (fileUploadRecord) {
      const formData = await fileUploadRecord.request.formData();
      expect(formData.get("channels")).toBe("C123");
      expect(formData.get("thread_ts")).toBe("1730000000.000300");
      expect(formData.get("filename")).toBe("slack-tool-image.png");
    }

    expect(responsesCallCount).toBeGreaterThanOrEqual(2);

    const unmatchedCount = proxy.records.filter((record) => record.response.status === 599).length;
    expect(unmatchedCount).toBe(0);
  }, 300_000);
});
