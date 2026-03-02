import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { x } from "tinyexec";
import { describe, expect, test } from "vitest";
import { useMitmProxy, useMockHttpServer, useTemporaryDirectory } from "./test-helpers.ts";

const thisDir = dirname(fileURLToPath(import.meta.url));

describe("records har archives for http-client-scripts", () => {
  using tmpDir = useTemporaryDirectory();

  test("for openai responses-websockets", async () => {
    await using egress = await useMockHttpServer({
      harDirectory: tmpDir.path,
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
    await using egress = await useMockHttpServer({
      harDirectory: tmpDir.path,
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

  test("writes slugified HAR files into one shared directory", async () => {
    const harNames = (await readdir(tmpDir.path)).filter((name) => name.endsWith(".har")).sort();
    expect(harNames).toMatchInlineSnapshot(`
      [
        "records-har-archives-for-http-client-scripts-for-openai-responses-websockets.har",
        "records-har-archives-for-http-client-scripts-for-slack-auth-test.har",
      ]
    `);
  });
});
