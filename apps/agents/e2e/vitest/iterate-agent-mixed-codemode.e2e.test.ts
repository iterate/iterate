/**
 * Legacy end-to-end coverage for the deleted monolithic `IterateAgent`.
 *
 * Kept skipped while the equivalent mixed-provider codemode coverage is
 * rebuilt around the stream processor runner callbacks.
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectSlug } from "@iterate-com/events-contract";
import { expect, test } from "vitest";
import { getProjectUrl } from "../../../events/src/lib/project-slug.ts";
import { setupE2E } from "../test-support/e2e-test.ts";
import { createLocalDevServer } from "../test-support/create-local-dev-server.ts";
import { createMockInternet } from "../test-support/create-mock-internet.ts";
import {
  MCP_TOOL_PROVIDER_PRESET_EVENT,
  OPENAPI_TOOL_PROVIDER_PRESET_EVENT,
} from "~/lib/default-tool-provider-events.ts";
import {
  buildCodemodeStreamProcessorRunnerWebSocketCallbackUrl,
  streamPathToAgentInstance,
} from "~/lib/iterate-agent-addressing.ts";

const appRoot = fileURLToPath(new URL("../..", import.meta.url));
const harFixturePath = join(appRoot, "e2e/vitest/__snapshots__/iterate-agent-mixed-codemode.har");

const MIXED_CODEMODE_SCRIPT = `
async () => {
  const mcpQuery = "workers";
  const answer = await builtin.answer();
  const exampleRes = await fetch("https://example.com/");
  const exampleBody = await exampleRes.text();

  const streamState = await iterate_events.getStreamState({ path: "/" });
  const internalHealth = await iterate_events.__internal_health({});
  const docSearch = await cloudflare_docs.search_cloudflare_documentation({ query: mcpQuery });
  const docText = typeof docSearch === "string" ? docSearch : JSON.stringify(docSearch);
  return {
    summary:
      "Mixed e2e: builtin + Events OpenAPI + example.com egress + Cloudflare MCP search — all OK; MCP snippet below.",
    answer,
    streamStateOk: streamState != null && typeof streamState === "object",
    internalHealthOk: internalHealth != null && internalHealth.ok === true,
    mcpQuery,
    mcpSearchSnippet: docText.slice(0, 500),
    mcpSearchChars: docText.length,
    mcpSearchOk: docText.length > 80,
    example: {
      status: exampleRes.status,
      bodyPreview: exampleBody.slice(0, 120),
      titleLine: (exampleBody.split("\\n")[0] ?? "").slice(0, 100),
    },
  };
}
`.trim();

test.skip(
  "one codemode block uses builtin + events OpenAPI + MCP + fetch (HAR replay)",
  { tags: ["local-dev-server", "mocked-internet"], timeout: 150_000 },
  async (ctx) => {
    const e2e = await setupE2E(ctx);
    const streamPath = e2e.createStreamPath();

    await using mock = await createMockInternet({
      harPath: harFixturePath,
      eventsBaseUrl: e2e.eventsBaseUrl,
      eventsProjectSlug: e2e.runSlug,
    });

    await using server = await createLocalDevServer({
      egressProxy: mock.url,
      eventsBaseUrl: e2e.eventsBaseUrl,
      eventsProjectSlug: e2e.runSlug,
      streamPath,
    });

    await e2e.events.append(streamPath, {
      type: "events.iterate.com/core/subscription-configured",
      payload: {
        slug: `codemode-runner-mixed-ws-${e2e.executionSuffix}`,
        type: "websocket",
        callbackUrl: buildCodemodeStreamProcessorRunnerWebSocketCallbackUrl({
          publicOrigin: server.publicUrl,
          runnerInstance: streamPathToAgentInstance(streamPath),
          streamPath,
        }),
      },
    });

    await e2e.events.append(streamPath, OPENAPI_TOOL_PROVIDER_PRESET_EVENT);
    await e2e.events.append(streamPath, MCP_TOOL_PROVIDER_PRESET_EVENT);

    await e2e.events.waitForEvent(
      streamPath,
      (event) =>
        event.type === "events.iterate.com/agent/input-added" &&
        typeof event.payload.content === "string" &&
        event.payload.content.includes("Tool provider `iterate_events` is now available"),
      { timeoutMs: 120_000 },
    );

    await e2e.events.waitForEvent(
      streamPath,
      (event) =>
        event.type === "events.iterate.com/agent/input-added" &&
        typeof event.payload.content === "string" &&
        event.payload.content.includes("Tool provider `cloudflare_docs` is now available"),
      { timeoutMs: 120_000 },
    );

    await e2e.events.append(streamPath, {
      type: "events.iterate.com/codemode/block-added",
      payload: { script: MIXED_CODEMODE_SCRIPT },
    });

    const resultEvent = await e2e.events.waitForEvent(
      streamPath,
      (event) => event.type === "events.iterate.com/codemode/result-added",
      { timeoutMs: 120_000 },
    );

    const payload = resultEvent.payload as {
      result?: {
        summary?: string;
        answer?: number;
        streamStateOk?: boolean;
        internalHealthOk?: boolean;
        mcpQuery?: string;
        mcpSearchSnippet?: string;
        mcpSearchChars?: number;
        mcpSearchOk?: boolean;
        example?: { status?: number; bodyPreview?: string; titleLine?: string };
      };
      error?: string;
    };
    expect(payload.error ?? "").toBe("");
    expect(payload.result?.summary ?? "").toContain("Mixed e2e");
    expect(payload.result?.answer).toBe(42);
    expect(payload.result?.streamStateOk).toBe(true);
    expect(payload.result?.internalHealthOk).toBe(true);
    expect(payload.result?.mcpQuery).toBe("workers");
    expect(payload.result?.mcpSearchOk).toBe(true);
    expect(payload.result?.mcpSearchChars).toBeGreaterThan(80);
    expect(payload.result?.mcpSearchSnippet ?? "").toMatch(/worker|Worker|Cloudflare|cloudflare/);
    expect(payload.result?.example?.status).toBe(200);
    expect(payload.result?.example?.bodyPreview?.length).toBeGreaterThan(0);
    expect(payload.result?.example?.titleLine ?? "").toMatch(/Example Domain/);

    const har = mock.getHar();
    const urls = har.log.entries.map((entry) => entry.request.url);
    expect(urls.some((url) => url.includes("example.com"))).toBe(true);
    expect(urls.some((url) => url.includes("docs.mcp.cloudflare.com"))).toBe(true);
    const eventsHost = new URL(
      getProjectUrl({
        currentUrl: e2e.eventsBaseUrl,
        projectSlug: ProjectSlug.parse(e2e.runSlug),
      }).toString(),
    ).hostname;
    expect(urls.some((url) => url.includes(eventsHost))).toBe(true);
  },
);
