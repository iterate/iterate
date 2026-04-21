/**
 * End-to-end: Events host + Semaphore tunnel + `cloudflared` → public `wss://` to
 * `IterateAgent` → lightweight chat agent loop calls Workers AI
 * (`@cf/moonshotai/kimi-k2.5` via `env.AI.run`) → emits an `agent-input-added`
 * event with role `assistant` carrying the model's reply.
 *
 * The Workers AI call happens via the native service binding, bypassing the
 * `APP_CONFIG_EXTERNAL_EGRESS_PROXY` `globalThis.fetch` override entirely, so
 * there is no HAR replay here. The test needs live Workers AI access (account
 * token + account ID from Doppler — same as `pnpm dev`). AI output is
 * non-deterministic, so the assertion only checks that the assistant reply
 * arrives and is non-empty.
 *
 * Sibling to `iterate-agent.e2e.test.ts` (codemode loop) — same tunnel/dev-server
 * scaffolding, different event flow.
 *
 * Requires the Events worker at `EVENTS_BASE_URL` to be deployed so that its
 * outbound WebSocket subscriber can deliver `agent-input-added` back to the
 * local Agents worker across the tunnel.
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

// Deterministic prompt picked because the answer is short and unambiguous —
// any reasonable Kimi K2.5 output will mention "Paris".
const AGENT_INPUT_CONTENT = "What is the capital of France? Answer with one word.";

describe.sequential("agents iterate-agent agent loop e2e", () => {
  test.skipIf(process.env.AGENTS_E2E_ITERATE_AGENT !== "1")(
    "websocket subscription drives Workers AI chat loop (kimi-k2.5)",
    async ({ task }) => {
      const vitestRunSlug = injectVitestRunSlug();
      const executionSuffix = createTestExecutionSuffix();
      const streamPath = createEventsStreamPath({
        repoRoot,
        testFilePath: task.file.filepath,
        testFullName: task.fullName,
        executionSuffix,
      }) as StreamPath;
      const eventsBaseUrl = resolveEventsBaseUrl();
      const streamViewerUrl = eventsIterateStreamViewerUrl({
        eventsOrigin: eventsBaseUrl,
        projectSlug: vitestRunSlug,
        streamPath,
      });
      console.info(`[iterate-agent agent-loop e2e] Events stream: ${streamViewerUrl}`);

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

      const agentInstance = `e2e-agent-loop-${executionSuffix}`;
      const callbackUrl = toWssAgentWebsocketUrl(tunnel.publicUrl, agentInstance);

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
          type: "agent-input-added",
          payload: {
            role: "user",
            content: AGENT_INPUT_CONTENT,
          },
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
        timeoutMs: 90_000,
      });

      const payload = assistantEvent.payload as { role?: string; content?: string };
      expect(payload.role).toBe("assistant");
      expect(typeof payload.content).toBe("string");
      expect((payload.content ?? "").trim().length).toBeGreaterThan(0);
      // Soft sanity check — Kimi K2.5 is more than capable of answering this.
      expect(payload.content ?? "").toMatch(/paris/i);

      console.info(
        "[iterate-agent agent-loop e2e] assistant reply:\n",
        JSON.stringify(
          {
            role: payload.role,
            contentPreview: (payload.content ?? "").slice(0, 200),
            contentChars: (payload.content ?? "").length,
          },
          null,
          2,
        ),
      );
    },
    120_000,
  );
});

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
