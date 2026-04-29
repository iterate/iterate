/**
 * End-to-end: Events host + Semaphore tunnel + `cloudflared` → public `wss://` to
 * `IterateAgent` → lightweight chat agent loop calls Workers AI via
 * `env.AI.run()` routed through the `e2e` AI Gateway → emits an
 * `agent-input-added` event with role `assistant` carrying the model's reply.
 *
 * Runs one scenario today (`kimi` → `@cf/moonshotai/kimi-k2.6`), with the
 * test scaffolding shaped as a `Promise.all` over `SCENARIOS` so `openai/*` and
 * `anthropic/*` rows can be added back once caching works for them (see the
 * comment above `SCENARIOS` below).
 *
 * The scenario owns its own Events stream + DurableObject instance, and sends
 * an `llm-config-updated` event to override the processor's default model.
 * `runOpts: { gateway: { id: "e2e" } }` routes the call through the `e2e` AI
 * Gateway, which has `cache_ttl: 3600` set at the gateway level — so repeat
 * runs hit the cache and complete in ~10ms of LLM time.
 *
 * Requires live Workers AI access (CF account token + account ID, same as
 * `pnpm dev`) and the Events worker at `EVENTS_BASE_URL` deployed so its
 * outbound WebSocket subscriber can deliver events back to the local Agents
 * worker across the tunnel.
 *
 * Run: `pnpm test:e2e:agent-loop` (from `apps/agents`).
 */
import { fileURLToPath } from "node:url";
import { type StreamPath } from "@iterate-com/events-contract";
import {
  useCloudflareTunnel,
  useCloudflareTunnelLease,
  useDevServer,
} from "@iterate-com/shared/test-helpers";
import { describe, expect, test } from "vitest";
import { injectVitestRunSlug } from "../test-support/vitest-inject-run-slug.ts";
import {
  createEventsStreamPath,
  createTestExecutionSuffix,
} from "../test-support/vitest-naming.ts";
import {
  eventsIterateStreamViewerUrl,
  waitForStreamEvent,
} from "../test-support/events-stream-helpers.ts";
import { requireSemaphoreE2eEnv } from "../test-support/require-semaphore-e2e-env.ts";
import { createEventsOrpcClient } from "../../src/lib/events-orpc-client.ts";

requireSemaphoreE2eEnv(process.env);

