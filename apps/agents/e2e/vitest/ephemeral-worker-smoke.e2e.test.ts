import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  createEphemeralWorker,
  type EphemeralWorkerHandle,
} from "../test-support/create-ephemeral-worker.ts";
import { setupE2E } from "../test-support/e2e-test.ts";

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

  test(
    "websocket codemode with builtin + events OpenAPI + fetch",
    { tags: ["deployed-ephemeral-worker-with-egress-capture", "live-internet"], timeout: 60_000 },
    async (ctx) => {
      const e2e = await setupE2E(ctx);
      const streamPath = e2e.createStreamPath();

      const agentInstance = `e2e-${e2e.executionSuffix}`;
      const callbackUrl = toWssAgentWebsocketUrl(worker!.url, agentInstance);

      await e2e.events.append(streamPath, {
        type: "https://events.iterate.com/events/stream/subscription/configured",
        payload: {
          slug: `iterate-agent-ws-${e2e.executionSuffix}`,
          type: "websocket",
          callbackUrl,
        },
      });

      await e2e.events.append(streamPath, {
        type: "codemode-block-added",
        payload: { script: LIVE_CODEMODE_SCRIPT },
      });

      const resultEvent = await e2e.events.waitForEvent(
        streamPath,
        (event) => event.type === "codemode-result-added",
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
  const streamState = await events.getStreamState({ path: "/" });
  const internalHealth = await events.__internal_health({});
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

function toWssAgentWebsocketUrl(httpsBase: string, instanceName: string) {
  const base = new URL(httpsBase);
  base.protocol = "wss:";
  base.pathname = `/agents/iterate-agent/${instanceName}`;
  base.search = "";
  base.hash = "";
  return base.toString();
}
