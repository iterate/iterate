/**
 * Legacy end-to-end coverage for the deleted monolithic `IterateAgent`.
 *
 * Kept skipped while the equivalent coverage is rebuilt around the Webchat,
 * Agent, and Codemode stream processor runners.
 *
 * Run: `pnpm test:e2e` with `--tags-filter slow` (from `apps/agents`).
 */
import { expect, test } from "vitest";
import { setupE2E, type E2EContext } from "../test-support/e2e-test.ts";
import { createLocalDevServer } from "../test-support/create-local-dev-server.ts";
import {
  buildAgentStreamProcessorRunnerWebSocketCallbackUrl,
  streamPathToAgentInstance,
} from "~/lib/iterate-agent-addressing.ts";

const GATEWAY_ID = "e2e";
const AGENT_INPUT_CONTENT = "What is the capital of France? Answer with one word.";

// Only kimi (native Workers AI) is exercised for now.
const SCENARIOS = [{ label: "kimi", model: "@cf/moonshotai/kimi-k2.5" }] as const;

test.skip(
  "websocket subscription drives Workers AI chat loop (kimi) via e2e AI Gateway",
  { tags: ["local-dev-server", "live-internet", "slow"], timeout: 240_000 },
  async (ctx) => {
    const e2e = await setupE2E(ctx);
    const streamPath = e2e.createStreamPath();

    await using server = await createLocalDevServer({
      eventsBaseUrl: e2e.eventsBaseUrl,
      eventsProjectSlug: e2e.runSlug,
      streamPath,
    });

    const results = await Promise.all(
      SCENARIOS.map((scenario) =>
        runScenario({ scenario, e2e, tunnelPublicUrl: server.publicUrl }),
      ),
    );

    for (const result of results) {
      expect(result.content, `${result.label} reply should mention Paris`).toMatch(/paris/i);
    }

    console.info("[iterate-agent agent-loop e2e] replies:\n", JSON.stringify(results, null, 2));
  },
);

async function runScenario(args: {
  scenario: (typeof SCENARIOS)[number];
  e2e: E2EContext;
  tunnelPublicUrl: string;
}) {
  const { scenario, e2e, tunnelPublicUrl } = args;
  const streamPath = e2e.createStreamPath({ suffix: scenario.label });
  const viewerUrl = e2e.events.streamViewerUrl(streamPath);
  console.info(`[iterate-agent agent-loop e2e] ${scenario.label} stream: ${viewerUrl}`);

  const websocketUrl = buildAgentStreamProcessorRunnerWebSocketCallbackUrl({
    publicOrigin: tunnelPublicUrl,
    runnerInstance: streamPathToAgentInstance(streamPath),
    streamPath,
  });

  await e2e.events.append(streamPath, {
    type: "events.iterate.com/core/subscription-configured",
    payload: {
      slug: `iterate-agent-agent-loop-ws-${e2e.executionSuffix}`,
      type: "websocket",
      callable: fetchCallableFromWebSocketUrl(websocketUrl),
    },
  });

  await e2e.events.append(streamPath, {
    type: "events.iterate.com/agent/llm-config-updated",
    payload: {
      model: scenario.model,
      runOpts: { gateway: { id: GATEWAY_ID } },
    },
  });

  const llmT0 = Date.now();

  await e2e.events.append(streamPath, {
    type: "events.iterate.com/agent/input-added",
    payload: { content: AGENT_INPUT_CONTENT },
  });

  const webchatEvent = await e2e.events.waitForEvent(
    streamPath,
    (event) => {
      if (event.type !== "events.iterate.com/agent-chat/assistant-response-added") return false;
      const payload = event.payload as { message?: string };
      return typeof payload.message === "string" && payload.message.trim().length > 0;
    },
    { timeoutMs: 45_000 },
  );
  const llmMs = Date.now() - llmT0;

  const payload = webchatEvent.payload as { message?: string };
  expect(typeof payload.message, `${scenario.label} webchat message type`).toBe("string");
  expect(
    (payload.message ?? "").trim().length,
    `${scenario.label} webchat message non-empty`,
  ).toBeGreaterThan(0);

  return {
    label: scenario.label,
    model: scenario.model,
    content: payload.message ?? "",
    llmMs,
  };
}

function fetchCallableFromWebSocketUrl(websocketUrl: string) {
  const url = new URL(websocketUrl);
  if (url.protocol === "ws:") {
    url.protocol = "http:";
  } else if (url.protocol === "wss:") {
    url.protocol = "https:";
  }

  return {
    type: "fetch" as const,
    via: {
      type: "url" as const,
      url: url.toString(),
    },
  };
}
