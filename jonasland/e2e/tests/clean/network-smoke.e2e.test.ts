import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import type { Deployment } from "@iterate-com/shared/jonasland/deployment/deployment.ts";
import { DockerDeployment } from "@iterate-com/shared/jonasland/deployment/docker-deployment.ts";
import { FlyDeployment } from "@iterate-com/shared/jonasland/deployment/fly-deployment.ts";

const DOCKER_IMAGE = process.env.E2E_DOCKER_IMAGE_REF ?? process.env.JONASLAND_SANDBOX_IMAGE ?? "";
const FLY_IMAGE = process.env.E2E_FLY_IMAGE_REF ?? process.env.JONASLAND_SANDBOX_IMAGE ?? "";
const FLY_API_TOKEN = process.env.FLY_API_TOKEN ?? "";
const runFly = FLY_IMAGE.length > 0 && FLY_API_TOKEN.length > 0;

const ITERATE_REPO = "/home/iterate/src/github.com/iterate/iterate";
const PIDNAP_TSX_PATH = `${ITERATE_REPO}/packages/pidnap/node_modules/.bin/tsx`;

type DeploymentCase = {
  id: string;
  enabled: boolean;
  create: (overrides?: {
    name?: string;
    signal?: AbortSignal;
    env?: Record<string, string>;
  }) => Promise<Deployment>;
  timeoutOffsetMs: number;
};

const cases: DeploymentCase[] = [
  {
    id: "docker-default",
    enabled: DOCKER_IMAGE.length > 0,
    create: async (overrides = {}) =>
      await DockerDeployment.create({
        dockerImage: DOCKER_IMAGE,
        ...overrides,
      }),
    timeoutOffsetMs: 0,
  },
  {
    id: "fly-default",
    enabled: runFly,
    create: async (overrides = {}) =>
      await FlyDeployment.create({
        flyImage: FLY_IMAGE,
        flyApiToken: FLY_API_TOKEN,
        ...overrides,
      }),
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

async function startEgressProcess(deployment: Deployment): Promise<void> {
  await deployment.pidnap.processes.updateConfig({
    processSlug: "egress-proxy",
    definition: {
      command: PIDNAP_TSX_PATH,
      args: [`${ITERATE_REPO}/services/egress-service/src/server.ts`],
      env: {
        ITERATE_EXTERNAL_EGRESS_PROXY: "http://127.0.0.1:19123",
      },
    },
    options: { restartPolicy: "always" },
    envOptions: { reloadDelay: false },
    healthCheck: {
      url: "http://127.0.0.1:19000/__iterate/health",
      intervalMs: 2_000,
    },
  });
  const waitResult = await deployment.pidnap.processes.waitFor({
    processes: { "egress-proxy": "healthy" },
    timeoutMs: 20_000,
  });
  expect(waitResult.allMet).toBe(true);
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
      async () => {
        const sentinel = `e2e-sentinel-${randomUUID().slice(0, 8)}`;

        await using deployment = await create({
          name: `e2e-network-${randomUUID().slice(0, 8)}`,
          env: {
            TEST_DEPLOYMENT_SENTINEL: sentinel,
            ITERATE_EXTERNAL_EGRESS_PROXY: "http://127.0.0.1:19123",
          },
          signal: AbortSignal.timeout(45_000 + timeoutOffsetMs),
        });

        await deployment.waitUntilAlive({ signal: AbortSignal.timeout(30_000 + timeoutOffsetMs) });
        await startInlineLoggingProxy(deployment);
        await startEgressProcess(deployment);

        const envRead = await deployment.exec(
          'test "$TEST_DEPLOYMENT_SENTINEL" = "' + sentinel + '"',
        );
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
