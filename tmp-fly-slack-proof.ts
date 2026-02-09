/**
 * Findings (2026-02-07):
 * - GOOD: End-to-end Fly proof passed with real daemon + fake Slack webhook + egress proxy.
 *   marker=FLY_EGRESS_PROOF_1770506035057
 *   app=iterate-sandbox-fly-proof3-slack-proof-1770506035353-90dca11d
 *   machine=48e696ef37d398
 *   daemon=https://iterate-sandbox-fly-proof3-slack-proof-1770506035353-90dca11d.fly.dev
 *   thread_ts=1770506035.288919
 *   response_ts=1770506096.094789
 *   response_text=FLY_EGRESS_PROOF_1770506035057
 * - GOOD: webhook endpoint returned HTTP 200 before Slack reply polling.
 * - GOOD: sandbox cleanup succeeded (machine deleted).
 * - BAD (fixed): initial verifier used JSON body for Slack APIs and got invalid_arguments for conversations.replies.
 *   switched to x-www-form-urlencoded in slackApi() and reran successfully.
 * - CI (GitHub PR #891, last pushed sha=a136e05d):
 *   required checks are green (artifact.ci, build-snapshot/build, lint-typecheck, test, generate, specs).
 * - CI (non-blocking noise): run 21787801524 for legacy path ".github/workflows/sandbox-test.yml" is marked failure
 *   with zero jobs/logs; this does not appear in required PR checks.
 * - Note: local HEAD in this worktree is 27806242 (ahead of origin by 2), so CI has not run for local-only commits yet.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { FlyProvider } from "./sandbox/providers/fly/provider.ts";

const SLACK_API_BASE = "https://slack.com/api";
const CHANNEL_ID = process.env.SLACK_PROOF_CHANNEL_ID ?? "C08R1SMTZGD";
const EGRESS_PROXY_URL =
  process.env.SLACK_PROOF_EGRESS_PROXY_URL ??
  "https://dev-jonas-os.dev.iterate.com/api/egress-proxy";
const OVERALL_TIMEOUT_MS = 12 * 60 * 1000;

function logStep(message: string, details?: Record<string, unknown>): void {
  const payload = details ? { message, ...details } : { message };
  console.error(`[${new Date().toISOString()}] ${JSON.stringify(payload)}`);
}

async function slackApi<T>(params: {
  method: string;
  token: string;
  body: Record<string, unknown>;
}): Promise<T> {
  const formBody = new URLSearchParams();
  for (const [key, value] of Object.entries(params.body)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      formBody.set(key, String(value));
      continue;
    }
    formBody.set(key, JSON.stringify(value));
  }

  const response = await fetch(`${SLACK_API_BASE}/${params.method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.token}`,
      "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
    },
    body: formBody,
  });

  const payload = (await response.json()) as T;
  if (!response.ok) {
    throw new Error(`Slack API HTTP ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function waitForHealth(
  providerSandbox: Awaited<ReturnType<FlyProvider["create"]>>,
): Promise<void> {
  const timeoutMs = 120_000;
  const started = Date.now();
  let lastError: unknown;

  while (Date.now() - started < timeoutMs) {
    try {
      const backend = await providerSandbox.exec([
        "curl",
        "-sf",
        "--max-time",
        "5",
        "http://127.0.0.1:3001/api/health",
      ]);
      const frontend = await providerSandbox.exec([
        "curl",
        "-sf",
        "--max-time",
        "5",
        "http://127.0.0.1:3000/api/health",
      ]);
      if (backend.includes("ok") && frontend.includes("ok")) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(1000);
  }

  throw new Error(`Timed out waiting for daemon health: ${String(lastError)}`);
}

async function main() {
  const timeoutHandle = setTimeout(() => {
    logStep("overall timeout exceeded", { timeoutMs: OVERALL_TIMEOUT_MS });
    process.exit(1);
  }, OVERALL_TIMEOUT_MS);

  timeoutHandle.unref();

  const slackToken = process.env.SLACK_CI_BOT_TOKEN;
  if (!slackToken) {
    throw new Error("SLACK_CI_BOT_TOKEN is required");
  }

  const flyApiToken = process.env.FLY_API_TOKEN;
  if (!flyApiToken) {
    throw new Error("FLY_API_TOKEN is required");
  }

  const marker = `FLY_EGRESS_PROOF_${Date.now()}`;
  logStep("starting proof", { marker, channelId: CHANNEL_ID, egressProxyUrl: EGRESS_PROXY_URL });

  const seed = (await slackApi<{
    ok: boolean;
    error?: string;
    ts?: string;
    channel?: string;
  }>({
    method: "chat.postMessage",
    token: slackToken,
    body: {
      channel: CHANNEL_ID,
      text: `[sandbox fly proof seed] ${marker}`,
    },
  })) as { ok: boolean; error?: string; ts?: string; channel?: string };

  if (!seed.ok || !seed.ts || !seed.channel) {
    throw new Error(`Failed to seed Slack thread: ${JSON.stringify(seed)}`);
  }
  logStep("seeded slack thread", { threadTs: seed.ts, channel: seed.channel });

  const provider = new FlyProvider({
    ...process.env,
    FLY_API_TOKEN: flyApiToken,
    FLY_APP_NAME_PREFIX: process.env.FLY_APP_NAME_PREFIX ?? "iterate-sandbox-fly-proof3",
    FLY_DEFAULT_CPUS: process.env.FLY_DEFAULT_CPUS ?? "2",
    FLY_DEFAULT_MEMORY_MB: process.env.FLY_DEFAULT_MEMORY_MB ?? "4096",
  });

  const sandbox = await provider.create({
    id: `slack-proof-${Date.now()}`,
    name: "Slack Proof",
    envVars: {
      ITERATE_CUSTOMER_REPO_PATH: "/home/iterate/src/github.com/iterate/iterate",
      ITERATE_EGRESS_PROXY_URL: EGRESS_PROXY_URL,
      ITERATE_OS_API_KEY: "test-key",
      SLACK_BOT_TOKEN: slackToken,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "",
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
      __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: ".fly.dev",
    },
  });
  logStep("fly sandbox created", {
    providerId: sandbox.providerId,
    appName: sandbox.appName,
    machineId: sandbox.machineId,
  });

  try {
    logStep("waiting for daemon health");
    await waitForHealth(sandbox);
    logStep("daemon healthy");

    const baseUrl = await sandbox.getBaseUrl({ port: 3000 });
    logStep("resolved daemon url", { baseUrl });

    const payload = {
      type: "event_callback",
      event_id: `evt_${Date.now()}`,
      event_time: Math.floor(Date.now() / 1000),
      authorizations: [
        {
          enterprise_id: null,
          team_id: "T_PROOF",
          user_id: "U_BOT_PROOF",
          is_bot: true,
          is_enterprise_install: false,
        },
      ],
      event: {
        type: "app_mention",
        user: "U_USER_PROOF",
        channel: seed.channel,
        ts: `${Math.floor(Date.now() / 1000)}.${String(Date.now() % 1_000_000).padStart(6, "0")}`,
        thread_ts: seed.ts,
        text: `<@U_BOT_PROOF> Reply in this thread with EXACT text: ${marker}`,
      },
    };

    const webhookResponse = await fetch(`${baseUrl}/api/integrations/slack/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const webhookBody = await webhookResponse.text();
    if (!webhookResponse.ok) {
      throw new Error(`Webhook failed ${webhookResponse.status}: ${webhookBody}`);
    }
    logStep("webhook accepted", { status: webhookResponse.status });

    let foundMessageTs: string | null = null;
    let foundMessageText: string | null = null;
    const started = Date.now();
    const timeoutMs = 240_000;

    while (Date.now() - started < timeoutMs) {
      const replies = await slackApi<{
        ok: boolean;
        error?: string;
        messages?: Array<{ ts?: string; text?: string }>;
      }>({
        method: "conversations.replies",
        token: slackToken,
        body: {
          channel: seed.channel,
          ts: seed.ts,
          inclusive: true,
          limit: 50,
        },
      });

      if (!replies.ok) {
        throw new Error(`conversations.replies failed: ${JSON.stringify(replies)}`);
      }

      const candidate =
        replies.messages?.find(
          (message) => message.ts && message.ts !== seed.ts && message.text?.includes(marker),
        ) ?? null;

      if (candidate?.ts) {
        foundMessageTs = candidate.ts;
        foundMessageText = candidate.text ?? null;
        break;
      }

      logStep("waiting for slack reply", {
        elapsedSeconds: Math.floor((Date.now() - started) / 1000),
        timeoutSeconds: Math.floor(timeoutMs / 1000),
      });
      await sleep(5000);
    }

    if (!foundMessageTs) {
      const logs = await sandbox.exec(["sh", "-lc", "tail -n 200 /var/log/pidnap/console || true"]);
      throw new Error(
        `Did not observe OpenCode Slack reply containing marker ${marker}. Recent pidnap logs:\n${logs}`,
      );
    }

    console.log(
      JSON.stringify(
        {
          marker,
          appName: sandbox.appName,
          machineId: sandbox.machineId,
          providerId: sandbox.providerId,
          daemonUrl: baseUrl,
          threadTs: seed.ts,
          responseTs: foundMessageTs,
          responseText: foundMessageText,
          egressProxyUrl: EGRESS_PROXY_URL,
        },
        null,
        2,
      ),
    );
    logStep("proof succeeded", { marker, responseTs: foundMessageTs });
  } finally {
    logStep("deleting fly sandbox", { providerId: sandbox.providerId });
    await sandbox.delete();
    logStep("fly sandbox deleted");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
