/**
 * End-to-end: real Events host + Semaphore tunnel + `cloudflared` -> public `wss://` to
 * `IterateAgent` -> codemode runs `builtin` + events OpenAPI + `fetch("https://example.com/")`
 * (egress via mock proxy / HAR).
 *
 * After changing `CODEMODE_SCRIPT` or proxy expectations, re-record: `pnpm test:e2e:record`
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
const harFixturePath = join(appRoot, "e2e/vitest/__snapshots__/iterate-agent-codemode.har");

const CODEMODE_SCRIPT = `
async () => {
  const exampleRes = await fetch("https://example.com/");
  const exampleBody = await exampleRes.text();
  const streamState = await events.getStreamState({ path: "/" });
  const internalHealth = await events.__internal_health({});
  return {
    summary:
      "Codemode e2e: builtin.answer + Events getStreamState + __internal.health + example.com fetch — all OK.",
    answer: await builtin.answer(),
    streamStateOk: streamState != null && typeof streamState === "object",
    internalHealthOk: internalHealth != null && internalHealth.ok === true,
    example: {
      status: exampleRes.status,
      bodyPreview: exampleBody.slice(0, 120),
      titleLine: (exampleBody.split("\\n")[0] ?? "").slice(0, 100),
    },
  };
}
`.trim();

test(
  "websocket subscription runs codemode with mocked egress (HAR replay)",
  { tags: ["local-dev-server", "mocked-internet"], timeout: 120_000 },
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
    });

    await e2e.events.append(streamPath, {
      type: "https://events.iterate.com/events/stream/subscription/configured",
      payload: {
        slug: `iterate-agent-ws-${e2e.executionSuffix}`,
        type: "websocket",
        callbackUrl: server.callbackUrl,
      },
    });

    await e2e.events.append(streamPath, {
      type: "codemode-block-added",
      payload: { script: CODEMODE_SCRIPT },
    });

    const resultEvent = await e2e.events.waitForEvent(
      streamPath,
      (event) => event.type === "codemode-result-added",
      { timeoutMs: 90_000 },
    );

    const payload = resultEvent.payload as {
      result?: {
        summary?: string;
        answer?: number;
        streamStateOk?: boolean;
        internalHealthOk?: boolean;
        example?: { status?: number; bodyPreview?: string; titleLine?: string };
      };
      error?: string;
    };
    expect(payload.error ?? "").toBe("");
    expect(payload.result?.summary ?? "").toContain("Codemode e2e");
    expect(payload.result?.answer).toBe(42);
    expect(payload.result?.streamStateOk).toBe(true);
    expect(payload.result?.internalHealthOk).toBe(true);
    expect(payload.result?.example?.status).toBe(200);
    expect(payload.result?.example?.bodyPreview?.length).toBeGreaterThan(0);
    expect(payload.result?.example?.titleLine ?? "").toMatch(/Example Domain/);

    const har = mock.getHar();
    const urls = har.log.entries.map((entry) => entry.request.url);
    const eventsHost = new URL(
      getProjectUrl({
        currentUrl: e2e.eventsBaseUrl,
        projectSlug: ProjectSlug.parse(e2e.runSlug),
      }).toString(),
    ).hostname;
    expect(urls.some((url) => url.includes(eventsHost))).toBe(true);
    expect(urls.some((url) => url.includes("example.com"))).toBe(true);
  },
);
