import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { x } from "tinyexec";
import { describe, expect, test } from "vitest";
import { readHarFile } from "../har/har-extensions.ts";
import { fromTrafficWithWebSocket } from "../replay/from-traffic-with-websocket.ts";
import {
  useMitmProxy,
  useMockHttpServer,
  useTemporaryDirectory,
} from "../server/mock-http-server-fixture.ts";

const thisDir = dirname(fileURLToPath(import.meta.url));

type OpenAiScriptOutput = {
  ok: boolean;
  endpoint: "openai.websocket-mode";
  sendCount: number;
  receiveEventCount: number;
  completedCount: number;
  responseChain: string[];
};

type SlackScriptOutput = {
  ok: boolean;
  endpoint: "slack.auth.test";
};

async function runOpenAiScript(options: {
  mitmEnv: Record<string, string>;
  timeoutMs: number;
}): Promise<OpenAiScriptOutput> {
  const result = await x(
    "pnpm",
    ["exec", "tsx", join(thisDir, "http-client-scripts", "openai-responses-websockets.ts")],
    {
      throwOnError: false,
      nodeOptions: {
        env: {
          ...process.env,
          ...options.mitmEnv,
          OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "sk-test-replay-key",
          OPENAI_REALTIME_TIMEOUT_MS: String(options.timeoutMs),
        },
        cwd: join(thisDir, "..", ".."),
        stdio: "pipe",
      },
    },
  );

  if (result.exitCode !== 0) {
    throw new Error(
      [
        `openai replay script failed with exitCode=${String(result.exitCode)}`,
        `stdout: ${result.stdout.trim()}`,
        `stderr: ${result.stderr.trim()}`,
      ].join("\n"),
    );
  }

  return JSON.parse(result.stdout.trim()) as OpenAiScriptOutput;
}

async function runSlackScript(egressUrl: string): Promise<SlackScriptOutput> {
  const result = await x(
    "pnpm",
    ["exec", "tsx", join(thisDir, "http-client-scripts", "slack-auth-test.ts")],
    {
      throwOnError: true,
      nodeOptions: {
        env: {
          ...process.env,
          SLACK_BOT_TOKEN: process.env.SLACK_CI_BOT_TOKEN ?? "xoxb-replay-token",
          SLACK_API_URL: `${egressUrl}/api/`,
          SLACK_TARGET_URL: "https://slack.com",
        },
        cwd: join(thisDir, "..", ".."),
        stdio: "pipe",
      },
    },
  );

  return JSON.parse(result.stdout.trim()) as SlackScriptOutput;
}

async function runCurlThroughMitm(mitmUrl: string, proxyCaCertPath: string): Promise<void> {
  await x(
    "curl",
    [
      "--silent",
      "--show-error",
      "--fail",
      "--proxy",
      mitmUrl,
      "--proxy-cacert",
      proxyCaCertPath,
      "http://example.com/",
    ],
    {
      throwOnError: true,
      nodeOptions: {
        env: {
          ...process.env,
          HTTP_PROXY: "",
          HTTPS_PROXY: "",
          http_proxy: "",
          https_proxy: "",
          ALL_PROXY: "",
          all_proxy: "",
          NO_PROXY: "",
          no_proxy: "",
        },
        stdio: "pipe",
      },
    },
  );
}

async function withTimeout<T>(label: string, promise: Promise<T>, timeoutMs: number): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`${label} timed out after ${String(timeoutMs)}ms`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

describe("replays parallel HAR fixture via source traffic handlers", () => {
  using tmpDir = useTemporaryDirectory("mock-http-proxy-api-replay-fixture-");

  test("replays openai + slack + curl in parallel from fixture HAR", async () => {
    const sourceHarPath = join(thisDir, "fixtures", "parallel-openai-slack-curl.har");
    const sourceHar = await readHarFile(sourceHarPath);
    const replayHarPath = join(tmpDir.path, "parallel-openai-slack-curl.replay-output.har");
    const replayHandlers = fromTrafficWithWebSocket(sourceHar);

    await using egress = await useMockHttpServer({
      recorder: { harPath: replayHarPath },
      onUnhandledRequest: "error",
    });
    egress.use(...replayHandlers);
    await using mitm = await useMitmProxy({
      externalEgressProxyUrl: egress.url,
    });

    const mitmEnv = mitm.envForNode();
    const proxyCaCertPath = mitmEnv.NODE_EXTRA_CA_CERTS;
    if (!proxyCaCertPath) {
      throw new Error("missing NODE_EXTRA_CA_CERTS from useMitmProxy env");
    }

    const [openaiOutput, slackOutput] = await Promise.all([
      withTimeout(
        "openai websocket replay",
        runOpenAiScript({
          mitmEnv,
          timeoutMs: 2_500,
        }),
        4_000,
      ),
      withTimeout("slack replay", runSlackScript(egress.url), 4_000),
      withTimeout("curl replay", runCurlThroughMitm(mitm.url, proxyCaCertPath), 4_000),
    ]);

    expect(openaiOutput.ok).toBe(true);
    expect(openaiOutput.endpoint).toBe("openai.websocket-mode");
    expect(openaiOutput.sendCount).toBe(2);
    expect(openaiOutput.completedCount).toBe(2);
    expect(openaiOutput.receiveEventCount).toBeGreaterThanOrEqual(2);
    expect(openaiOutput.responseChain.length).toBeGreaterThanOrEqual(2);
    expect(slackOutput).toMatchObject({ ok: true, endpoint: "slack.auth.test" });
  }, 10_000);
});
