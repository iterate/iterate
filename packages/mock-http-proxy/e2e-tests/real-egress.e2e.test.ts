import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  useMitmProxy,
  useMockHttpServer,
  useTemporaryDirectory,
} from "../src/server/mock-http-server-fixture.ts";
import {
  expectHarContainsUrl,
  expectHarHosts,
  expectOpenAiScriptOutput,
  expectOpenAiWebSocketHar,
  expectSlackScriptOutput,
  readHarFile,
  runCurlThroughMitm,
  runOpenAiScript,
  runSlackScript,
} from "./real-egress.helpers.ts";

function requireProxyCaCert(mitmEnv: Record<string, string>): string {
  const proxyCaCertPath = mitmEnv.NODE_EXTRA_CA_CERTS;
  if (!proxyCaCertPath) {
    throw new Error("missing NODE_EXTRA_CA_CERTS from useMitmProxy env");
  }
  return proxyCaCertPath;
}

describe("records HAR archives for real egress traffic", () => {
  using tmpDir = useTemporaryDirectory("mock-http-proxy-real-egress-");

  console.log(
    [
      "--------------------------------",
      "HAR archive folder:",
      tmpDir.path,
      "",
      "1. Open folder in finder:",
      `open \"${tmpDir.path}\"`,
      "2. Open test:blank in Chrome",
      "3. Drag HAR onto network tab",
      "--------------------------------",
    ].join("\n"),
  );

  test.concurrent("OpenAI websocket script", async () => {
    const harPath = join(tmpDir.path, "openai-responses-websockets.har");

    // 1) Create mock HTTP server.
    await using egress = await useMockHttpServer({
      recorder: { harPath },
      onUnhandledRequest: "bypass",
    });
    // 2) Create MITM proxy.
    await using mitm = await useMitmProxy({ externalEgressProxyUrl: egress.url });

    // 3) Run client through proxy.
    const openAiOutput = await runOpenAiScript({
      mitmEnv: mitm.envForNode(),
      timeoutMs: 4_000,
    });

    // 4) Capture HAR + assert.
    expectOpenAiScriptOutput(openAiOutput);
    await egress.writeHar();
    const har = await readHarFile(harPath);
    expectHarHosts(har, ["api.openai.com"]);
    expectOpenAiWebSocketHar(har);
  }, 12_000);

  test.concurrent("Slack auth.test script", async () => {
    const harPath = join(tmpDir.path, "slack-auth-test.har");

    // 1) Create mock HTTP server.
    await using egress = await useMockHttpServer({
      recorder: { harPath },
      onUnhandledRequest: "bypass",
    });

    // 3) Run client code (no local MITM needed for this one).
    const slackOutput = await runSlackScript(egress.url);

    // 4) Capture HAR + assert.
    expectSlackScriptOutput(slackOutput);
    await egress.writeHar();
    const har = await readHarFile(harPath);
    expectHarHosts(har, ["slack.com"]);
    expectHarContainsUrl(har, "https://slack.com/api/auth.test");
  }, 20_000);

  test.concurrent("curl via MITM proxy-only mode", async () => {
    const harPath = join(tmpDir.path, "curl-via-proxy-only-mode.har");

    // 1) Create mock HTTP server.
    await using egress = await useMockHttpServer({
      recorder: { harPath },
      onUnhandledRequest: "bypass",
    });
    // 2) Create MITM proxy.
    await using mitm = await useMitmProxy({ externalEgressProxyUrl: egress.url });

    // 3) Run client through proxy.
    const mitmEnv = mitm.envForNode();
    await runCurlThroughMitm(mitm.url, requireProxyCaCert(mitmEnv));

    // 4) Capture HAR + assert.
    await egress.writeHar();
    const har = await readHarFile(harPath);
    expectHarHosts(har, ["example.com"]);
    expectHarContainsUrl(har, "http://example.com/");
  });

  test.concurrent("OpenAI + Slack + curl in parallel", async () => {
    const harPath = join(tmpDir.path, "parallel-openai-slack-curl.har");

    // 1) Create mock HTTP server.
    await using egress = await useMockHttpServer({
      recorder: { harPath },
      onUnhandledRequest: "bypass",
    });
    // 2) Create MITM proxy.
    await using mitm = await useMitmProxy({ externalEgressProxyUrl: egress.url });

    // 3) Run client code through proxy.
    const mitmEnv = mitm.envForNode();
    const [openAiOutput, slackOutput] = await Promise.all([
      runOpenAiScript({ mitmEnv, timeoutMs: 4_000 }),
      runSlackScript(egress.url),
      runCurlThroughMitm(mitm.url, requireProxyCaCert(mitmEnv)),
    ]);

    // 4) Capture HAR + assert.
    expectOpenAiScriptOutput(openAiOutput);
    expectSlackScriptOutput(slackOutput);

    await egress.writeHar();
    const har = await readHarFile(harPath);
    expectHarHosts(har, ["api.openai.com", "slack.com", "example.com"]);
    expectOpenAiWebSocketHar(har);
    expectHarContainsUrl(har, "https://slack.com/api/auth.test");
    expectHarContainsUrl(har, "http://example.com/");
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
