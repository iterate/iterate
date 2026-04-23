/**
 * End-to-end: Events host + Semaphore tunnel + `cloudflared` -> public `wss://` to
 * `IterateAgent` -> lightweight chat agent loop calls Workers AI via
 * `env.AI.run()` routed through the `e2e` AI Gateway.
 *
 * Run: `pnpm test:e2e` with `--tags-filter slow` (from `apps/agents`).
 */
import { expect, test } from "vitest";
import { setupE2E, type E2EContext } from "../test-support/e2e-test.ts";
import { createLocalDevServer } from "../test-support/create-local-dev-server.ts";

const GATEWAY_ID = "e2e";
const AGENT_INPUT_CONTENT = "What is the capital of France? Answer with one word.";

// Only kimi (native Workers AI) is exercised for now.
const SCENARIOS = [{ label: "kimi", model: "@cf/moonshotai/kimi-k2.5" }] as const;

test(
  "websocket subscription drives Workers AI chat loop (kimi) via e2e AI Gateway",
  { tags: ["local-dev-server", "live-internet", "slow"], timeout: 240_000 },
  async (ctx) => {
    const e2e = await setupE2E(ctx);
    const streamPath = e2e.createStreamPath();

    await using server = await createLocalDevServer({
      eventsBaseUrl: e2e.eventsBaseUrl,
      eventsProjectSlug: e2e.runSlug,
      executionSuffix: e2e.executionSuffix,
      streamPath,
      instancePrefix: "e2e-agent-loop",
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

  const agentInstance = `e2e-agent-loop-${scenario.label}-${e2e.executionSuffix}`;
  const callbackUrl = toWssAgentWebsocketUrl(tunnelPublicUrl, agentInstance);

  await e2e.events.append(streamPath, {
    type: "https://events.iterate.com/events/stream/subscription/configured",
    payload: {
      slug: `iterate-agent-agent-loop-ws-${e2e.executionSuffix}`,
      type: "websocket",
      callbackUrl,
    },
  });

  await e2e.events.append(streamPath, {
    type: "llm-config-updated",
    payload: {
      model: scenario.model,
      runOpts: { gateway: { id: GATEWAY_ID } },
    },
  });

  const llmT0 = Date.now();

  await e2e.events.append(streamPath, {
    type: "agent-input-added",
    payload: { role: "user", content: AGENT_INPUT_CONTENT },
  });

  const assistantEvent = await e2e.events.waitForEvent(
    streamPath,
    (event) => {
      if (event.type !== "agent-input-added") return false;
      const payload = event.payload as { role?: string };
      return payload.role === "assistant";
    },
    { timeoutMs: 10_000 },
  );
  const llmMs = Date.now() - llmT0;

  const payload = assistantEvent.payload as { role?: string; content?: string };
  expect(payload.role, `${scenario.label} assistant role`).toBe("assistant");
  expect(typeof payload.content, `${scenario.label} assistant content type`).toBe("string");
  expect(
    (payload.content ?? "").trim().length,
    `${scenario.label} assistant content non-empty`,
  ).toBeGreaterThan(0);

  return {
    label: scenario.label,
    model: scenario.model,
    content: payload.content ?? "",
    llmMs,
  };
}

function toWssAgentWebsocketUrl(httpsBase: string, instanceName: string) {
  const base = new URL(httpsBase);
  base.protocol = "wss:";
  base.pathname = `/agents/iterate-agent/${instanceName}`;
  base.search = "";
  base.hash = "";
  return base.toString();
}
