import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { describe, expect, test } from "vitest";
import { HttpMitmEgressFixture } from "./fixtures/http-mitm-egress-fixture.ts";

const RUN_REAL_HTTPS_TESTS = process.env.RUN_REAL_HTTPS_PROXY_TESTS === "1";
const HAS_OPENAI_KEY = Boolean(process.env.OPENAI_API_KEY);
const HAS_SLACK_TOKEN = Boolean(process.env.SLACK_BOT_TOKEN);

function collectOutput(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (!stream) return Promise.resolve("");

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    stream.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stream.once("error", reject);
    stream.once("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

type ChildResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

async function readHar(
  path: string,
): Promise<{ log: { entries: Array<{ request: { url: string } }> } }> {
  return JSON.parse(await readFile(path, "utf8")) as {
    log: { entries: Array<{ request: { url: string } }> };
  };
}

async function runTsxScript(
  scriptFileName: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = 20_000,
): Promise<ChildResult> {
  const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "fixtures", scriptFileName);

  const child = spawn(process.execPath, ["--import", "tsx", fixturePath], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let timedOut = false;
  const killTimer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);

  const [stdout, stderr, code] = await Promise.all([
    collectOutput(child.stdout),
    collectOutput(child.stderr),
    new Promise<number | null>((resolve) => {
      child.once("close", (exitCode) => {
        resolve(exitCode);
      });
    }),
  ]);
  clearTimeout(killTimer);

  return { code, stdout, stderr, timedOut };
}

const slackTest = RUN_REAL_HTTPS_TESTS && HAS_SLACK_TOKEN ? test : test.skip;
const openaiRealtimeTest = RUN_REAL_HTTPS_TESTS && HAS_OPENAI_KEY ? test : test.skip;

describe("mock-http-proxy real HTTPS SDK integration via http-mitm-proxy", () => {
  slackTest(
    "runs Slack SDK in child process through HTTPS_PROXY mitm and records HAR",
    async () => {
      const harDirPath = await mkdtemp(join(tmpdir(), "mock-http-proxy-real-slack-"));
      const harPath = join(harDirPath, "slack-sdk.har");

      await using fixture = await HttpMitmEgressFixture.start({
        harRecordingPath: harPath,
      });

      const result = await runTsxScript("slack-vanilla.ts", {
        ...process.env,
        ...fixture.envForNode(),
      });

      if (result.timedOut || result.code !== 0) {
        throw new Error(
          `real SDK script failed (timedOut=${String(result.timedOut)} exit=${String(result.code)})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
        );
      }

      const output = JSON.parse(result.stdout.trim()) as {
        ok: boolean;
        teamId: string | null;
      };

      expect(output.ok).toBe(true);
      expect(output.teamId).toBeTruthy();

      await fixture.egress.writeHar();
      const har = await readHar(harPath);
      const urls = har.log.entries.map((entry) => entry.request.url);

      expect(urls.some((url) => url.includes("slack.com/api/auth.test"))).toBe(true);
    },
  );

  openaiRealtimeTest(
    "runs OpenAI realtime SDK in child process through HTTPS_PROXY mitm and records HAR",
    async () => {
      const harDirPath = await mkdtemp(join(tmpdir(), "mock-http-proxy-real-openai-realtime-"));
      const harPath = join(harDirPath, "openai-realtime.har");

      await using fixture = await HttpMitmEgressFixture.start({
        harRecordingPath: harPath,
      });

      const result = await runTsxScript(
        "openai-websocket-vanilla.ts",
        {
          ...process.env,
          ...fixture.envForNode(),
        },
        20_000,
      );

      if (!result.timedOut && result.code !== 0) {
        throw new Error(
          `openai websocket script failed (timedOut=${String(result.timedOut)} exit=${String(result.code)})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
        );
      }

      if (!result.timedOut && result.stdout.trim().length > 0) {
        const output = JSON.parse(result.stdout.trim()) as {
          ok: boolean;
          eventType: string | null;
        };
        expect(output.ok).toBe(true);
      }

      await fixture.egress.writeHar();
      const har = JSON.parse(await readFile(harPath, "utf8")) as {
        log: {
          entries: Array<{
            request: { url: string };
            _webSocketMessages?: Array<{ type: string }>;
          }>;
        };
      };

      const realtimeEntry = har.log.entries.find((entry) =>
        entry.request.url.includes("wss://api.openai.com/v1/realtime"),
      );
      expect(realtimeEntry).toBeDefined();
    },
    45_000,
  );
});
