import { randomUUID } from "node:crypto";
import { describe, expect } from "vitest";
import { Deployment } from "@iterate-com/shared/jonasland/deployment/deployment.ts";
import { createDockerProvider } from "@iterate-com/shared/jonasland/deployment/docker-deployment.ts";
import { createFlyProvider } from "@iterate-com/shared/jonasland/deployment/fly-deployment.ts";
import { test } from "../../test-support/e2e-test.ts";

const DOCKER_IMAGE = process.env.E2E_DOCKER_IMAGE_REF ?? process.env.JONASLAND_SANDBOX_IMAGE ?? "";
const FLY_IMAGE = process.env.E2E_FLY_IMAGE_REF ?? process.env.JONASLAND_SANDBOX_IMAGE ?? "";
const FLY_API_TOKEN = process.env.FLY_API_TOKEN ?? "";
const runFly = FLY_IMAGE.length > 0 && FLY_API_TOKEN.length > 0;

type DeploymentCase = {
  id: string;
  enabled: boolean;
  create: (overrides?: {
    slug?: string;
    signal?: AbortSignal;
    env?: Record<string, string>;
  }) => Promise<Deployment>;
  timeoutOffsetMs: number;
};

const cases: DeploymentCase[] = [
  {
    id: "docker-default",
    enabled: DOCKER_IMAGE.length > 0,
    create: async (
      overrides: { slug?: string; signal?: AbortSignal; env?: Record<string, string> } = {},
    ) => {
      const { slug = "", signal, env } = overrides;
      return await Deployment.create({
        signal,
        provider: createDockerProvider({}),
        opts: {
          slug,
          image: DOCKER_IMAGE,
          ...(env ? { env } : {}),
        },
      });
    },
    timeoutOffsetMs: 0,
  },
  {
    id: "fly-default",
    enabled: runFly,
    create: async (
      overrides: { slug?: string; signal?: AbortSignal; env?: Record<string, string> } = {},
    ) => {
      const { slug = "", signal, env } = overrides;
      return await Deployment.create({
        signal,
        provider: createFlyProvider({
          flyApiToken: FLY_API_TOKEN,
        }),
        opts: {
          slug,
          image: FLY_IMAGE,
          ...(env ? { env } : {}),
        },
      });
    },
    timeoutOffsetMs: 300_000,
  },
].filter((entry) => entry.enabled);

async function expectExitCodeZero(
  result: { exitCode: number; output: string },
  label: string,
): Promise<void> {
  expect(result.exitCode, `${label}\n${result.output}`).toBe(0);
}

async function waitForCommandOutput(params: {
  deployment: Deployment;
  cmd: string[];
  timeoutMs: number;
  matches: (output: string) => boolean;
}): Promise<{ exitCode: number; output: string }> {
  const deadline = Date.now() + params.timeoutMs;
  let last = { exitCode: 1, output: "" };
  while (Date.now() < deadline) {
    last = await params.deployment.exec(params.cmd);
    if (last.exitCode === 0 && params.matches(last.output)) return last;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return last;
}

async function startInlineLoggingProxy(deployment: Deployment): Promise<void> {
  await deployment.pidnap.processes.updateConfig({
    processSlug: "test-egress-proxy-logger",
    definition: {
      command: "node",
      args: [
        "-e",
        [
          "const { createServer } = require('node:http');",
          "createServer((req, res) => {",
          "  const body = JSON.stringify({ ok: true, via: 'test-egress-proxy-logger', host: req.headers.host || '', path: req.url || '' });",
          "  res.writeHead(200, { 'content-type': 'application/json', 'x-test-egress-hit': '1' });",
          "  res.end(body);",
          "}).listen(19123, '0.0.0.0');",
        ].join(" "),
      ],
    },
    options: { restartPolicy: "always" },
    envOptions: { reloadDelay: false },
    healthCheck: {
      url: "http://127.0.0.1:19123/__iterate/health",
      intervalMs: 2_000,
    },
  });
  const waitResult = await deployment.pidnap.processes.waitFor({
    processes: { "test-egress-proxy-logger": "healthy" },
    timeoutMs: 20_000,
  });
  expect(waitResult.allMet).toBe(true);

  const loggerReady = await waitForCommandOutput({
    deployment,
    cmd: ["curl", "-sS", "-i", "http://127.0.0.1:19123/__iterate/health"],
    timeoutMs: 20_000,
    matches: (output) => output.toLowerCase().includes("x-test-egress-hit: 1"),
  });
  await expectExitCodeZero(loggerReady, "inline egress logger did not become reachable");
}

describe.runIf(cases.length > 0)("network smoke", () => {
  describe.each(cases)("$id", ({ create, timeoutOffsetMs }) => {
    test(
      "caddy-enforced egress, localhost wildcard DNS, and deployment env passthrough",
      async ({ e2e }) => {
        const sentinel = `e2e-sentinel-${randomUUID().slice(0, 8)}`;

        const deployment = await create({
          slug: `e2e-network-${randomUUID().slice(0, 8)}`,
          env: {
            TEST_DEPLOYMENT_SENTINEL: sentinel,
            ITERATE_EGRESS_PROXY: "http://127.0.0.1:19123",
          },
          signal: AbortSignal.timeout(45_000 + timeoutOffsetMs),
        });
        await using _deployment = await e2e.useDeployment({ deployment });

        await deployment.waitUntilAlive({ signal: AbortSignal.timeout(30_000 + timeoutOffsetMs) });
        await startInlineLoggingProxy(deployment);
        const envRead = await deployment.shell({
          cmd: 'test "$TEST_DEPLOYMENT_SENTINEL" = "' + sentinel + '"',
        });
        await expectExitCodeZero(envRead, "deployment env passthrough failed");

        const localhostLookup = await deployment.exec([
          "node",
          "-e",
          "require('node:dns').lookup('localhost', (err, address) => { if (err) { console.error(err.message); process.exit(1); } process.stdout.write(address); });",
        ]);
        await expectExitCodeZero(localhostLookup, "localhost dns lookup failed");

        const egressed = await waitForCommandOutput({
          deployment,
          cmd: [
            "curl",
            "-k",
            "-sS",
            "-i",
            "-H",
            "x-iterate-from-test: yes",
            "https://api.openai.com/v1/models",
          ],
          timeoutMs: 20_000 + timeoutOffsetMs,
          matches: (output) =>
            output.toLowerCase().includes("x-test-egress-hit: 1") &&
            output.toLowerCase().includes("x-iterate-egress-proxy-seen: 1"),
        });
        await expectExitCodeZero(egressed, "egressed request failed");
        const egressOutput = egressed.output.toLowerCase();
        expect(egressOutput).toContain("x-test-egress-hit: 1");
        expect(egressOutput).toContain("x-iterate-egress-proxy-seen: 1");
        expect(egressOutput).toContain("x-iterate-egress-mode: external-proxy");
        expect(egressed.output).toContain('"via":"test-egress-proxy-logger"');
      },
      130_000 + timeoutOffsetMs,
    );
  });
});
