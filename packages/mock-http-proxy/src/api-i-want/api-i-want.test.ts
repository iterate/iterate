import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { x } from "tinyexec";
import { describe, expect, test } from "vitest";
import { useMitmProxy, useMockHttpServer, useTemporaryDirectory } from "./test-helpers.ts";

const thisDir = dirname(fileURLToPath(import.meta.url));

describe("records har archives for http-client-scripts", () => {
  using tmpDir = useTemporaryDirectory();

  test.concurrent("for openai responses-websockets", async () => {
    await using egress = await useMockHttpServer({
      harDirectory: tmpDir.path,
      harFileName:
        "records-har-archives-for-http-client-scripts-for-openai-responses-websockets.har",
    });
    await using mitm = await useMitmProxy({
      externalEgressProxyUrl: egress.url,
    });

    const result = await x(
      "pnpm",
      ["exec", "tsx", join(thisDir, "http-client-scripts", "openai-responses-websockets.ts")],
      {
        throwOnError: true,
        nodeOptions: {
          env: {
            ...process.env,
            ...mitm.envForNode(),
            OPENAI_API_KEY: process.env.OPENAI_API_KEY,
          },
          cwd: join(thisDir, "..", ".."),
          stdio: "pipe",
        },
      },
    );
    const output = JSON.parse(result.stdout.trim());
    expect(output).toMatchObject({
      ok: true,
      endpoint: "openai.websocket-mode",
    });
    const har = egress.getHar();
    const realtimeEntry = har.log.entries.find((entry) =>
      entry.request.url.includes("wss://api.openai.com/v1/realtime"),
    );
    expect(realtimeEntry).toBeDefined();
    expect(realtimeEntry?._webSocketMessages?.length ?? 0).toBeGreaterThan(0);
  }, 30_000);

  test.concurrent("for slack auth-test", async () => {
    await using egress = await useMockHttpServer({
      harDirectory: tmpDir.path,
      harFileName: "records-har-archives-for-http-client-scripts-for-slack-auth-test.har",
    });

    const result = await x(
      "pnpm",
      ["exec", "tsx", join(thisDir, "http-client-scripts", "slack-auth-test.ts")],
      {
        throwOnError: true,
        nodeOptions: {
          env: {
            ...process.env,
            SLACK_BOT_TOKEN: process.env.SLACK_CI_BOT_TOKEN,
            SLACK_API_URL: `${egress.url}/api/`,
            SLACK_TARGET_URL: "https://slack.com",
          },
          cwd: join(thisDir, "..", ".."),
          stdio: "pipe",
        },
      },
    );
    const output = JSON.parse(result.stdout.trim());
    expect(output).toMatchObject({
      ok: true,
      endpoint: "slack.auth.test",
    });
    const har = egress.getHar();
    expect(
      har.log.entries.some((entry) =>
        entry.request.url.includes("https://slack.com/api/auth.test"),
      ),
    ).toBe(true);
  }, 30_000);

  test.concurrent("for curl via proxy-only mode", async () => {
    await using egress = await useMockHttpServer({
      harDirectory: tmpDir.path,
      harFileName: "records-har-archives-for-http-client-scripts-for-curl-via-proxy-only-mode.har",
    });
    await using mitm = await useMitmProxy({
      externalEgressProxyUrl: egress.url,
    });
    const mitmEnv = mitm.envForNode();
    const proxyCaCertPath = mitmEnv.NODE_EXTRA_CA_CERTS;
    if (!proxyCaCertPath) {
      throw new Error("missing NODE_EXTRA_CA_CERTS from useMitmProxy env");
    }

    await x(
      "curl",
      [
        "--silent",
        "--show-error",
        "--fail",
        "--proxy",
        mitm.url,
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

    const har = egress.getHar();
    expect(har.log.entries.some((entry) => entry.request.url.includes("http://example.com/"))).toBe(
      true,
    );
  });

  test.sequential("writes slugified HAR files into one shared directory", async () => {
    const harNames = (await readdir(tmpDir.path)).filter((name) => name.endsWith(".har")).sort();
    expect(harNames).toMatchInlineSnapshot(`
      [
        "records-har-archives-for-http-client-scripts-for-curl-via-proxy-only-mode.har",
        "records-har-archives-for-http-client-scripts-for-openai-responses-websockets.har",
        "records-har-archives-for-http-client-scripts-for-slack-auth-test.har",
      ]
    `);
  });
});
