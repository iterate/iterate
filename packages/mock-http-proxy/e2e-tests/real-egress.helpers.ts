import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { x } from "tinyexec";
import { expect } from "vitest";
import type { HarEntryWithExtensions, HarWithExtensions } from "../src/har/har-extensions.ts";

const thisDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(thisDir, "..");
const httpClientScriptsDir = join(packageRoot, "src", "integration", "http-client-scripts");

type BaseScriptOutput = {
  ok: boolean;
};

export type OpenAiScriptOutput = BaseScriptOutput & {
  endpoint: "openai.websocket-mode";
  eventType: string;
  eventTypes: string[];
  sendCount: number;
  receiveEventCount: number;
  completedCount: number;
  responseChain: string[];
  model: string;
  timeoutMs: number;
  proxyEnabled: boolean;
};

export type SlackScriptOutput = BaseScriptOutput & {
  endpoint: "slack.auth.test";
  teamId: string | null;
  userId: string | null;
};

export async function readHarFile(path: string): Promise<HarWithExtensions> {
  return JSON.parse(await readFile(path, "utf8")) as HarWithExtensions;
}

export async function runOpenAiScript(options: {
  mitmEnv: Record<string, string>;
  timeoutMs: number;
}): Promise<OpenAiScriptOutput> {
  const result = await x(
    "pnpm",
    ["exec", "tsx", join(httpClientScriptsDir, "openai-responses-websockets.ts")],
    {
      throwOnError: true,
      nodeOptions: {
        env: {
          ...process.env,
          ...options.mitmEnv,
          OPENAI_API_KEY: process.env.OPENAI_API_KEY,
          OPENAI_REALTIME_TIMEOUT_MS: String(options.timeoutMs),
        },
        cwd: packageRoot,
        stdio: "pipe",
      },
    },
  );

  return JSON.parse(result.stdout.trim()) as OpenAiScriptOutput;
}

export async function runSlackScript(egressUrl: string): Promise<SlackScriptOutput> {
  const result = await x(
    "pnpm",
    ["exec", "tsx", join(httpClientScriptsDir, "slack-auth-test.ts")],
    {
      throwOnError: true,
      nodeOptions: {
        env: {
          ...process.env,
          SLACK_BOT_TOKEN: process.env.SLACK_CI_BOT_TOKEN,
          SLACK_API_URL: `${egressUrl}/api/`,
          SLACK_TARGET_URL: "https://slack.com",
        },
        cwd: packageRoot,
        stdio: "pipe",
      },
    },
  );

  return JSON.parse(result.stdout.trim()) as SlackScriptOutput;
}

export async function runCurlThroughMitm(mitmUrl: string, proxyCaCertPath: string): Promise<void> {
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

export function expectOpenAiScriptOutput(output: OpenAiScriptOutput): void {
  expect(output).toMatchObject({
    ok: true,
    endpoint: "openai.websocket-mode",
    sendCount: 2,
    completedCount: 2,
  });
  expect(output.receiveEventCount).toBeGreaterThanOrEqual(2);
  expect(output.responseChain.length).toBeGreaterThanOrEqual(2);
}

export function expectSlackScriptOutput(output: SlackScriptOutput): void {
  expect(output).toMatchObject({
    ok: true,
    endpoint: "slack.auth.test",
  });
}

export function expectHarHosts(har: HarWithExtensions, requiredHosts: string[]): void {
  const hosts = har.log.entries.map((entry) => new URL(entry.request.url).host);
  for (const host of requiredHosts) {
    expect(hosts.some((candidate) => candidate === host)).toBe(true);
  }
  expect(hosts.some((host) => host === "127.0.0.1" || host.startsWith("127.0.0.1:"))).toBe(false);
}

export function expectOpenAiWebSocketHar(har: HarWithExtensions): void {
  const websocketEntry = findOpenAiWebSocketEntry(har);
  expect(websocketEntry).toBeDefined();
  expect(websocketEntry?._resourceType).toBe("websocket");

  const sendCount =
    websocketEntry?._webSocketMessages?.filter((message) => message.type === "send").length ?? 0;
  const receiveCount =
    websocketEntry?._webSocketMessages?.filter((message) => message.type === "receive").length ?? 0;
  expect(sendCount).toBeGreaterThanOrEqual(2);
  expect(receiveCount).toBeGreaterThanOrEqual(2);
}

export function expectHarContainsUrl(har: HarWithExtensions, expectedUrlPart: string): void {
  expect(har.log.entries.some((entry) => entry.request.url.includes(expectedUrlPart))).toBe(true);
}

function findOpenAiWebSocketEntry(har: HarWithExtensions): HarEntryWithExtensions | undefined {
  return har.log.entries.find(
    (entry) =>
      entry.request.url.startsWith("wss://api.openai.com/") &&
      Array.isArray(entry._webSocketMessages),
  );
}
