/**
 * End-to-end: codemode invokes Cloudflare Docs MCP (`search_cloudflare_documentation`) with outbound
 * traffic mocked via committed HAR (same pattern as `iterate-agent.e2e.test.ts`).
 *
 * MCP codemode namespaces use **server name** from `addMcpServer("cloudflare-docs", …)` → `cloudflare_docs`.
 *
 * Re-record: `pnpm test:e2e:record-har-mcp` (from `apps/agents`, with Doppler + network).
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
import { requireSemaphoreE2eEnv } from "../test-support/require-semaphore-e2e-env.ts";
import { createEventsOrpcClient } from "../../src/lib/events-orpc-client.ts";
import { getProjectUrl } from "../../../events/src/lib/project-slug.ts";

requireSemaphoreE2eEnv(process.env);

const appRoot = fileURLToPath(new URL("../..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));

const harFixturePath = join(appRoot, "e2e/fixtures/iterate-agent-mcp.har");
const recordHar = process.env.AGENTS_E2E_RECORD_HAR === "1";
const harFixturePresent = existsSync(harFixturePath);

const shouldRunMcpCodemodeTest = recordHar || harFixturePresent;

/**
 * `cloudflare_docs` = sanitized server name `cloudflare-docs` (see `createMcpToolProviders`).
 * Tool key matches MCP `search_cloudflare_documentation` (underscores already valid).
 */
const MCP_CODEMODE_SCRIPT = `
async () => {
  const docSearch = await cloudflare_docs.search_cloudflare_documentation({ query: "workers" });
  const text = typeof docSearch === "string" ? docSearch : JSON.stringify(docSearch);
  return {
    mcpSearchLength: text.length,
    mcpSearchOk: text.length > 80,
  };
}
`.trim();

describe.sequential("agents iterate-agent MCP codemode e2e", () => {
  test.skipIf(!shouldRunMcpCodemodeTest || process.env.AGENTS_E2E_ITERATE_AGENT !== "1")(
    "codemode calls Cloudflare Docs MCP with mocked egress (HAR replay)",
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
      console.info(`[iterate-agent MCP e2e] Events stream (open in browser): ${streamViewerUrl}`);

      await using mockInternet = await useMockHttpServer({
        ...(recordHar
          ? {
              recorder: { harPath: harFixturePath },
              onUnhandledRequest: "bypass" as const,
            }
          : {
              onUnhandledRequest: "bypass" as const,
            }),
      });

      if (!recordHar) {
        const har = JSON.parse(await readFile(harFixturePath, "utf8")) as HarWithExtensions;
        mockInternet.use(...fromTrafficWithWebSocket(har));
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
      console.info(`[iterate-agent MCP e2e] Agents dev server: ${_devServer.baseUrl}`);

      await using tunnel = await useCloudflareTunnel({
        token: tunnelLease.tunnelToken,
        publicUrl: tunnelLease.publicUrl,
      });

      const agentInstance = `e2e-mcp-${executionSuffix}`;
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
            slug: `iterate-agent-mcp-ws-${executionSuffix}`,
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
            script: MCP_CODEMODE_SCRIPT,
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
          mcpSearchLength?: number;
          mcpSearchOk?: boolean;
        };
        error?: string;
      };
      expect(payload.error ?? "").toBe("");
      expect(payload.result?.mcpSearchOk).toBe(true);
      expect(payload.result?.mcpSearchLength).toBeGreaterThan(80);

      const har = mockInternet.getHar();
      const urls = har.log.entries.map((entry) => entry.request.url);
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
