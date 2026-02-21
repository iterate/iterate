import { createMachineStub } from "@iterate-com/sandbox/providers/machine-stub";
import type { SandboxFetcher } from "@iterate-com/sandbox/providers/types";
import type { CloudflareEnv } from "../../env.ts";
import type * as schema from "../db/schema.ts";
import { logger } from "../tag-logger.ts";

export const PROBE_THREAD_ID = "__readiness-probe__";
const PROBE_TEXT = "What is one plus two? Reply with just the answer, nothing else.";
const EXPECTED_ANSWER = /3|three/i;
const POLL_INTERVAL_MS = 3_000;
const SEND_RETRY_INTERVAL_MS = 3_000;
const SEND_TIMEOUT_MS = 10_000;
const SEND_MAX_WAIT_MS = 30_000;
const MAX_WAIT_MS = 60_000;

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
 * Polls every 3s for up to 60s. Fails immediately if the assistant
 * responds with the wrong answer (no point continuing to poll).
 */
export async function pollForProbeAnswer(
  fetcher: SandboxFetcher,
  threadId: string,
): Promise<string> {
  const url = `/api/integrations/webchat/threads/${encodeURIComponent(threadId)}/messages`;
  const deadline = Date.now() + MAX_WAIT_MS;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);

    const response = await fetcher(url, {
      method: "GET",
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`Got ${response.status} from ${response.url}`);
    }

    const data = (await response.json()) as {
      messages?: Array<{ role: string; text: string; messageId?: string }>;
    };

    const messages = data.messages ?? [];

    const assistantResponses = messages.flatMap((m) => (m.role === "assistant" ? m.text : []));
    const text = assistantResponses.join("\n");
    if (!text) continue;

    if (EXPECTED_ANSWER.test(text)) {
      return text.slice(0, 100);
    }

    throw Object.assign(new Error(`Wrong answer: ${JSON.stringify(text)}.`), {
      retryable: false,
    });
  }

  throw new Error(`Timed out after ${MAX_WAIT_MS / 1000}s waiting for valid response`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
