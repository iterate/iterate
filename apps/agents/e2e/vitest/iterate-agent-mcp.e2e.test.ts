/**
 * End-to-end: codemode invokes Cloudflare Docs MCP (`search_cloudflare_documentation`) with outbound
 * traffic mocked via committed HAR.
 *
 * Re-record: `pnpm test:e2e:record` (from `apps/agents`, with Doppler + network).
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectSlug } from "@iterate-com/events-contract";
import { expect, test } from "vitest";
import { getProjectUrl } from "../../../events/src/lib/project-slug.ts";
import { setupE2E } from "../test-support/e2e-test.ts";
import { createLocalDevServer } from "../test-support/create-local-dev-server.ts";
import { createMockInternet } from "../test-support/create-mock-internet.ts";

const appRoot = fileURLToPath(new URL("../..", import.meta.url));
const harFixturePath = join(appRoot, "e2e/vitest/__snapshots__/iterate-agent-mcp.har");

const MCP_CODEMODE_SCRIPT = `
async () => {
  const query = "workers";
  const docSearch = await cloudflare_docs.search_cloudflare_documentation({ query });
  const text = typeof docSearch === "string" ? docSearch : JSON.stringify(docSearch);
  return {
    summary:
      "MCP e2e: cloudflare_docs.search_cloudflare_documentation succeeded — snippet is real tool output (HAR replay).",
    query,
    mcpSearchSnippet: text.slice(0, 500),
    mcpSearchChars: text.length,
    mcpSearchOk: text.length > 80,
  };
}
`.trim();

test(
  "codemode calls Cloudflare Docs MCP with mocked egress (HAR replay)",
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
      executionSuffix: e2e.executionSuffix,
      streamPath,
      instancePrefix: "e2e-mcp",
    });

    await e2e.events.append(streamPath, {
      type: "https://events.iterate.com/events/stream/subscription/configured",
      payload: {
        slug: `iterate-agent-mcp-ws-${e2e.executionSuffix}`,
        type: "websocket",
        callbackUrl: server.callbackUrl,
      },
    });

    await e2e.events.append(streamPath, {
      type: "codemode-block-added",
      payload: { script: MCP_CODEMODE_SCRIPT },
    });

    const resultEvent = await e2e.events.waitForEvent(
      streamPath,
      (event) => event.type === "codemode-result-added",
      { timeoutMs: 120_000 },
    );

    const payload = resultEvent.payload as {
      result?: {
        summary?: string;
        query?: string;
        mcpSearchSnippet?: string;
        mcpSearchChars?: number;
        mcpSearchOk?: boolean;
      };
      error?: string;
    };
    expect(payload.error ?? "").toBe("");
    expect(payload.result?.mcpSearchOk).toBe(true);
    expect(payload.result?.query).toBe("workers");
    expect(payload.result?.summary ?? "").toContain("MCP e2e");
    expect(payload.result?.mcpSearchChars).toBeGreaterThan(80);
    expect(payload.result?.mcpSearchSnippet ?? "").toMatch(/worker|Worker|Cloudflare|cloudflare/);

    const har = mock.getHar();
    const urls = har.log.entries.map((entry) => entry.request.url);
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
