import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { x } from "tinyexec";
import { describe, expect, test } from "vitest";
import { readHarFile } from "../src/har/har-extensions.ts";
import {
  useMitmProxy,
  useMockHttpServer,
  useTemporaryDirectory,
} from "../src/server/mock-http-server-fixture.ts";

const thisDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(thisDir, "..");
const httpClientScriptsDir = join(packageRoot, "src", "integration", "http-client-scripts");

describe.skip("records HAR archives for real egress traffic (clean single-file variant)", () => {
  using tmpDir = useTemporaryDirectory("mock-http-proxy-real-egress-clean-");

  test.concurrent("OpenAI websocket script", async () => {
    const harPath = join(tmpDir.path, "openai-responses-websockets.har");

    await using egress = await useMockHttpServer({
      recorder: { harPath },
      onUnhandledRequest: "bypass",
    });

    await using mitm = await useMitmProxy({
      externalEgressProxyUrl: egress.url,
    });

    const result = await x(
      "pnpm",
      ["exec", "tsx", join(httpClientScriptsDir, "openai-responses-websockets.ts")],
      {
        throwOnError: true,
        nodeOptions: {
          env: {
            ...process.env,
            ...mitm.envForNode(),
            OPENAI_API_KEY: process.env.OPENAI_API_KEY,
            OPENAI_REALTIME_TIMEOUT_MS: "4000",
          },
          cwd: packageRoot,
          stdio: "pipe",
        },
      },
    );

    const output = JSON.parse(result.stdout.trim());
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

    const hosts = har.log.entries.map((e) => new URL(e.request.url).host);
    expect(hosts).toContain("api.openai.com");
    expect(hosts.some((h) => h === "127.0.0.1" || h.startsWith("127.0.0.1:"))).toBe(false);

    const wsEntry = har.log.entries.find(
      (e) =>
        e.request.url.startsWith("wss://api.openai.com/") && Array.isArray(e._webSocketMessages),
    );
    expect(wsEntry).toBeDefined();
    expect(wsEntry?._resourceType).toBe("websocket");
    expect(
      wsEntry?._webSocketMessages?.filter((m) => m.type === "send").length ?? 0,
    ).toBeGreaterThanOrEqual(2);
    expect(
      wsEntry?._webSocketMessages?.filter((m) => m.type === "receive").length ?? 0,
    ).toBeGreaterThanOrEqual(2);
  }, 12_000);

  test.concurrent("Slack auth.test script", async () => {
    const harPath = join(tmpDir.path, "slack-auth-test.har");

    await using egress = await useMockHttpServer({
      recorder: { harPath },
      onUnhandledRequest: "bypass",
    });

    const result = await x(
      "pnpm",
      ["exec", "tsx", join(httpClientScriptsDir, "slack-auth-test.ts")],
      {
        throwOnError: true,
        nodeOptions: {
          env: {
            ...process.env,
            SLACK_BOT_TOKEN: process.env.SLACK_CI_BOT_TOKEN,
            SLACK_API_URL: `${egress.url}/api/`,
            SLACK_TARGET_URL: "https://slack.com",
          },
          cwd: packageRoot,
          stdio: "pipe",
        },
      },
    );

    const output = JSON.parse(result.stdout.trim());
    expect(output).toMatchObject({ ok: true, endpoint: "slack.auth.test" });

    await egress.writeHar();
    const har = await readHarFile(harPath);

    const hosts = har.log.entries.map((e) => new URL(e.request.url).host);
    expect(hosts).toContain("slack.com");
    expect(hosts.some((h) => h === "127.0.0.1" || h.startsWith("127.0.0.1:"))).toBe(false);
    expect(
      har.log.entries.some((e) => e.request.url.includes("https://slack.com/api/auth.test")),
    ).toBe(true);
  }, 20_000);

  test.concurrent("curl via MITM proxy-only mode", async () => {
    const harPath = join(tmpDir.path, "curl-via-proxy-only-mode.har");

    await using egress = await useMockHttpServer({
      recorder: { harPath },
      onUnhandledRequest: "bypass",
    });

    await using mitm = await useMitmProxy({
      externalEgressProxyUrl: egress.url,
    });

    const mitmEnv = mitm.envForNode();
    await x(
      "curl",
      [
        "--silent",
        "--show-error",
        "--fail",
        "--proxy",
        mitm.url,
        "--proxy-cacert",
        mitmEnv.NODE_EXTRA_CA_CERTS!,
        "http://example.com/",
      ],
      { throwOnError: true, nodeOptions: { stdio: "pipe" } },
    );

    await egress.writeHar();
    const har = await readHarFile(harPath);

    const hosts = har.log.entries.map((e) => new URL(e.request.url).host);
    expect(hosts).toContain("example.com");
    expect(hosts.some((h) => h === "127.0.0.1" || h.startsWith("127.0.0.1:"))).toBe(false);
    expect(har.log.entries.some((e) => e.request.url.includes("http://example.com/"))).toBe(true);
  });

  test.concurrent("OpenAI + Slack + curl in parallel", async () => {
    const harPath = join(tmpDir.path, "parallel-openai-slack-curl.har");

    await using egress = await useMockHttpServer({
      recorder: { harPath },
      onUnhandledRequest: "bypass",
    });

    await using mitm = await useMitmProxy({
      externalEgressProxyUrl: egress.url,
    });

    const mitmEnv = mitm.envForNode();
    const [openAiResult, slackResult] = await Promise.all([
      x("pnpm", ["exec", "tsx", join(httpClientScriptsDir, "openai-responses-websockets.ts")], {
        throwOnError: true,
        nodeOptions: {
          env: {
            ...process.env,
            ...mitmEnv,
            OPENAI_API_KEY: process.env.OPENAI_API_KEY,
            OPENAI_REALTIME_TIMEOUT_MS: "4000",
          },
          cwd: packageRoot,
          stdio: "pipe",
        },
      }),
      x("pnpm", ["exec", "tsx", join(httpClientScriptsDir, "slack-auth-test.ts")], {
        throwOnError: true,
        nodeOptions: {
          env: {
            ...process.env,
            SLACK_BOT_TOKEN: process.env.SLACK_CI_BOT_TOKEN,
            SLACK_API_URL: `${egress.url}/api/`,
            SLACK_TARGET_URL: "https://slack.com",
          },
          cwd: packageRoot,
          stdio: "pipe",
        },
      }),
      x(
        "curl",
        [
          "--silent",
          "--show-error",
          "--fail",
          "--proxy",
          mitm.url,
          "--proxy-cacert",
          mitmEnv.NODE_EXTRA_CA_CERTS!,
          "http://example.com/",
        ],
        {
          throwOnError: true,
          nodeOptions: { stdio: "pipe" },
        },
      ),
    ]);

    const openAiOutput = JSON.parse(openAiResult.stdout.trim());
    expect(openAiOutput).toMatchObject({
      ok: true,
      endpoint: "openai.websocket-mode",
      sendCount: 2,
      completedCount: 2,
    });
    expect(openAiOutput.receiveEventCount).toBeGreaterThanOrEqual(2);
    expect(openAiOutput.responseChain.length).toBeGreaterThanOrEqual(2);

    const slackOutput = JSON.parse(slackResult.stdout.trim());
    expect(slackOutput).toMatchObject({ ok: true, endpoint: "slack.auth.test" });

    await egress.writeHar();
    const har = await readHarFile(harPath);

    const hosts = har.log.entries.map((e) => new URL(e.request.url).host);
    expect(hosts).toContain("api.openai.com");
    expect(hosts).toContain("slack.com");
    expect(hosts).toContain("example.com");
    expect(hosts.some((h) => h === "127.0.0.1" || h.startsWith("127.0.0.1:"))).toBe(false);

    const wsEntry = har.log.entries.find(
      (e) =>
        e.request.url.startsWith("wss://api.openai.com/") && Array.isArray(e._webSocketMessages),
    );
    expect(wsEntry).toBeDefined();
    expect(wsEntry?._resourceType).toBe("websocket");
    expect(
      wsEntry?._webSocketMessages?.filter((m) => m.type === "send").length ?? 0,
    ).toBeGreaterThanOrEqual(2);
    expect(
      wsEntry?._webSocketMessages?.filter((m) => m.type === "receive").length ?? 0,
    ).toBeGreaterThanOrEqual(2);

    expect(
      har.log.entries.some((e) => e.request.url.includes("https://slack.com/api/auth.test")),
    ).toBe(true);
    expect(har.log.entries.some((e) => e.request.url.includes("http://example.com/"))).toBe(true);
  }, 14_000);

  test.sequential("writes expected HAR files into one shared directory", async () => {
    const harNames = (await readdir(tmpDir.path)).filter((name) => name.endsWith(".har")).sort();
    expect(harNames).toMatchInlineSnapshot(`
      [
        "curl-via-proxy-only-mode.har",
        "openai-responses-websockets.har",
        "parallel-openai-slack-curl.har",
        "slack-auth-test.har",
      ]
    `);
  });
});
