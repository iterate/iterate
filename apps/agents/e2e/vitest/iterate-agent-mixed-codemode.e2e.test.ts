/**
 * Single `codemode-block-added` script that exercises **multiple provider kinds** in one run:
 * - `builtin` (inline fns)
 * - `events` (OpenAPI-backed)
 * - `cloudflare_docs` (MCP)
 * - global `fetch` (egress via mock proxy)
 *
 * Re-record fixture: `pnpm test:e2e:record-har-mixed` (from `apps/agents`, Doppler + network).
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectSlug, type StreamPath } from "@iterate-com/events-contract";
import {
  fromTrafficWithWebSocket,
  type HarWithExtensions,
  useMockHttpServer,
} from "@iterate-com/mock-http-proxy";
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
import { mcpStreamableHttpGetStubHandlers } from "../test-support/mcp-streamable-http-get-stub-handlers.ts";
import { prepareAgentsHarForReplay } from "../test-support/prepare-agents-har-for-replay.ts";
import { requireSemaphoreE2eEnv } from "../test-support/require-semaphore-e2e-env.ts";
import { createEventsOrpcClient } from "../../src/lib/events-orpc-client.ts";
import { getProjectUrl } from "../../../events/src/lib/project-slug.ts";

requireSemaphoreE2eEnv(process.env);

const appRoot = fileURLToPath(new URL("../..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));

const harFixturePath = join(appRoot, "e2e/fixtures/iterate-agent-mixed-codemode.har");
const recordHar = process.env.AGENTS_E2E_RECORD_HAR === "1";
const harFixturePresent = existsSync(harFixturePath);

const shouldRunMixedCodemodeTest = recordHar || harFixturePresent;

const MIXED_CODEMODE_SCRIPT = `
async () => {
  const answer = await builtin.answer();
  const exampleRes = await fetch("https://example.com/");
  const exampleBody = await exampleRes.text();
  const streamState = await events.getStreamState({ path: "/" });
  const internalHealth = await events.__internal_health({});
  const docSearch = await cloudflare_docs.search_cloudflare_documentation({ query: "workers" });
  const docText = typeof docSearch === "string" ? docSearch : JSON.stringify(docSearch);
  return {
    answer,
    streamStateOk: streamState != null && typeof streamState === "object",
    internalHealthOk: internalHealth != null && internalHealth.ok === true,
    mcpSearchOk: docText.length > 80,
    mcpSearchLength: docText.length,
    example: { status: exampleRes.status, bodyPreview: exampleBody.slice(0, 80) },
  };
}
`.trim();

describe.sequential("agents iterate-agent mixed codemode e2e", () => {
  test.skipIf(!shouldRunMixedCodemodeTest || process.env.AGENTS_E2E_ITERATE_AGENT !== "1")(
    "one codemode block uses builtin + events OpenAPI + MCP + fetch (HAR replay)",
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
      console.info(`[iterate-agent mixed e2e] Events stream (open in browser): ${streamViewerUrl}`);

      await using mockInternet = await useMockHttpServer({
        ...(recordHar
          ? {
              recorder: { harPath: harFixturePath },
              onUnhandledRequest: "bypass" as const,
            }
          : {
              onUnhandledRequest: "error" as const,
            }),
      });

      if (!recordHar) {
        const eventsProjectHostname = new URL(
          getProjectUrl({
            currentUrl: eventsBaseUrl,
            projectSlug: ProjectSlug.parse(vitestRunSlug),
          }).toString(),
        ).hostname;
        const harRaw = JSON.parse(await readFile(harFixturePath, "utf8")) as HarWithExtensions;
        const har = prepareAgentsHarForReplay(harRaw, eventsProjectHostname);
        mockInternet.use(...fromTrafficWithWebSocket(har), ...mcpStreamableHttpGetStubHandlers);
      }

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
          APP_CONFIG_EXTERNAL_EGRESS_PROXY: mockInternet.url,
        },
      });
      console.info(`[iterate-agent mixed e2e] Agents dev server: ${_devServer.baseUrl}`);

      await using tunnel = await useCloudflareTunnel({
        token: tunnelLease.tunnelToken,
        publicUrl: tunnelLease.publicUrl,
      });

      const agentInstance = `e2e-mixed-${executionSuffix}`;
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
            slug: `iterate-agent-mixed-ws-${executionSuffix}`,
            type: "websocket",
            callbackUrl,
          },
        },
      });

      await eventsClient.append({
        path: streamPath,
        event: {
          type: "codemode-block-added",
          payload: {
            script: MIXED_CODEMODE_SCRIPT,
          },
        },
      });

      const resultEvent = await waitForStreamEvent({
        client: eventsClient,
        path: streamPath,
        predicate: (event) => event.type === "codemode-result-added",
        timeoutMs: 120_000,
      });

      const payload = resultEvent.payload as {
        result?: {
          answer?: number;
          streamStateOk?: boolean;
          internalHealthOk?: boolean;
          mcpSearchOk?: boolean;
          mcpSearchLength?: number;
          example?: { status?: number; bodyPreview?: string };
        };
        error?: string;
      };
      expect(payload.error ?? "").toBe("");
      expect(payload.result?.answer).toBe(42);
      expect(payload.result?.streamStateOk).toBe(true);
      expect(payload.result?.internalHealthOk).toBe(true);
      expect(payload.result?.mcpSearchOk).toBe(true);
      expect(payload.result?.mcpSearchLength).toBeGreaterThan(80);
      expect(payload.result?.example?.status).toBe(200);
      expect(payload.result?.example?.bodyPreview?.length).toBeGreaterThan(0);

      const har = mockInternet.getHar();
      const urls = har.log.entries.map((entry) => entry.request.url);
      expect(urls.some((url) => url.includes("example.com"))).toBe(true);
      expect(urls.some((url) => url.includes("docs.mcp.cloudflare.com"))).toBe(true);
      const eventsHost = new URL(
        getProjectUrl({
          currentUrl: eventsBaseUrl,
          projectSlug: ProjectSlug.parse(vitestRunSlug),
        }).toString(),
      ).hostname;
      expect(urls.some((url) => url.includes(eventsHost))).toBe(true);
    },
    150_000,
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
