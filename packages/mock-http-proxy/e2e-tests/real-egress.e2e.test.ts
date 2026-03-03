import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { http, HttpResponse } from "msw";
import { x } from "tinyexec";
import { describe, expect, test } from "vitest";
import type { HarEntryWithExtensions, HarWithExtensions } from "../src/har/har-extensions.ts";
import {
  useMitmProxy,
  useMockHttpServer,
  useTemporaryDirectory,
} from "../src/server/mock-http-server-fixture.ts";

const thisDir = dirname(fileURLToPath(import.meta.url));

type OpenAiScriptOutput = {
  ok: boolean;
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
}): Promise<OpenAiScriptOutput> {
  const result = await x(
    "pnpm",
    [
      "exec",
      "tsx",
      join(
        thisDir,
        "..",
        "src",
        "integration",
        "http-client-scripts",
        "openai-responses-websockets.ts",
      ),
    ],
    {
      throwOnError: true,
      nodeOptions: {
        env: {
          ...process.env,
          ...options.mitmEnv,
          OPENAI_API_KEY: process.env.OPENAI_API_KEY,
          OPENAI_REALTIME_TIMEOUT_MS: String(options.timeoutMs),
        },
        cwd: join(thisDir, ".."),
        stdio: "pipe",
      },
    },
  );

  return JSON.parse(result.stdout.trim()) as OpenAiScriptOutput;
}

async function runSlackScript(egressUrl: string): Promise<SlackScriptOutput> {
  const result = await x(
    "pnpm",
    [
      "exec",
      "tsx",
      join(thisDir, "..", "src", "integration", "http-client-scripts", "slack-auth-test.ts"),
    ],
    {
      throwOnError: true,
      nodeOptions: {
        env: {
          ...process.env,
          SLACK_BOT_TOKEN: process.env.SLACK_CI_BOT_TOKEN,
          SLACK_API_URL: `${egressUrl}/api/`,
          SLACK_TARGET_URL: "https://slack.com",
        },
        cwd: join(thisDir, ".."),
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
      recorder: { harPath },
      onUnhandledRequest: "bypass",
    });
    await using mitm = await useMitmProxy({
      externalEgressProxyUrl: egress.url,
    });

    const output = await runOpenAiScript({
      mitmEnv: mitm.envForNode(),
      timeoutMs: 4_000,
    });
    expect(output).toMatchObject({
      ok: true,
      endpoint: "openai.websocket-mode",
      sendCount: 2,
      completedCount: 2,
    });
    expect(output.receiveEventCount).toBeGreaterThanOrEqual(2);
    expect(output.responseChain.length).toBeGreaterThanOrEqual(2);

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
      recorder: { harPath },
      onUnhandledRequest: "bypass",
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
      recorder: { harPath },
      onUnhandledRequest: "bypass",
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
      recorder: { harPath },
      onUnhandledRequest: "bypass",
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
      }),
      runSlackScript(egress.url),
      runCurlThroughMitm(mitm.url, proxyCaCertPath),
    ]);

    expect(openaiOutput.ok).toBe(true);
    expect(openaiOutput.sendCount).toBe(2);
    expect(openaiOutput.completedCount).toBe(2);
    expect(openaiOutput.receiveEventCount).toBeGreaterThanOrEqual(2);
    expect(openaiOutput.responseChain.length).toBeGreaterThanOrEqual(2);
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

describe("records har archives for handled msw traffic", () => {
  using tmpDir = useTemporaryDirectory("mock-http-proxy-api-msw-handled-");

  test("captures handled request + response into har", async () => {
    const harPath = join(tmpDir.path, "handled-msw.har");

    await using server = await useMockHttpServer({
      recorder: { harPath, includeHandledRequests: true },
      onUnhandledRequest: "error",
    });
    server.use(
      http.post("https://api.example.com/echo", async ({ request }) => {
        const body = (await request.json()) as { message?: string };
        return HttpResponse.json(
          { ok: true, echoed: body.message ?? null },
          { status: 201, headers: { "x-msw-handler": "echo" } },
        );
      }),
    );

    const response = await fetch(`${server.url}/echo?source=msw`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-client-id": "msw-handled-test",
        forwarded: "for=203.0.113.42; host=api.example.com; proto=https",
      },
      body: JSON.stringify({ message: "hello-from-client" }),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true, echoed: "hello-from-client" });

    await server.writeHar();
    const har = await readHarFile(harPath);
    const entry = har.log.entries.find(
      (candidate) => candidate.request.url === "https://api.example.com/echo?source=msw",
    );
    expect(entry).toBeDefined();
    if (!entry) {
      throw new Error("expected handled msw entry in HAR");
    }

    expect(entry.request.method).toBe("POST");
    expect(
      entry.request.headers.some(
        (header) =>
          header.name.toLowerCase() === "x-client-id" && header.value === "msw-handled-test",
      ),
    ).toBe(true);
    expect(entry.response.status).toBe(201);
    expect(
      entry.response.headers.some(
        (header) => header.name.toLowerCase() === "x-msw-handler" && header.value === "echo",
      ),
    ).toBe(true);
  });
});
