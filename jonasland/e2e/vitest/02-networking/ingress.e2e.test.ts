import { describe, expect } from "vitest";
import { exampleServiceManifest } from "@iterate-com/example-contract";
import { serviceManifestToPidnapConfig } from "@iterate-com/shared/jonasland";
import { Deployment } from "@iterate-com/shared/jonasland/deployment/deployment.ts";
import { createDockerProvider } from "@iterate-com/shared/jonasland/deployment/docker-deployment.ts";
import { createFlyProvider } from "@iterate-com/shared/jonasland/deployment/fly-deployment.ts";
import {
  DockerDeploymentTestEnv,
  FlyDeploymentTestEnv,
} from "../../test-helpers/deployment-test-env.ts";
import { test } from "../../test-support/e2e-test.ts";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRouteRegistered(params: {
  deployment: Deployment;
  host: string;
  timeoutMs: number;
}) {
  const deadline = Date.now() + params.timeoutMs;
  while (Date.now() < deadline) {
    try {
      const listed = await params.deployment.registryService.routes.list({});
      if (listed.routes.some((route) => route.host === params.host)) return;
    } catch {
      // Registry can briefly restart while process definitions are applied.
    }
    await sleep(500);
  }
  throw new Error(`route ${params.host} not registered within ${String(params.timeoutMs)}ms`);
}

const cases = [
  {
    id: "docker" as const,
    tags: ["providers/docker", "no-internet"] as const,
    timeoutMs: 30_000,
    create: async ({ slug }: { slug: string }) => {
      const env = DockerDeploymentTestEnv.parse(process.env);
      return await Deployment.create({
        provider: createDockerProvider({}),
        opts: {
          slug,
          image: env.image,
        },
      });
    },
  },
  {
    id: "fly" as const,
    tags: ["providers/fly", "slow"] as const,
    timeoutMs: 180_000,
    create: async ({ slug }: { slug: string }) => {
      const env = FlyDeploymentTestEnv.parse(process.env);
      return await Deployment.create({
        provider: createFlyProvider({
          flyApiToken: env.flyApiToken,
        }),
        opts: {
          slug,
          image: env.image,
        },
      });
    },
  },
];

