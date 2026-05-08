import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  createEphemeralWorker,
  type EphemeralWorkerHandle,
} from "../test-support/create-ephemeral-worker.ts";
import { setupE2E } from "../test-support/e2e-test.ts";
import { OPENAPI_TOOL_PROVIDER_PRESET_EVENT } from "~/lib/default-tool-provider-events.ts";
import { buildCodemodeStreamProcessorRunnerWebSocketCallbackUrl } from "~/lib/iterate-agent-addressing.ts";

const hasAlchemyStateToken = Boolean(process.env.ALCHEMY_STATE_TOKEN?.trim());

// All tests share a single ephemeral worker to avoid repeated 45s deploys.
const describeEphemeral = hasAlchemyStateToken ? describe : describe.skip;

let worker: (EphemeralWorkerHandle & AsyncDisposable) | null = null;

describeEphemeral("ephemeral worker", () => {
  beforeAll(async () => {
    const eventsBaseUrl =
      process.env.EVENTS_BASE_URL?.trim().replace(/\/+$/, "") || "https://events.iterate.com";
    const { slugify } = await import("@iterate-com/shared/slugify");
    const runSlug = slugify(`ephemeral-${Date.now()}`);

    worker = await createEphemeralWorker({
      eventsBaseUrl,
      eventsProjectSlug: runSlug,
    });
    console.info(`[e2e] Shared ephemeral worker: ${worker.url} (stage=${worker.stage})`);
  }, 240_000);

  afterAll(async () => {
    if (worker) {
      await worker[Symbol.asyncDispose]();
      worker = null;
    }
  }, 120_000);

  test(
    "hello procedure",
    { tags: ["deployed-ephemeral-worker-with-egress-capture", "live-internet"], timeout: 30_000 },
    async () => {
      const res = await fetch(new URL("/api/hello", worker!.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "e2e" }),
        signal: AbortSignal.timeout(8_000),
      });
      expect(res.ok).toBe(true);
      expect(await res.json()).toEqual({ message: "hello e2e" });
    },
  );

  // Keep skipped while the runner-based deployed-worker smoke coverage is rebuilt.
  test.skip(
    "websocket codemode with builtin + events OpenAPI + fetch",
    { tags: ["deployed-ephemeral-worker-with-egress-capture", "live-internet"], timeout: 60_000 },
    async (ctx) => {
      const e2e = await setupE2E(ctx);
      const streamPath = e2e.createStreamPath();

      const websocketUrl = buildCodemodeStreamProcessorRunnerWebSocketCallbackUrl({
        publicOrigin: worker!.url,
        streamPath,
      });

      await e2e.events.append(streamPath, {
        type: "events.iterate.com/core/subscription-configured",
        payload: {
          slug: `iterate-agent-ws-${e2e.executionSuffix}`,
          type: "websocket",
          callable: fetchCallableFromWebSocketUrl(websocketUrl),
        },
      });

      await e2e.events.append(streamPath, OPENAPI_TOOL_PROVIDER_PRESET_EVENT);

      await e2e.events.waitForEvent(
        streamPath,
        (event) =>
          event.type === "events.iterate.com/agent/input-added" &&
          typeof event.payload.content === "string" &&
          event.payload.content.includes("Tool provider `iterate_events` is now available"),
        { timeoutMs: 45_000 },
      );

      await e2e.events.append(streamPath, {
        type: "events.iterate.com/codemode/block-added",
        payload: { script: LIVE_CODEMODE_SCRIPT },
      });

      const resultEvent = await e2e.events.waitForEvent(
        streamPath,
        (event) => event.type === "events.iterate.com/codemode/result-added",
        { timeoutMs: 45_000 },
      );

      const payload = resultEvent.payload as {
        result?: { summary?: string; answer?: number; example?: { status?: number } };
        error?: string;
      };
      expect(payload.error ?? "").toBe("");
      expect(payload.result?.answer).toBe(42);
      expect(payload.result?.example?.status).toBe(200);
    },
  );
});

const LIVE_CODEMODE_SCRIPT = `
async () => {
  const exampleRes = await fetch("https://example.com/");
  const exampleBody = await exampleRes.text();
  const streamState = await iterate_events.getStreamState({ path: "/" });
  const internalHealth = await iterate_events.__internal_health({});
  return {
    summary: "Codemode e2e: builtin + Events + example.com — all OK.",
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

function fetchCallableFromWebSocketUrl(websocketUrl: string) {
  const url = new URL(websocketUrl);
  if (url.protocol === "ws:") {
    url.protocol = "http:";
  } else if (url.protocol === "wss:") {
    url.protocol = "https:";
  }

  return {
    type: "fetch" as const,
    via: {
      type: "url" as const,
      url: url.toString(),
    },
  };
}
