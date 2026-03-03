import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { x } from "tinyexec";
import { describe, expect, test } from "vitest";
import type { HarEntryWithExtensions, HarWithExtensions } from "../har-type.ts";
import { useMitmProxy, useMockHttpServer, useTemporaryDirectory } from "./test-helpers.ts";

const thisDir = dirname(fileURLToPath(import.meta.url));

type OpenAiScriptOutput = {
  ok: boolean;
  endpoint: "openai.websocket-mode";
  eventType: string;
  eventTypes: string[];
  sendCount: number;
  receiveEventCount: number;
  sessionUpdatedCount: number;
  updateCount: number;
  model: string;
  timeoutMs: number;
};

type SlackScriptOutput = {
  ok: boolean;
  endpoint: "slack.auth.test";
  teamId: string | null;
  userId: string | null;
};

async function readHarFile(path: string): Promise<HarWithExtensions> {
  return JSON.parse(await readFile(path, "utf8")) as HarWithExtensions;
}

async function runOpenAiScript(options: {
  mitmEnv: Record<string, string>;
  timeoutMs: number;
  updateCount: number;
}): Promise<OpenAiScriptOutput> {
  const result = await x(
    "pnpm",
    ["exec", "tsx", join(thisDir, "http-client-scripts", "openai-responses-websockets.ts")],
    {
      throwOnError: true,
      nodeOptions: {
        env: {
          ...process.env,
          ...options.mitmEnv,
          OPENAI_API_KEY: process.env.OPENAI_API_KEY,
          OPENAI_REALTIME_TIMEOUT_MS: String(options.timeoutMs),
          OPENAI_REALTIME_UPDATE_COUNT: String(options.updateCount),
        },
        cwd: join(thisDir, "..", ".."),
        stdio: "pipe",
      },
    },
  );

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
          SLACK_BOT_TOKEN: process.env.SLACK_CI_BOT_TOKEN,
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

function hostsFromHar(har: HarWithExtensions): string[] {
  return har.log.entries.map((entry) => new URL(entry.request.url).host);
}

function expectNoLoopbackHosts(hosts: string[]): void {
  expect(hosts.some((host) => host === "127.0.0.1" || host.startsWith("127.0.0.1:"))).toBe(false);
}

function findOpenAiWebSocketEntry(har: HarWithExtensions): HarEntryWithExtensions | undefined {
  return har.log.entries.find(
    (entry) =>
      entry.request.url.startsWith("wss://api.openai.com/") &&
      Array.isArray(entry._webSocketMessages),
  );
}

describe("records har archives for http-client-scripts", () => {
  using tmpDir = useTemporaryDirectory();
  console.log(
    [
      "--------------------------------",
      "HAR archive folder:",
      tmpDir.path,
      "",
      "1. Open folder in finder:",
      `open \"${tmpDir.path}\"`,
      "2. Open test:blank in Chrome",
      "3. Drag har onto network tab",
      "--------------------------------",
    ].join("\n"),
  );

  test.concurrent("for openai responses-websockets", async () => {
    const harPath = join(
      tmpDir.path,
      "records-har-archives-for-http-client-scripts-for-openai-responses-websockets.har",
    );
    await using egress = await useMockHttpServer({
      harPath,
      mode: "record",
    });
    await using mitm = await useMitmProxy({
      externalEgressProxyUrl: egress.url,
    });

    const output = await runOpenAiScript({
      mitmEnv: mitm.envForNode(),
      timeoutMs: 4_000,
      updateCount: 2,
    });
    expect(output).toMatchObject({
      ok: true,
      endpoint: "openai.websocket-mode",
      updateCount: 2,
      sendCount: 2,
    });
    expect(output.receiveEventCount).toBeGreaterThanOrEqual(2);
    expect(output.sessionUpdatedCount).toBeGreaterThanOrEqual(1);

    await egress.writeHar();
    const har = await readHarFile(harPath);
    const hosts = hostsFromHar(har);
    expect(hosts.some((host) => host === "api.openai.com")).toBe(true);
    expectNoLoopbackHosts(hosts);

    const websocketEntry = findOpenAiWebSocketEntry(har);
    expect(websocketEntry).toBeDefined();
    expect(websocketEntry?._resourceType).toBe("websocket");

    const sendCount =
      websocketEntry?._webSocketMessages?.filter((message) => message.type === "send").length ?? 0;
    const receiveCount =
      websocketEntry?._webSocketMessages?.filter((message) => message.type === "receive").length ??
      0;
    expect(sendCount).toBeGreaterThanOrEqual(2);
    expect(receiveCount).toBeGreaterThanOrEqual(2);
  }, 12_000);

  test.concurrent("for slack auth-test", async () => {
    const harPath = join(
      tmpDir.path,
      "records-har-archives-for-http-client-scripts-for-slack-auth-test.har",
    );
    await using egress = await useMockHttpServer({
      harPath,
      mode: "record",
    });

    const output = await runSlackScript(egress.url);
    expect(output).toMatchObject({
      ok: true,
      endpoint: "slack.auth.test",
    });

    await egress.writeHar();
    const har = await readHarFile(harPath);
    const hosts = hostsFromHar(har);
    expect(hosts.some((host) => host === "slack.com")).toBe(true);
    expectNoLoopbackHosts(hosts);
    expect(
      har.log.entries.some((entry) =>
        entry.request.url.includes("https://slack.com/api/auth.test"),
      ),
    ).toBe(true);
  }, 20_000);

  test.concurrent("for curl via proxy-only mode", async () => {
    const harPath = join(
      tmpDir.path,
      "records-har-archives-for-http-client-scripts-for-curl-via-proxy-only-mode.har",
    );
    await using egress = await useMockHttpServer({
      harPath,
      mode: "record",
    });
    await using mitm = await useMitmProxy({
      externalEgressProxyUrl: egress.url,
    });

    const mitmEnv = mitm.envForNode();
    const proxyCaCertPath = mitmEnv.NODE_EXTRA_CA_CERTS;
    if (!proxyCaCertPath) {
      throw new Error("missing NODE_EXTRA_CA_CERTS from useMitmProxy env");
    }

    await runCurlThroughMitm(mitm.url, proxyCaCertPath);

    await egress.writeHar();
    const har = await readHarFile(harPath);
    const hosts = hostsFromHar(har);
    expect(hosts.some((host) => host === "example.com")).toBe(true);
    expectNoLoopbackHosts(hosts);
    expect(har.log.entries.some((entry) => entry.request.url.includes("http://example.com/"))).toBe(
      true,
    );
  });

  test.concurrent("for openai + slack + curl in parallel via Promise.all", async () => {
    const harPath = join(
      tmpDir.path,
      "records-har-archives-for-http-client-scripts-for-parallel-openai-slack-curl.har",
    );
    await using egress = await useMockHttpServer({
      harPath,
      mode: "record",
    });
    await using mitm = await useMitmProxy({
      externalEgressProxyUrl: egress.url,
    });

    const mitmEnv = mitm.envForNode();
    const proxyCaCertPath = mitmEnv.NODE_EXTRA_CA_CERTS;
    if (!proxyCaCertPath) {
      throw new Error("missing NODE_EXTRA_CA_CERTS from useMitmProxy env");
    }

    const [openaiOutput, slackOutput] = await Promise.all([
      runOpenAiScript({
        mitmEnv,
        timeoutMs: 4_000,
        updateCount: 2,
      }),
      runSlackScript(egress.url),
      runCurlThroughMitm(mitm.url, proxyCaCertPath),
    ]);

    expect(openaiOutput.ok).toBe(true);
    expect(openaiOutput.sendCount).toBe(2);
    expect(openaiOutput.receiveEventCount).toBeGreaterThanOrEqual(2);
    expect(openaiOutput.sessionUpdatedCount).toBeGreaterThanOrEqual(1);
    expect(slackOutput).toMatchObject({ ok: true, endpoint: "slack.auth.test" });

    await egress.writeHar();
    const har = await readHarFile(harPath);
    const hosts = hostsFromHar(har);
    expect(hosts.some((host) => host === "api.openai.com")).toBe(true);
    expect(hosts.some((host) => host === "slack.com")).toBe(true);
    expect(hosts.some((host) => host === "example.com")).toBe(true);
    expectNoLoopbackHosts(hosts);

    const websocketEntry = findOpenAiWebSocketEntry(har);
    expect(websocketEntry).toBeDefined();
    expect(websocketEntry?._resourceType).toBe("websocket");

    const sendCount =
      websocketEntry?._webSocketMessages?.filter((message) => message.type === "send").length ?? 0;
    const receiveCount =
      websocketEntry?._webSocketMessages?.filter((message) => message.type === "receive").length ??
      0;
    expect(sendCount).toBeGreaterThanOrEqual(2);
    expect(receiveCount).toBeGreaterThanOrEqual(2);

    expect(
      har.log.entries.some((entry) =>
        entry.request.url.includes("https://slack.com/api/auth.test"),
      ),
    ).toBe(true);
    expect(har.log.entries.some((entry) => entry.request.url.includes("http://example.com/"))).toBe(
      true,
    );
  }, 14_000);

  test.sequential("writes slugified HAR files into one shared directory", async () => {
    const harNames = (await readdir(tmpDir.path)).filter((name) => name.endsWith(".har")).sort();
    expect(harNames).toMatchInlineSnapshot(`
      [
        "records-har-archives-for-http-client-scripts-for-curl-via-proxy-only-mode.har",
        "records-har-archives-for-http-client-scripts-for-openai-responses-websockets.har",
        "records-har-archives-for-http-client-scripts-for-parallel-openai-slack-curl.har",
        "records-har-archives-for-http-client-scripts-for-slack-auth-test.har",
      ]
    `);
  });
});
