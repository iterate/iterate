import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { http, HttpResponse } from "msw";
import { x } from "tinyexec";
import { describe, expect, test } from "vitest";
import { useMitmProxy, useMockHttpServer, useTemporaryDirectory } from "./test-helpers.ts";

const thisDir = dirname(fileURLToPath(import.meta.url));

describe("records har archives for http-client-scripts", () => {
  using tmpDir = useTemporaryDirectory();

  console.log(
    [
      "--------------------------------",
      "HAR archive folder:",
      tmpDir.path,
      "",
      "1. Open folder in finder:",
      `open "${tmpDir.path}"`,
      "2. Open about:blank in Chrome",
      "3. Drag har onto network tab",
      "--------------------------------",
    ].join("\n"),
  );

  test("for openai responses-websockets", async () => {
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
    expect(egress.getHar().log.entries).toBeDefined();
  }, 30_000);

  test("for slack auth-test", async () => {
    const harPath = join(tmpDir.path, "slack-auth-test.har");
    await using egress = await useMockHttpServer({
      recorder: { harPath },
      onUnhandledRequest: "bypass",
    });
    await using mitm = await useMitmProxy({
      externalEgressProxyUrl: egress.url,
    });

    const result = await x(
      "pnpm",
      ["exec", "tsx", join(thisDir, "http-client-scripts", "slack-auth-test.ts")],
      {
        throwOnError: true,
        nodeOptions: {
          env: {
            ...process.env,
            ...mitm.envForNode(),
            SLACK_BOT_TOKEN: process.env.SLACK_CI_BOT_TOKEN,
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
    expect(egress.getHar().log.entries).toBeDefined();
  });

  test("uses MSW handlers directly without HAR", async () => {
    await using server = await useMockHttpServer();
    server.use(
      http.get("https://api.example.com/hello", () => {
        return HttpResponse.json({ message: "mocked" });
      }),
    );

    const response = await fetch(`${server.url}/hello`, {
      headers: {
        forwarded: "for=203.0.113.42; host=api.example.com; proto=https",
      },
    });
    const body = await response.json();
    expect(body).toEqual({ message: "mocked" });
  });

  test("writes HAR files into shared directory", async () => {
    const harNames = (await readdir(tmpDir.path)).filter((name) => name.endsWith(".har")).sort();
    expect(harNames).toMatchInlineSnapshot(`
      [
        "openai-responses-websockets.har",
        "slack-auth-test.har",
      ]
    `);
  });
});
