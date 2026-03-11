import { describe } from "vitest";
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

function parseJsonFromOutput(output: string): Record<string, unknown> {
  const trimmed = output.trim();
  if (trimmed.length === 0) {
    throw new Error("empty output");
  }
  return JSON.parse(trimmed) as Record<string, unknown>;
}

function healthServiceName(payload: Record<string, unknown>) {
  const direct = payload.service;
  if (typeof direct === "string") return direct;
  const nested = payload.json;
  if (!nested || typeof nested !== "object") return undefined;
  const nestedService = (nested as Record<string, unknown>).service;
  return typeof nestedService === "string" ? nestedService : undefined;
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

async function curlWithHost(params: { deployment: Deployment; host: string; path: string }) {
  return await params.deployment.exec([
    "curl",
    "-fsS",
    "--max-time",
    "10",
    "-H",
    `Host: ${params.host}`,
    `http://127.0.0.1${params.path}`,
  ]);
}

async function waitForInternalHealth(params: {
  deployment: Deployment;
  host: string;
  path: string;
  timeoutMs: number;
  expectedService: string | null;
}) {
  const deadline = Date.now() + params.timeoutMs;
  let lastOutput = "";
  while (Date.now() < deadline) {
    const result = await curlWithHost({
      deployment: params.deployment,
      host: params.host,
      path: params.path,
    }).catch(() => null);
    if (result?.exitCode === 0) {
      if (params.expectedService === null) return;
      const payload = parseJsonFromOutput(result.output);
      if (healthServiceName(payload) === params.expectedService) return;
      lastOutput = result.output;
    } else {
      lastOutput = result?.output ?? lastOutput;
    }
    await sleep(500);
  }
  throw new Error(
    `health host=${params.host} path=${params.path} did not resolve to ${String(params.expectedService)}${lastOutput ? `: ${lastOutput}` : ""}`,
  );
}

const cases = [
  {
    id: "docker",
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
    id: "fly",
    tags: ["providers/fly", "slow"] as const,
    timeoutMs: 240_000,
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

describe("internal ingress", () => {
  describe.each(cases)("$id", ({ create, tags, timeoutMs }) => {
    test(
      "deployment-local curl reaches bootstrap and registry-managed services through caddy host routing",
      { tags: [...tags], timeout: timeoutMs + 90_000 },
      async ({ expect, e2e }) => {
        const deployment = await create({
          slug: e2e.deploymentSlug,
        });
        await using deploymentFixture = await e2e.useDeployment({ deployment });
        await deploymentFixture.waitUntilExecAvailable({
          timeoutMs,
        });

        await waitForInternalHealth({
          deployment,
          host: "registry.iterate.localhost",
          path: "/orpc/__iterate/health",
          timeoutMs,
          expectedService: null,
        });
        await waitForInternalHealth({
          deployment,
          host: "events.iterate.localhost",
          path: "/api/__iterate/health",
          timeoutMs,
          expectedService: "@iterate-com/events-contract",
        });

        const pidnapConfigs = serviceManifestToPidnapConfig({
          manifests: [exampleServiceManifest],
        });
        for (const config of pidnapConfigs) {
          await deployment.pidnap.processes.updateConfig(config);
        }
        await waitForRouteRegistered({
          deployment,
          host: "example.iterate.localhost",
          timeoutMs,
        });

        const healthChecks: Array<{
          host: string;
          path: string;
          expectedService: string | null;
        }> = [
          {
            host: "registry.iterate.localhost",
            path: "/orpc/__iterate/health",
            expectedService: null,
          },
          {
            host: "events.iterate.localhost",
            path: "/api/__iterate/health",
            expectedService: "@iterate-com/events-contract",
          },
          {
            host: "example.iterate.localhost",
            path: "/api/__iterate/health",
            expectedService: "jonasland-example",
          },
        ];

        for (const check of healthChecks) {
          await waitForInternalHealth({
            deployment,
            host: check.host,
            path: check.path,
            timeoutMs,
            expectedService: check.expectedService,
          });
        }

        const exampleEcho = await curlWithHost({
          deployment,
          host: "example.iterate.localhost",
          path: "/api/echo?from=internal-ingress-test",
        });
        expect(exampleEcho.exitCode, exampleEcho.output).toBe(0);
        const payload = parseJsonFromOutput(exampleEcho.output);
        expect(String(payload.url)).toContain("/api/echo?from=internal-ingress-test");
      },
    );
  });
});
