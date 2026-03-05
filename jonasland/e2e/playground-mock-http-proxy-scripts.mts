import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readHarFile } from "../../packages/mock-http-proxy/src/har/har-extensions.ts";
import { fromTrafficWithWebSocket } from "../../packages/mock-http-proxy/src/replay/from-traffic-with-websocket.ts";
import {
  useMitmProxy,
  useMockHttpServer,
} from "../../packages/mock-http-proxy/src/server/mock-http-server-fixture.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const packageRoot = join(repoRoot, "packages", "mock-http-proxy");
const scriptsDir = join(packageRoot, "src", "integration", "http-client-scripts");
const fixturesDir = join(packageRoot, "src", "integration", "fixtures");
const execFileAsync = promisify(execFile);

async function runCommand(params: {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}): Promise<{ stdout: string; stderr: string }> {
  const env = {
    ...process.env,
    ...(params.env ?? {}),
  } as NodeJS.ProcessEnv;
  return await execFileAsync(params.command, params.args, { cwd: params.cwd, env });
}

async function main(): Promise<void> {
  const outputDir = join(repoRoot, "jonasland", "e2e", "artifacts", "mock-http-proxy");
  await mkdir(outputDir, { recursive: true });
  const replayHarPath = join(outputDir, "parallel-openai-slack-curl.replay-output.har");
  const realOpenAiHarPath = join(outputDir, "openai-responses-websockets.real-egress.har");
  const sourceHarPath = join(fixturesDir, "parallel-openai-slack-curl.har");
  const sourceHar = await readHarFile(sourceHarPath);
  const replayHandlers = fromTrafficWithWebSocket(sourceHar);

  await using egress = await useMockHttpServer({
    recorder: { harPath: replayHarPath },
    onUnhandledRequest: "error",
  });
  egress.use(...replayHandlers);

  await using mitm = await useMitmProxy({
    proxyTargetUrl: egress.url,
  });

  const mitmEnv = mitm.envForNode();
  const proxyCaCertPath = mitmEnv.NODE_EXTRA_CA_CERTS;
  if (!proxyCaCertPath) {
    throw new Error("missing NODE_EXTRA_CA_CERTS from useMitmProxy env");
  }

  const [openaiResult, slackResult, curlResult] = await Promise.all([
    runCommand({
      command: "pnpm",
      args: ["exec", "tsx", join(scriptsDir, "openai-responses-websockets.ts")],
      cwd: packageRoot,
      env: {
        ...mitmEnv,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "sk-test-replay-key",
        OPENAI_REALTIME_TIMEOUT_MS: "4000",
      },
    }),
    runCommand({
      command: "pnpm",
      args: ["exec", "tsx", join(scriptsDir, "slack-auth-test.ts")],
      cwd: packageRoot,
      env: {
        SLACK_BOT_TOKEN: process.env.SLACK_CI_BOT_TOKEN ?? "xoxb-replay-token",
        SLACK_API_URL: `${egress.url}/api/`,
        SLACK_TARGET_URL: "https://slack.com",
      },
    }),
    runCommand({
      command: "curl",
      args: [
        "--silent",
        "--show-error",
        "--fail",
        "--proxy",
        mitm.url,
        "--proxy-cacert",
        proxyCaCertPath,
        "http://example.com/",
      ],
      cwd: packageRoot,
      env: {
        HTTP_PROXY: "",
        HTTPS_PROXY: "",
        http_proxy: "",
        https_proxy: "",
        ALL_PROXY: "",
        all_proxy: "",
        NO_PROXY: "",
        no_proxy: "",
      },
    }),
  ]);

  await egress.writeHar();
  const replayHar = await readHarFile(replayHarPath);
  const urls = replayHar.log.entries.map((entry) => entry.request.url);
  const wsEntry = replayHar.log.entries.find((entry) =>
    entry.request.url.startsWith("wss://api.openai.com/"),
  );
  const wsMessages = wsEntry?._webSocketMessages ?? [];

  console.log("[mock-http-proxy-playground] openai stdout:", openaiResult.stdout.trim());
  console.log("[mock-http-proxy-playground] slack stdout:", slackResult.stdout.trim());
  console.log("[mock-http-proxy-playground] curl bytes:", curlResult.stdout.trim().length);
  console.log("[mock-http-proxy-playground] HAR path:", replayHarPath);
  console.log(
    "[mock-http-proxy-playground] URLs:",
    JSON.stringify(urls, null, 2),
  );
  console.log(
    "[mock-http-proxy-playground] websocket summary:",
    JSON.stringify(
      {
        url: wsEntry?.request.url ?? null,
        sendCount: wsMessages.filter((message) => message.type === "send").length,
        receiveCount: wsMessages.filter((message) => message.type === "receive").length,
      },
      null,
      2,
    ),
  );

  const openAiApiKey = process.env.OPENAI_API_KEY;
  if (!openAiApiKey) {
    console.log(
      "[mock-http-proxy-playground] OPENAI_API_KEY not set; skipping real-egress websocket capture",
    );
    return;
  }

  await using realEgress = await useMockHttpServer({
    recorder: { harPath: realOpenAiHarPath },
    onUnhandledRequest: "bypass",
  });
  await using realMitm = await useMitmProxy({
    proxyTargetUrl: realEgress.url,
  });

  const realMitmEnv = realMitm.envForNode();
  const realOpenAiResult = await runCommand({
    command: "pnpm",
    args: ["exec", "tsx", join(scriptsDir, "openai-responses-websockets.ts")],
    cwd: packageRoot,
    env: {
      ...realMitmEnv,
      OPENAI_API_KEY: openAiApiKey,
      OPENAI_REALTIME_TIMEOUT_MS: "5000",
    },
  });
  await realEgress.writeHar();
  const realHar = await readHarFile(realOpenAiHarPath);
  const realWsEntries = realHar.log.entries.filter(
    (entry) =>
      entry.request.url.startsWith("wss://api.openai.com/") &&
      Array.isArray(entry._webSocketMessages),
  );
  const realHttpEntries = realHar.log.entries.filter((entry) =>
    entry.request.url.includes("api.openai.com"),
  );

  console.log("[mock-http-proxy-playground] real openai stdout:", realOpenAiResult.stdout.trim());
  console.log("[mock-http-proxy-playground] real HAR path:", realOpenAiHarPath);
  console.log(
    "[mock-http-proxy-playground] real API URLs:",
    JSON.stringify(realHttpEntries.map((entry) => entry.request.url), null, 2),
  );
  console.log(
    "[mock-http-proxy-playground] real websocket entries:",
    JSON.stringify(
      realWsEntries.map((entry) => ({
        url: entry.request.url,
        sendCount: (entry._webSocketMessages ?? []).filter((message) => message.type === "send")
          .length,
        receiveCount: (entry._webSocketMessages ?? []).filter(
          (message) => message.type === "receive",
        ).length,
      })),
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

