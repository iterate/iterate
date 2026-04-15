/**
 * End-to-end: real `events.iterate.com` stream + Semaphore tunnel + `cloudflared` → public `wss://` to
 * `IterateAgent` → codemode runs `builtin` + events OpenAPI + `fetch("https://example.com/")` + Cloudflare Docs MCP
 * (`search_cloudflare_documentation`, query `MCP_E2E_QUERY`).
 *
 * Outbound HTTP (OpenAPI spec fetch, MCP from `onStart` + codemode, example.com, etc.) goes through
 * `APP_CONFIG_EXTERNAL_EGRESS_PROXY` to the mock proxy; committed HAR replays it.
 *
 * Requires `SEMAPHORE_API_TOKEN` + `SEMAPHORE_BASE_URL` (run `pnpm test:e2e` from `apps/agents` so Doppler sets them).
 *
 * After changing `CODEMODE_SCRIPT`, `MCP_E2E_QUERY`, or proxy expectations, re-record so the fixture includes the new MCP traffic:
 *   `pnpm test:e2e:record-har`
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { eventsContract, type StreamPath } from "@iterate-com/events-contract";
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

requireSemaphoreE2eEnv(process.env);

const appRoot = fileURLToPath(new URL("../..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));

const harFixturePath = join(appRoot, "e2e/fixtures/iterate-agent-mcp.har");
const recordHar = process.env.AGENTS_E2E_RECORD_HAR === "1";
const harFixturePresent = existsSync(harFixturePath);

const shouldRunIterateAgentTest = recordHar || harFixturePresent;

/** Distinct string so HAR replay can prove an MCP `tools/call` carried this query (not just `tools/list`). */
const MCP_E2E_QUERY = "iterate-agent-e2e-mcp-query-xyzzy";

/**
 * Codemode: `builtin` + `events` OpenAPI + global `fetch` (egress) + Cloudflare Docs MCP
 * (`cloudflare_docs` namespace from `IterateAgent.onStart`). After changing this script, re-record HAR.
 */
const CODEMODE_SCRIPT = `
async () => {
  const exampleRes = await fetch("https://example.com/");
  const exampleBody = await exampleRes.text();
  const mcpSearch = await cloudflare_docs.search_cloudflare_documentation({ query: "${MCP_E2E_QUERY}" });
  const mcpText = typeof mcpSearch === "string" ? mcpSearch : JSON.stringify(mcpSearch);
  return {
    answer: await builtin.answer(),
    health: await events["__internal.health"]({}),
    example: { status: exampleRes.status, bodyPreview: exampleBody.slice(0, 80) },
    mcpSearchPreview: mcpText.slice(0, 200),
  };
}
`.trim();

describe.sequential("agents iterate-agent e2e", () => {
  test.skipIf(!shouldRunIterateAgentTest)(
    "websocket subscription runs codemode with mocked egress (HAR replay)",
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
      console.info(`[iterate-agent e2e] Events stream (open in browser): ${streamViewerUrl}`);

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
        const har = JSON.parse(await readFile(harFixturePath, "utf8")) as HarWithExtensions;
        mockInternet.use(...fromTrafficWithWebSocket(har));
      }

      await using tunnelLease = await useCloudflareTunnelLease({});

      await using _devServer = await useDevServer({
        cwd: appRoot,
        command: "pnpm",
        args: ["dev"],
        port: tunnelLease.localPort,
        env: {
          ...stripInheritedAppConfig(process.env),
          APP_CONFIG_EVENTS_BASE_URL: eventsBaseUrl,
          APP_CONFIG_EVENTS_PROJECT_SLUG: vitestRunSlug,
          APP_CONFIG_EXTERNAL_EGRESS_PROXY: mockInternet.url,
        },
      });
      console.info(`[iterate-agent e2e] Agents dev server: ${_devServer.baseUrl}`);

      await using tunnel = await useCloudflareTunnel({
        token: tunnelLease.tunnelToken,
        publicUrl: tunnelLease.publicUrl,
      });

      const agentInstance = `e2e-${executionSuffix}`;
      const callbackUrl = toWssAgentWebsocketUrl(tunnel.publicUrl, agentInstance);

      const eventsClient = createEventsClient({
        baseUrl: eventsBaseUrl,
        projectSlug: vitestRunSlug,
      });

      await eventsClient.append({
        path: streamPath,
        event: {
          type: "https://events.iterate.com/events/stream/subscription/configured",
          payload: {
            slug: `iterate-agent-ws-${executionSuffix}`,
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
            script: CODEMODE_SCRIPT,
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
          health?: { ok?: boolean };
          example?: { status?: number; bodyPreview?: string };
          mcpSearchPreview?: string;
        };
        error?: string;
      };
      expect(payload.error ?? "").toBe("");
      expect(payload.result?.answer).toBe(42);
      expect(payload.result?.health).toMatchObject({ ok: true });
      expect(payload.result?.example?.status).toBe(200);
      expect(payload.result?.example?.bodyPreview?.length).toBeGreaterThan(0);
      expect(payload.result?.mcpSearchPreview?.length).toBeGreaterThan(20);

      const har = mockInternet.getHar();
      const urls = har.log.entries.map((entry) => entry.request.url);
      const harSnapshot = JSON.stringify(har.log.entries);
      expect(urls.some((url) => url.includes("events.iterate.com"))).toBe(true);
      expect(urls.some((url) => url.includes("docs.mcp.cloudflare.com"))).toBe(true);
      expect(urls.some((url) => url.includes("example.com"))).toBe(true);
      expect(harSnapshot).toContain(MCP_E2E_QUERY);
    },
    180_000,
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

function createEventsClient(options: {
  baseUrl: string;
  projectSlug: string;
}): ContractRouterClient<typeof eventsContract> {
  return createORPCClient(
    new OpenAPILink(eventsContract, {
      url: new URL("/api", options.baseUrl).toString(),
      fetch: (request, init) => {
        const requestInit = init as RequestInit | undefined;
        const headers = new Headers(
          request instanceof Request ? request.headers : requestInit?.headers,
        );
        headers.set("x-iterate-project", options.projectSlug);
        return fetch(request, {
          ...requestInit,
          headers,
        });
      },
    }),
  ) as ContractRouterClient<typeof eventsContract>;
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