describe("ingress", () => {
  describe("local ingress", () => {
    describe.each(cases)("$id", ({ create, tags, timeoutMs }) => {
      test(
        "local hosts keep routing correctly across default-service change and restart",
        { tags: [...tags], timeout: timeoutMs + 120_000 },
        async ({ e2e }) => {
          const deployment = await create({ slug: e2e.deploymentSlug });
          await using deploymentFixture = await e2e.useDeployment({ deployment });
          await deploymentFixture.waitUntilExecAvailable({
            timeoutMs,
          });
          const builtinsDeadline = Date.now() + timeoutMs;
          while (Date.now() < builtinsDeadline) {
            try {
              const result = await deployment.pidnap.processes.waitFor({
                processes: { caddy: "running", registry: "running", events: "running" },
                timeoutMs: 5_000,
              });
              if (result.allMet) break;
            } catch {
              await sleep(500);
            }
          }

          const assertHealth = async ({
            host,
            expectedService,
            waitTimeoutMs,
          }: {
            host: string;
            expectedService: string;
            waitTimeoutMs: number;
          }) => {
            const deadline = Date.now() + waitTimeoutMs;
            let lastOutput = "";
            while (Date.now() < deadline) {
              const result = await deployment
                .exec(["curl", "-fsS", "--max-time", "10", `http://${host}/api/__iterate/health`])
                .catch(() => null);
              if (result?.exitCode === 0) {
                const trimmed = result.output.trim();
                if (trimmed.length === 0) {
                  throw new Error(`empty health output for host=${host}`);
                }
                const payload = JSON.parse(trimmed) as Record<string, unknown>;
                const direct = payload.service;
                const nested = payload.json;
                const nestedService =
                  nested && typeof nested === "object"
                    ? (nested as Record<string, unknown>).service
                    : undefined;
                const service =
                  typeof direct === "string"
                    ? direct
                    : typeof nestedService === "string"
                      ? nestedService
                      : undefined;
                if (service === expectedService) return;
                lastOutput = result.output;
              } else {
                lastOutput = result?.output ?? lastOutput;
              }
              await sleep(500);
            }
            throw new Error(
              `health host=${host} did not resolve to ${expectedService}${lastOutput ? `: ${lastOutput}` : ""}`,
            );
          };

          const assertWebSocketUpgrade = async ({
            host,
            waitTimeoutMs,
          }: {
            host: string;
            waitTimeoutMs: number;
          }) => {
            const deadline = Date.now() + waitTimeoutMs;
            let lastOutput = "";
            while (Date.now() < deadline) {
              const result = await deployment.exec([
                "curl",
                "-sS",
                "-i",
                "--http1.1",
                "--max-time",
                "5",
                "-H",
                "Connection: Upgrade",
                "-H",
                "Upgrade: websocket",
                "-H",
                "Sec-WebSocket-Version: 13",
                "-H",
                "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
                `http://${host}/orpc/ws`,
              ]);
              if (
                (result.exitCode === 0 || result.exitCode === 28) &&
                result.output.includes("101 Switching Protocols")
              ) {
                return;
              }
              lastOutput = result.output;
              await sleep(500);
            }
            throw new Error(
              `websocket host=${host} did not upgrade successfully${lastOutput ? `: ${lastOutput}` : ""}`,
            );
          };

          await assertHealth({
            host: "events.iterate.localhost",
            expectedService: "@iterate-com/events-contract",
            waitTimeoutMs: timeoutMs,
          });

          const pidnapConfigs = serviceManifestToPidnapConfig({
            manifests: [exampleServiceManifest],
          });
          console.log("[ingress] applying example service config");
          for (const config of pidnapConfigs) {
            await deployment.pidnap.processes.updateConfig(config);
          }
          const exampleReady = await deployment.pidnap.processes.waitFor({
            processes: { [exampleServiceManifest.slug]: "healthy" },
            timeoutMs,
          });
          expect(exampleReady.allMet).toBe(true);
          await waitForRouteRegistered({
            deployment,
            host: "example.iterate.localhost",
            timeoutMs,
          });
          await assertHealth({
            host: "example.iterate.localhost",
            expectedService: "jonasland-example",
            waitTimeoutMs: timeoutMs,
          });

          const publicBaseHost = `local-ingress-${e2e.deploymentSlug}.iterate.localhost`;
          await deployment.setEnvVars({
            ITERATE_INGRESS_HOST: publicBaseHost,
            ITERATE_INGRESS_ROUTING_TYPE: "dunder-prefix",
          });

          console.log("[ingress] checking initial host matrix");
          const initialCases = [
            {
              host: "home.iterate.localhost",
              expectedService: "jonasland-home-service",
            },
            {
              host: publicBaseHost,
              expectedService: "jonasland-home-service",
            },
            {
              host: "example.iterate.localhost",
              expectedService: "jonasland-example",
            },
            {
              host: `example__${publicBaseHost}`,
              expectedService: "jonasland-example",
            },
          ];

          for (const check of initialCases) {
            console.log(`[ingress] initial health ${check.host}`);
            await assertHealth({
              host: check.host,
              expectedService: check.expectedService,
              waitTimeoutMs: timeoutMs,
            });
          }

          console.log("[ingress] restarting deployment");
          await deployment.stop();
          await deployment.start();
          await deploymentFixture.waitUntilExecAvailable({
            deployment,
            timeoutMs: timeoutMs + 60_000,
          });
          const restartedBuiltinsDeadline = Date.now() + timeoutMs + 60_000;
          while (Date.now() < restartedBuiltinsDeadline) {
            try {
              const result = await deployment.pidnap.processes.waitFor({
                processes: { caddy: "running", registry: "running", events: "running" },
                timeoutMs: 5_000,
              });
              if (result.allMet) break;
            } catch {
              await sleep(500);
            }
          }
          await assertHealth({
            host: "events.iterate.localhost",
            expectedService: "@iterate-com/events-contract",
            waitTimeoutMs: timeoutMs + 60_000,
          });

          console.log("[ingress] checking post-restart host matrix");
          for (const check of initialCases) {
            console.log(`[ingress] post-restart health ${check.host}`);
            await assertHealth({
              host: check.host,
              expectedService: check.expectedService,
              waitTimeoutMs: timeoutMs + 60_000,
            });
          }

          console.log("[ingress] checking websocket upgrade");
          await assertWebSocketUpgrade({
            host: "events.iterate.localhost",
            waitTimeoutMs: timeoutMs,
          });
        },
      );
    });
  });
});
