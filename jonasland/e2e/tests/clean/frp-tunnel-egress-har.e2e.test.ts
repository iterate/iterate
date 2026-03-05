import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { http, HttpResponse } from "msw";
import { useMockHttpServer } from "@iterate-com/mock-http-proxy";
import type { Deployment } from "@iterate-com/shared/jonasland/deployment/deployment.ts";
import { DockerDeployment } from "@iterate-com/shared/jonasland/deployment/docker-deployment.ts";
import { FlyDeployment } from "@iterate-com/shared/jonasland/deployment/fly-deployment.ts";
import { startFrpEgressBridge } from "../../test-helpers/old/frp-egress-bridge.ts";

const DOCKER_IMAGE = process.env.E2E_DOCKER_IMAGE_REF ?? process.env.JONASLAND_SANDBOX_IMAGE ?? "";
const runDocker = DOCKER_IMAGE.length > 0;
const FLY_IMAGE = process.env.E2E_FLY_IMAGE_REF ?? process.env.JONASLAND_SANDBOX_IMAGE ?? "";
const FLY_API_TOKEN = process.env.FLY_API_TOKEN ?? "";
const runFly =
  process.env.JONASLAND_E2E_ENABLE_FLY === "true" &&
  FLY_IMAGE.length > 0 &&
  FLY_API_TOKEN.length > 0;

async function ensureExternalProxyConfigured(params: {
  deployment: Deployment;
  proxyUrl: string;
}): Promise<void> {
  await params.deployment.setEnvVars({
    ITERATE_EXTERNAL_EGRESS_PROXY: params.proxyUrl,
  });
  await params.deployment.pidnap.processes.updateConfig({
    processSlug: "egress-proxy",
    definition: {
      command: "/home/iterate/src/github.com/iterate/iterate/packages/pidnap/node_modules/.bin/tsx",
      args: ["/home/iterate/src/github.com/iterate/iterate/services/egress-service/src/server.ts"],
      env: {
        EGRESS_PROXY_PORT: "19000",
        EGRESS_ADMIN_PORT: "19001",
      },
    },
    options: { restartPolicy: "always" },
    envOptions: { reloadDelay: 500 },
    healthCheck: {
      url: "http://127.0.0.1:19001/__iterate/health",
      intervalMs: 2_000,
    },
  });

  const runtime = await params.deployment.exec([
    "sh",
    "-lc",
    "for i in $(seq 1 30); do out=$(curl -fsS http://127.0.0.1:19001/api/runtime 2>/dev/null || true); echo \"$out\" | grep -q '\"externalProxyConfigured\":true' && { echo \"$out\"; exit 0; }; sleep 1; done; exit 1",
  ]);
  expect(runtime.exitCode, runtime.output).toBe(0);
}

const cases = [
  {
    id: "docker",
    enabled: runDocker,
    create: async (runId: string) =>
      await DockerDeployment.create({
        dockerImage: DOCKER_IMAGE,
        name: `e2e-docker-egress-har-${runId}`,
      }),
  },
  {
    id: "fly",
    enabled: runFly,
    create: async (runId: string) =>
      await FlyDeployment.create({
        flyImage: FLY_IMAGE,
        flyApiToken: FLY_API_TOKEN,
        name: `e2e-fly-egress-har-${runId}`,
      }),
  },
].filter((entry) => entry.enabled);

describe.runIf(cases.length > 0)("egress har recording", () => {
  describe.each(cases)("$id", ({ id, create }) => {
    test(
      "records a HAR archive for egress sent via external proxy",
      async () => {
        const runId = randomUUID().slice(0, 8);
        const artifactsDir = join(process.cwd(), "artifacts", "egress-har");
        await mkdir(artifactsDir, { recursive: true });
        const harPath = join(artifactsDir, `${id}-egress-${runId}.har`);

        await using mockServer = await useMockHttpServer({
          onUnhandledRequest: "bypass",
          recorder: {
            enabled: true,
            harPath,
          },
        });

        mockServer.use(
          http.all("*", async ({ request }) => {
            const body = await request.text();
            return HttpResponse.json(
              {
                ok: true,
                method: request.method,
                url: request.url,
                body,
              },
              {
                headers: {
                  "x-har-mock": "1",
                },
              },
            );
          }),
        );

        await using deployment = await create(runId);
        await deployment.waitUntilAlive({ signal: AbortSignal.timeout(180_000) });

        let bridge: Awaited<ReturnType<typeof startFrpEgressBridge>> | null = null;
        try {
          bridge = await startFrpEgressBridge({
            deployment,
            localTargetHost: "127.0.0.1",
            localTargetPort: mockServer.port,
            frpcBin: process.env.JONASLAND_E2E_FRPC_BIN,
          });
          await ensureExternalProxyConfigured({
            deployment,
            proxyUrl: bridge.dataProxyUrl,
          });

          // Verify the FRP data port is reachable from inside deployment before
          // asserting external-proxy egress behavior.
          let frpReady = false;
          for (let attempt = 1; attempt <= 30; attempt += 1) {
            const probe = await deployment.exec([
              "sh",
              "-lc",
              "curl -sS --max-time 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:27180/__iterate/health || true",
            ]);
            if (probe.output.trim() !== "000" && probe.output.trim().length > 0) {
              frpReady = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
          if (!frpReady) {
            throw new Error(`FRP data port not reachable from deployment.\n${bridge.clientLogs()}`);
          }

          const requestPath = `/har-egress/${runId}`;
          const requestBody = JSON.stringify({ from: `${id}-har-test` });
          const curl = await deployment.exec([
            "curl",
            "-k",
            "-sS",
            "-i",
            "--connect-timeout",
            "10",
            "--max-time",
            "30",
            "-H",
            "content-type: application/json",
            "--data",
            requestBody,
            `https://example.com${requestPath}`,
          ]);

          expect(curl.exitCode, curl.output).toBe(0);
          expect(curl.output.toLowerCase()).toContain("x-iterate-egress-mode: external-proxy");
          expect(curl.output.toLowerCase()).toContain("x-har-mock: 1");
          expect(curl.output).toContain('"ok":true');

          await mockServer.writeHar(harPath);
          const har = JSON.parse(await readFile(harPath, "utf8")) as {
            log?: { entries?: Array<{ request?: { url?: string; method?: string } }> };
          };
          const entries = har.log?.entries ?? [];
          expect(entries.length).toBeGreaterThan(0);
          const matched = entries.find((entry) => entry.request?.url?.includes(requestPath));
          expect(matched?.request?.method).toBe("POST");
          const hosts = entries
            .map((entry) => entry.request?.url)
            .filter((value): value is string => Boolean(value))
            .map((value) => new URL(value).host);
          expect(hosts).toContain("example.com");
          expect(
            hosts.some((host) => host === "127.0.0.1" || host.startsWith("127.0.0.1:")),
          ).toBe(false);
        } finally {
          if (bridge) await bridge.stop();
        }
      },
      id === "fly" ? 420_000 : 180_000,
    );
  });
});
