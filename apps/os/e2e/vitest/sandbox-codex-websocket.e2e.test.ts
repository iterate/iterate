import type { RpcStub } from "capnweb";
import { expect, test } from "vitest";
import type { SandboxLiteDurableObject } from "../../src/domains/sandboxes/cloudflare/cloudflare-sandbox-durable-object.ts";
import { waitForCondition } from "../test-support/wait-for-condition.ts";
import { CODEX_VERSION } from "./sandbox-websocket-proof-programs.ts";
import { adminSecret, deployedBaseUrl, withItxSession } from "./test-helpers.ts";

const COMPLETION_MARKER = "ITERATE_WEBSOCKET_SMOKE_OK";

const exactCodexProofEnabled = process.env.OS_E2E_STOCK_CODEX_WEBSOCKET === "1";

test.skipIf(deployedBaseUrl() === null || !exactCodexProofEnabled)(
  `completes a whole OpenAI turn with unmodified @openai/codex@${CODEX_VERSION}`,
  { timeout: 180_000 },
  async () => {
    const openAiKey = liveOpenAiKey();
    const secretPath = `/secrets/codex-proof/${crypto.randomUUID()}`;

    using session = withItxSession();
    using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
    using project = await itx.projects.get(`sandbox-codex-${crypto.randomUUID()}`).create({});
    using secret = project.secrets.get(secretPath);
    await secret.create({
      egress: { urls: ["https://api.openai.com"] },
      material: openAiKey,
    });
    await waitForCondition(async () => (await secret.__describe()).hasMaterial, {
      description: "Codex proof secret processor to fold the OpenAI key",
    });

    const placeholder = `getSecret("${secretPath}")`;
    const sandboxPath = `/sandboxes/codex-proof-${crypto.randomUUID()}`;
    await project.sandboxes.get(sandboxPath).create({
      env: { CODEX_API_KEY: placeholder },
      instanceType: "lite",
    });
    const sandbox = (await project.sandboxes.get(
      sandboxPath,
    )) as unknown as RpcStub<SandboxLiteDurableObject>;

    try {
      const install = await sandbox.exec(
        `npm install --prefix /tmp/codex-proof --no-audit --no-fund --ignore-scripts --package-lock=false @openai/codex@${CODEX_VERSION}`,
        { timeout: 180_000 },
      );
      expect(install, install.stderr).toMatchObject({ exitCode: 0 });

      const mkdir = await sandbox.exec("mkdir -p /root/.codex-proof", { timeout: 10_000 });
      expect(mkdir, mkdir.stderr).toMatchObject({ exitCode: 0 });
      const turn = await sandbox.exec(
        "CODEX_HOME=/root/.codex-proof RUST_LOG=warn " +
          "/tmp/codex-proof/node_modules/.bin/codex exec --json --ephemeral " +
          "--skip-git-repo-check " +
          `'Reply with exactly ${COMPLETION_MARKER} and nothing else.'`,
        { timeout: 180_000 },
      );
      expect(turn, turn.stderr).toMatchObject({ exitCode: 0 });

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

      // A successful single-socket turn neither falls back nor uses the secret twice.
      expect(turn.stderr).not.toContain("falling back to HTTP");
      await waitForCondition(async () => (await secret.__describe()).audit.usedCount === 1, {
        description: "one Codex Responses WebSocket secret use",
      });

      const sandboxKey = await sandbox.exec('printf %s "$CODEX_API_KEY"', { timeout: 10_000 });
      expect(sandboxKey).toMatchObject({ stdout: placeholder });
      expect(
        [turn.stdout, turn.stderr, JSON.stringify(await secret.__describe())].some((value) =>
          value.includes(openAiKey),
        ),
      ).toBe(false);
    } finally {
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

function liveOpenAiKey(): string {
  const key = process.env.APP_CONFIG_OPEN_AI_API_KEY?.trim();
  if (!key) {
    throw new Error("OS_E2E_STOCK_CODEX_WEBSOCKET=1 requires Doppler APP_CONFIG_OPEN_AI_API_KEY");
  }
  return key;
}

type CodexEvent = {
  item?: { text?: string; type?: string };
  thread_id?: string;
  type?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
};

function parseCodexEvents(stdout: string): CodexEvent[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CodexEvent);
}