const appRoot = fileURLToPath(new URL("../..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));

const GATEWAY_ID = "e2e";

// Deterministic prompt picked because the answer is short and unambiguous —
// any reasonable frontier chat model will mention "Paris".
const AGENT_INPUT_CONTENT = "What is the capital of France? Answer with one word.";

// Only kimi (native Workers AI) is exercised for now. `openai/*` and
// `anthropic/*` both work end-to-end via `env.AI.run()` + Unified Billing, but
// they route through Cloudflare's internal `/run` (wholesale) dispatcher which
// the AI Gateway cache layer does not currently key on — so repeat runs always
// hit the upstream provider and burn Unified Billing credits. Native
// `@cf/*` calls cache normally (`cached=true` on the second run, ~10ms).
//
// To re-enable third-party providers with working caching, switch the
// processor to the HTTP gateway endpoint (`https://gateway.ai.cloudflare.com/
// v1/{acct}/{gw}/compat/chat/completions`) authed with
// `cf-aig-authorization: Bearer $CLOUDFLARE_API_TOKEN` — that path supports
// both Unified Billing and caching for every provider. Then add
// `openai/gpt-5.4` and `anthropic/claude-opus-4.7` back to this list.
const SCENARIOS = [{ label: "kimi", model: "@cf/moonshotai/kimi-k2.6" }] as const;

describe.sequential("agents iterate-agent agent loop e2e", () => {
  test.skipIf(process.env.AGENTS_E2E_ITERATE_AGENT !== "1")(
    "websocket subscription drives Workers AI chat loop (kimi) via e2e AI Gateway",
    async ({ task }) => {
      const vitestRunSlug = injectVitestRunSlug();
      const eventsBaseUrl = resolveEventsBaseUrl();

      await using tunnelLease = await useCloudflareTunnelLease({});

      await using _devServer = await useDevServer({
        cwd: appRoot,
        command: "pnpm",
        args: ["exec", "tsx", "./alchemy.run.ts"],
        port: tunnelLease.localPort,
        env: {
          ...stripInheritedAppConfig(process.env),
          APP_CONFIG_EVENTS_BASE_URL: eventsBaseUrl,
          APP_CONFIG_EVENTS_PROJECT_SLUG: vitestRunSlug,
        },
      });
      console.info(`[iterate-agent agent-loop e2e] Agents dev server: ${_devServer.baseUrl}`);

      await using tunnel = await useCloudflareTunnel({
        token: tunnelLease.tunnelToken,
        publicUrl: tunnelLease.publicUrl,
      });

      const results = await Promise.all(
        SCENARIOS.map((scenario) =>
          runScenario({
            scenario,
            taskFilePath: task.file.filepath,
            taskFullName: task.fullName,
            eventsBaseUrl,
            vitestRunSlug,
            tunnelPublicUrl: tunnel.publicUrl,
          }),
        ),
      );

      for (const result of results) {
        expect(result.content, `${result.label} reply should mention Paris`).toMatch(/paris/i);
      }

      console.info("[iterate-agent agent-loop e2e] replies:\n", JSON.stringify(results, null, 2));
    },
    240_000,
  );
});

async function runScenario(args: {
  scenario: (typeof SCENARIOS)[number];
  taskFilePath: string;
  taskFullName: string;
  eventsBaseUrl: string;
  vitestRunSlug: string;
  tunnelPublicUrl: string;
}) {
  const { scenario, eventsBaseUrl, vitestRunSlug, tunnelPublicUrl } = args;
  const executionSuffix = `${createTestExecutionSuffix()}-${scenario.label}`;
  const streamPath = createEventsStreamPath({
    repoRoot,
    testFilePath: args.taskFilePath,
    testFullName: `${args.taskFullName} > ${scenario.label}`,
    executionSuffix,
  }) as StreamPath;
  const streamViewerUrl = eventsIterateStreamViewerUrl({
    eventsOrigin: eventsBaseUrl,
    projectSlug: vitestRunSlug,
    streamPath,
  });
  console.info(`[iterate-agent agent-loop e2e] ${scenario.label} stream: ${streamViewerUrl}`);

  const agentInstance = `e2e-agent-loop-${scenario.label}-${executionSuffix}`;
  const callbackUrl = toWssAgentWebsocketUrl(tunnelPublicUrl, agentInstance);

  const eventsClient = createEventsOrpcClient({
    baseUrl: eventsBaseUrl,
    projectSlug: vitestRunSlug,
  });

  await eventsClient.append({
    path: streamPath,
    event: {
      type: "https://events.iterate.com/events/stream/subscription/configured",
      payload: {
        slug: `iterate-agent-agent-loop-ws-${executionSuffix}`,
        type: "websocket",
        callbackUrl,
      },
    },
  });

  await eventsClient.append({
    path: streamPath,
    event: {
      type: "llm-config-updated",
      payload: {
        model: scenario.model,
        runOpts: { gateway: { id: GATEWAY_ID } },
      },
    },
  });

  const llmT0 = Date.now();

  await eventsClient.append({
    path: streamPath,
    event: {
      type: "agent-input-added",
      payload: { role: "user", content: AGENT_INPUT_CONTENT },
    },
  });

  const assistantEvent = await waitForStreamEvent({
    client: eventsClient,
    path: streamPath,
    predicate: (event) => {
      if (event.type !== "agent-input-added") return false;
      const payload = event.payload as { role?: string };
      return payload.role === "assistant";
    },
    timeoutMs: 10_000,
  });
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

function resolveEventsBaseUrl() {
  return process.env.EVENTS_BASE_URL?.trim().replace(/\/+$/, "") || "https://events.iterate.com";
}

function stripInheritedAppConfig(env: NodeJS.ProcessEnv) {
  const next = { ...env };

  for (const key of Object.keys(next)) {
    if (key === "APP_CONFIG" || key.startsWith("APP_CONFIG_")) {
      delete next[key];
    }
  }

  return next;
}
