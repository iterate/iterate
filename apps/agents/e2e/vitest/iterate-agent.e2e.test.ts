/**
 * End-to-end: real Events host + Semaphore tunnel + `cloudflared` -> public
 * `wss://` to `CodemodeStreamProcessorRunner` -> codemode runs `builtin` +
 * Events OpenAPI + `fetch("https://example.com/")` with egress via HAR replay.
 *
 * After changing `CODEMODE_SCRIPT` or proxy expectations, re-record:
 * `pnpm test:e2e:record`.
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectSlug } from "@iterate-com/events-contract";
import { http, passthrough } from "@iterate-com/mock-http-proxy";
import { expect, test } from "vitest";
import { getProjectUrl } from "../../../events/src/lib/project-slug.ts";
import { setupE2E } from "../test-support/e2e-test.ts";
import { createLocalDevServer } from "../test-support/create-local-dev-server.ts";
import { createMockInternet } from "../test-support/create-mock-internet.ts";
import { OPENAPI_TOOL_PROVIDER_PRESET_EVENT } from "~/lib/default-tool-provider-events.ts";
import {
  buildCodemodeStreamProcessorRunnerWebSocketCallbackUrl,
  streamPathToAgentInstance,
} from "~/lib/iterate-agent-addressing.ts";

const appRoot = fileURLToPath(new URL("../..", import.meta.url));
const harFixturePath = join(appRoot, "e2e/vitest/__snapshots__/iterate-agent-codemode.har");

const CODEMODE_SCRIPT = `
async () => {
  const exampleRes = await fetch("https://example.com/");
  const exampleBody = await exampleRes.text();
  const streamState = await iterate_events.getStreamState({ path: "/" });
  const internalHealth = await iterate_events.__internal_health({});
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
  "codemode stream processor runner executes a block with mocked egress (HAR replay)",
  { tags: ["local-dev-server", "mocked-internet"], timeout: 120_000 },
  async (ctx) => {
    const e2e = await setupE2E(ctx);
    const streamPath = e2e.createStreamPath();

    await using mock = await createMockInternet({
      harPath: harFixturePath,
      eventsBaseUrl: e2e.eventsBaseUrl,
      eventsProjectSlug: e2e.runSlug,
    });
    mock.use(
      http.all(eventsStreamUrlPattern({ e2e, streamPath }), () => {
        return passthrough();
      }),
    );

    await using server = await createLocalDevServer({
      egressProxy: mock.url,
      eventsBaseUrl: e2e.eventsBaseUrl,
      eventsProjectSlug: e2e.runSlug,
      streamPath,
    });

    await e2e.events.append(streamPath, {
      type: "events.iterate.com/core/subscription-configured",
      payload: {
        slug: `codemode-runner-ws-${e2e.executionSuffix}`,
        type: "websocket",
        callbackUrl: buildCodemodeStreamProcessorRunnerWebSocketCallbackUrl({
          publicOrigin: server.publicUrl,
          runnerInstance: streamPathToAgentInstance(streamPath),
          streamPath,
        }),
      },
    });

    await e2e.events.append(streamPath, OPENAPI_TOOL_PROVIDER_PRESET_EVENT);

    await e2e.events.waitForEvent(
      streamPath,
      (event) =>
        event.type === "events.iterate.com/agent/input-added" &&
        typeof event.payload.content === "string" &&
        event.payload.content.includes("Tool provider `iterate_events` is now available"),
      { timeoutMs: 120_000 },
    );

    await e2e.events.append(streamPath, {
      type: "events.iterate.com/codemode/block-added",
      payload: { script: CODEMODE_SCRIPT },
    });

    const resultEvent = await e2e.events.waitForEvent(
      streamPath,
      (event) => event.type === "events.iterate.com/codemode/result-added",
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

function eventsStreamUrlPattern(args: {
  e2e: Awaited<ReturnType<typeof setupE2E>>;
  streamPath: string;
}) {
  const eventsHost = new URL(
    getProjectUrl({
      currentUrl: args.e2e.eventsBaseUrl,
      projectSlug: ProjectSlug.parse(args.e2e.runSlug),
    }).toString(),
  ).hostname;
  const encodedStreamPath = encodeURIComponent(args.streamPath);
  return new RegExp(
    `^https://${escapeRegExp(eventsHost)}/api/streams/${escapeRegExp(encodedStreamPath)}(?:[/?]|$)`,
  );
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
