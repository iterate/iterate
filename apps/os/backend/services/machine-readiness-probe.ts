import { createMachineRuntime } from "@iterate-com/sandbox/providers/machine-runtime";
import type { CloudflareEnv } from "../../env.ts";
import type * as schema from "../db/schema.ts";
import { logger } from "../tag-logger.ts";

const PROBE_THREAD_ID = "__readiness-probe__";
const PROBE_TEXT = "What is one plus two? Reply with just the answer, nothing else.";
const POLL_INTERVAL_MS = 3_000;
const SEND_RETRY_INTERVAL_MS = 3_000;
const SEND_TIMEOUT_MS = 10_000;
const SEND_MAX_WAIT_MS = 60_000;
const MAX_WAIT_MS = 120_000;

/**
 * Smoke-test a machine by sending a webchat message and waiting for a valid response.
 * Returns true if the machine responds with something containing "3" or "three".
 */
export async function probeMachineReadiness(
  machine: typeof schema.machine.$inferSelect,
  env: CloudflareEnv,
): Promise<{ ok: boolean; detail: string }> {
  const previewUrl = await buildPreviewUrl(machine, env);
  if (!previewUrl) {
    return { ok: false, detail: "Could not build preview URL for machine" };
  }

  // 1. Send the probe message via webchat webhook (retries with fresh messageId each attempt)
  const sendResult = await sendProbeMessage(previewUrl);
  if (!sendResult.ok) {
    return { ok: false, detail: `Failed to send probe: ${sendResult.detail}` };
  }

  // 2. Poll for a response containing "3" or "three"
  const pollResult = await pollForAnswer(previewUrl, sendResult.threadId);
  return pollResult;
}

async function buildPreviewUrl(
  machine: typeof schema.machine.$inferSelect,
  env: CloudflareEnv,
): Promise<string | null> {
  try {
    const runtime = await createMachineRuntime({
      type: machine.type,
      env,
      externalId: machine.externalId,
      metadata: (machine.metadata as Record<string, unknown>) ?? {},
    });
    return await runtime.getBaseUrl(3000);
  } catch (err) {
    logger.warn("[readiness-probe] Failed to build preview URL", {
      machineId: machine.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function sendProbeMessage(
  previewUrl: string,
): Promise<{ ok: true; threadId: string; messageId: string } | { ok: false; detail: string }> {
  const url = `${previewUrl}/api/integrations/webchat/webhook`;

  // Retry the initial send — the daemon may still be booting internal services
  // (e.g. OpenCode server) even though its HTTP server is already accepting
  // connections, so 5xx / connection-refused are expected for a short window.
  // Each attempt uses a fresh messageId so the daemon's dedup logic doesn't
  // silently swallow retries after a failed first attempt that stored the event.
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
      const response = await fetch(url, {
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

async function pollForAnswer(
  previewUrl: string,
  threadId: string,
): Promise<{ ok: boolean; detail: string }> {
  const url = `${previewUrl}/api/integrations/webchat/threads/${encodeURIComponent(threadId)}/messages`;
  const deadline = Date.now() + MAX_WAIT_MS;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);

    try {
      const response = await fetch(url, {
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

      // Look for an assistant message that came after our probe
      const assistantMessages = messages.filter((m) => m.role === "assistant");

      for (const msg of assistantMessages) {
        const text = msg.text.toLowerCase();
        if (text.includes("3") || text.includes("three")) {
          return {
            ok: true,
            detail: `Got valid response: "${msg.text.slice(0, 100)}"`,
          };
        }
      }

      // If there are assistant messages but none match, keep polling —
      // the agent might still be working on it
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
