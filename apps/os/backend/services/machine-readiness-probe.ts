import { createMachineStub } from "@iterate-com/sandbox/providers/machine-stub";
import type { SandboxFetcher } from "@iterate-com/sandbox/providers/types";
import type { CloudflareEnv } from "../../env.ts";
import type * as schema from "../db/schema.ts";
import { logger } from "../tag-logger.ts";

export const PROBE_THREAD_ID = "__readiness-probe__";
const PROBE_TEXT = "What is one plus two? Reply with just the answer, nothing else.";
const POLL_INTERVAL_MS = 3_000;
const SEND_RETRY_INTERVAL_MS = 3_000;
const SEND_TIMEOUT_MS = 10_000;
const SEND_MAX_WAIT_MS = 60_000;
const MAX_WAIT_MS = 120_000;

/**
 * Build a fetcher that can reach the daemon HTTP server inside the sandbox.
 */
export async function buildMachineFetcher(
  machine: typeof schema.machine.$inferSelect,
  env: CloudflareEnv,
): Promise<SandboxFetcher | null> {
  try {
    const runtime = await createMachineStub({
      type: machine.type,
      env,
      externalId: machine.externalId,
      metadata: (machine.metadata as Record<string, unknown>) ?? {},
    });
    return await runtime.getFetcher(3000);
  } catch (err) {
    logger.warn("[readiness-probe] Failed to build machine fetcher", {
      machineId: machine.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Send a single readiness probe message via the webchat webhook.
 * Retries transient errors (5xx, connection failures) for up to 60s.
 * Returns the threadId and messageId on success.
 */
export async function sendProbeMessage(
  fetcher: SandboxFetcher,
): Promise<{ ok: true; threadId: string; messageId: string } | { ok: false; detail: string }> {
  const deadline = Date.now() + SEND_MAX_WAIT_MS;
  let lastDetail = "";

  while (Date.now() < deadline) {
    const messageId = `probe_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    const payload = {
      type: "webchat:message",
      threadId: PROBE_THREAD_ID,
      messageId,
      text: PROBE_TEXT,
      userId: "__system__",
      userName: "Readiness Probe",
      createdAt: Date.now(),
    };

    try {
      const response = await fetcher("/api/integrations/webchat/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });

      if (response.ok) {
        const data = (await response.json()) as { threadId?: string };
        return { ok: true, threadId: data.threadId ?? PROBE_THREAD_ID, messageId };
      }

      const body = await response.text().catch(() => "<no body>");
      lastDetail = `HTTP ${response.status}: ${body.slice(0, 200)}`;

      // 4xx (other than 408/429) are not transient — bail immediately
      if (
        response.status >= 400 &&
        response.status < 500 &&
        response.status !== 408 &&
        response.status !== 429
      ) {
        return { ok: false, detail: lastDetail };
      }

      logger.info("[readiness-probe] Send got retryable response, will retry", {
        status: response.status,
      });
    } catch (err) {
      lastDetail = err instanceof Error ? err.message : String(err);
      logger.info("[readiness-probe] Send error (will retry)", { error: lastDetail });
    }

    await sleep(SEND_RETRY_INTERVAL_MS);
  }

  return { ok: false, detail: `Send failed after ${SEND_MAX_WAIT_MS / 1000}s: ${lastDetail}` };
}

/**
 * Poll for a valid response to the readiness probe.
 * Looks for an assistant message containing "3" or "three" in the probe thread.
 * Polls every 3s for up to 120s.
 */
export async function pollForProbeAnswer(
  fetcher: SandboxFetcher,
  threadId: string,
): Promise<{ ok: true; responseText: string } | { ok: false; detail: string }> {
  const url = `/api/integrations/webchat/threads/${encodeURIComponent(threadId)}/messages`;
  const deadline = Date.now() + MAX_WAIT_MS;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);

    try {
      const response = await fetcher(url, {
        method: "GET",
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        logger.info("[readiness-probe] Poll got non-OK response", {
          status: response.status,
          threadId,
        });
        continue;
      }

      const data = (await response.json()) as {
        messages?: Array<{ role: string; text: string; messageId?: string }>;
      };

      const messages = data.messages ?? [];
      const assistantMessages = messages.filter((m) => m.role === "assistant");

      for (const msg of assistantMessages) {
        const text = msg.text.toLowerCase();
        if (text.includes("3") || text.includes("three")) {
          return {
            ok: true,
            responseText: msg.text.slice(0, 100),
          };
        }
      }

      if (assistantMessages.length > 0) {
        logger.info("[readiness-probe] Got assistant response but no valid answer yet", {
          threadId,
          count: assistantMessages.length,
          lastText: assistantMessages[assistantMessages.length - 1]?.text.slice(0, 100),
        });
      }
    } catch (err) {
      logger.info("[readiness-probe] Poll error (will retry)", {
        threadId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    ok: false,
    detail: `Timed out after ${MAX_WAIT_MS / 1000}s waiting for valid response`,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
