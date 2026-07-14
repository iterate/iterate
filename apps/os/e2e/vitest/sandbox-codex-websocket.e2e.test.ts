// Exact released-binary, whole-turn proof for Codex's normal Responses
// WebSocket client. This is explicitly opt-in and billable: @openai/codex
// includes a ~350 MB platform package and the test uses Doppler's real OpenAI
// key only to write an OS project secret. The sandbox receives the placeholder.

import type { RpcStub } from "capnweb";
import { describe, expect, test } from "vitest";
import type { SandboxLiteDurableObject } from "../../src/domains/sandboxes/cloudflare/cloudflare-sandbox-durable-object.ts";
import { waitForCondition } from "../test-support/wait-for-condition.ts";
import { CODEX_VERSION } from "./sandbox-websocket-proof-programs.ts";
import { adminSecret, withItxSession } from "./test-helpers.ts";

const COMPLETION_MARKER = "ITERATE_WEBSOCKET_SMOKE_OK";

type CodexEvent = {
  item?: { text?: string; type?: string };
  thread_id?: string;
  type?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
};

function deployedBaseUrl(): string | null {
  const raw = process.env.APP_CONFIG_BASE_URL?.trim();
  if (!raw) return null;
  const url = new URL(raw);
  if (
    ["localhost", "127.0.0.1", "::1"].includes(url.hostname) ||
    url.hostname.endsWith(".localhost")
  ) {
    return null;
  }
  return url.toString();
}

function liveOpenAiKey(): string {
  const key = process.env.APP_CONFIG_OPEN_AI_API_KEY?.trim();
  if (!key) {
    throw new Error("OS_E2E_STOCK_CODEX_WEBSOCKET=1 requires Doppler APP_CONFIG_OPEN_AI_API_KEY");
  }
  return key;
}

function parseCodexEvents(stdout: string): CodexEvent[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CodexEvent);
}

const exactCodexProofEnabled = process.env.OS_E2E_STOCK_CODEX_WEBSOCKET === "1";

describe("sandbox stock Codex WebSocket egress", () => {
  test.skipIf(deployedBaseUrl() === null || !exactCodexProofEnabled)(
    `completes a whole OpenAI turn with unmodified @openai/codex@${CODEX_VERSION}`,
    { timeout: 300_000 },
    async () => {
      const openAiKey = liveOpenAiKey();
      const secretPath = `/secrets/codex-proof/${crypto.randomUUID()}`;

      using session = withItxSession();
      using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
      using project = itx.projects.create({ slug: `sandbox-codex-${crypto.randomUUID()}` });
      using secret = project.secrets.get(secretPath);
      await secret.update({
        egress: { urls: ["https://api.openai.com"] },
        material: openAiKey,
      });
      await waitForCondition(async () => (await secret.__describe()).hasMaterial, {
        description: "Codex proof secret processor to fold the OpenAI key",
      });

      const placeholder = `getSecret({ path: "${secretPath}" })`;
      const { path: sandboxPath } = await project.sandboxes.create({
        env: { CODEX_API_KEY: placeholder },
        instanceType: "lite",
        name: `codex-proof-${crypto.randomUUID()}`,
      });
      const sandbox = (await project.sandboxes.get(
        sandboxPath,
      )) as unknown as RpcStub<SandboxLiteDurableObject>;

      try {
        const install = await sandbox.exec(
          `npm install --prefix /tmp/codex-proof --no-audit --no-fund --ignore-scripts --package-lock=false @openai/codex@${CODEX_VERSION}`,
          { timeout: 180_000 },
        );
        expect(install.exitCode, install.stderr).toBe(0);

        const mkdir = await sandbox.exec("mkdir -p /root/.codex-proof", { timeout: 10_000 });
        expect(mkdir.exitCode, mkdir.stderr).toBe(0);
        const turn = await sandbox.exec(
          "CODEX_HOME=/root/.codex-proof RUST_LOG=warn " +
            "/tmp/codex-proof/node_modules/.bin/codex exec --json --ephemeral " +
            "--skip-git-repo-check " +
            `'Reply with exactly ${COMPLETION_MARKER} and nothing else.'`,
          { timeout: 180_000 },
        );
        expect(turn.exitCode, turn.stderr).toBe(0);

        const events = parseCodexEvents(turn.stdout);
        const threadStarted = events.find((event) => event.type === "thread.started");
        expect(threadStarted?.thread_id).toEqual(expect.any(String));
        expect(events.some((event) => event.type === "turn.started")).toBe(true);
        expect(
          events.find(
            (event) => event.type === "item.completed" && event.item?.type === "agent_message",
          )?.item?.text,
        ).toBe(COMPLETION_MARKER);
        expect(events.find((event) => event.type === "turn.completed")?.usage).toMatchObject({
          input_tokens: expect.any(Number),
          output_tokens: expect.any(Number),
        });

        // Codex logs this exact warning when a WebSocket attempt is replayed
        // over HTTP. A fresh secret also records exactly one upstream use for
        // the successful single-socket turn.
        expect(turn.stderr).not.toContain("falling back to HTTP");
        await waitForCondition(async () => (await secret.__describe()).audit.usedCount === 1, {
          description: "one Codex Responses WebSocket secret use",
        });

        const sandboxKey = await sandbox.exec('printf %s "$CODEX_API_KEY"', { timeout: 10_000 });
        expect(sandboxKey.stdout).toBe(placeholder);
        expect(
          [turn.stdout, turn.stderr, JSON.stringify(await secret.__describe())].some((value) =>
            value.includes(openAiKey),
          ),
        ).toBe(false);
      } finally {
        // A timed-out npm/Codex process must not turn this opt-in proof into a
        // 25-minute cleanup wait. Give the remote destroy a bounded chance.
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(resolve, 20_000);
          void sandbox
            .destroy()
            .catch(() => {})
            .finally(() => {
              clearTimeout(timeout);
              resolve();
            });
        });
      }
    },
  );
});
