import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe } from "vitest";
import { fromTrafficWithWebSocket, useMockHttpServer } from "@iterate-com/mock-http-proxy";
import type { HarWithExtensions } from "@iterate-com/mock-http-proxy";
import { Deployment } from "@iterate-com/shared/jonasland/deployment/deployment.ts";
import { createDockerProvider } from "@iterate-com/shared/jonasland/deployment/docker-deployment.ts";
import { createFlyProvider } from "@iterate-com/shared/jonasland/deployment/fly-deployment.ts";
import {
  DockerDeploymentTestEnv,
  FlyDeploymentTestEnv,
} from "../../test-helpers/deployment-test-env.ts";
import { startFrpEgressBridge } from "../../test-helpers/old/frp-egress-bridge.ts";
import { test } from "../../test-support/e2e-test.ts";

const cases = [
  {
    id: "docker" as const,
    tags: ["providers/docker", "third-party-dependency"] as const,
    timeoutMs: 240_000,
    createDeployment: async ({
      slug,
      env: runtimeEnv = {},
    }: {
      slug: string;
      env?: Record<string, string>;
    }) => {
      const providerEnv = DockerDeploymentTestEnv.parse(process.env);
      return await Deployment.create({
        provider: createDockerProvider({}),
        opts: {
          slug,
          image: providerEnv.image,
          env: runtimeEnv,
        },
      });
    },
  },
  {
    id: "fly" as const,
    tags: ["providers/fly", "slow", "third-party-dependency"] as const,
    timeoutMs: 420_000,
    createDeployment: async ({
      slug,
      env: runtimeEnv = {},
    }: {
      slug: string;
      env?: Record<string, string>;
    }) => {
      const providerEnv = FlyDeploymentTestEnv.parse(process.env);
      return await Deployment.create({
        provider: createFlyProvider({
          flyApiToken: providerEnv.flyApiToken,
        }),
        opts: {
          slug,
          image: providerEnv.image,
          env: runtimeEnv,
        },
      });
    },
  },
];

const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const hasAiKeys = OPENAI_API_KEY.length > 0 && ANTHROPIC_API_KEY.length > 0;

async function runPiConversation(params: { deployment: Deployment; sessionDir: string }) {
  const baseArgs = [
    "--provider",
    "openai",
    "--model",
    "gpt-4o-mini",
    "--thinking",
    "off",
    "--no-tools",
    "--session-dir",
    params.sessionDir,
  ];
  const turn1 = await params.deployment.exec([
    "pi",
    ...baseArgs,
    "-p",
    "Return only JavaScript code for a function named add that adds two numbers.",
  ]);
  const turn2 = await params.deployment.exec([
    "pi",
    ...baseArgs,
    "--continue",
    "-p",
    "Revise that to TypeScript with explicit number types. Return only code.",
  ]);
  const turn3 = await params.deployment.exec([
    "pi",
    ...baseArgs,
    "--continue",
    "-p",
    "Now add a minimal Vitest test below it. Return only code.",
  ]);
  return { turn1, turn2, turn3 };
}

function harRequestUrls(har: HarWithExtensions): string[] {
  return (har.log?.entries ?? [])
    .map((entry) => entry.request?.url)
    .filter((value): value is string => Boolean(value));
}

function assertReplayLooksLikeAiTraffic(urls: string[]) {
  return urls.some((url) => {
    const host = new URL(url).host;
    return (
      host.includes("openai.com") ||
      host.includes("anthropic.com") ||
      host.includes("googleapis.com") ||
      host.includes("generativelanguage.googleapis.com")
    );
  });
}

describe("egress", () => {
  describe.runIf(hasAiKeys).each(cases)("$id", ({ createDeployment, id, tags, timeoutMs }) => {
    test(
      "records and replays a multi-turn pi coding conversation through FRP external proxy",
      { tags: [...tags], timeout: timeoutMs },
      async ({ expect, e2e }) => {
        const artifactsDir = join(e2e.outputDir, "egress-record-replay");
        await mkdir(artifactsDir, { recursive: true });
        const harPath = join(artifactsDir, `${id}-pi-conversation.har`);
        const replayHarPath = join(artifactsDir, `${id}-pi-conversation.replay.har`);
        let proxyPort = 0;
        let recordedHar: HarWithExtensions | null = null;

        const deployment = await createDeployment({
          slug: e2e.deploymentSlug,
          env: { OPENAI_API_KEY, ANTHROPIC_API_KEY },
        });
        await using deploymentFixture = await e2e.useDeployment({
          deployment,
        });
        await deployment.waitUntilAlive({
          signal: AbortSignal.timeout(timeoutMs),
        });

        let bridge: Awaited<ReturnType<typeof startFrpEgressBridge>> | null = null;
        try {
          {
            await using recordingProxy = await useMockHttpServer({
              onUnhandledRequest: "bypass",
              recorder: {
                enabled: true,
                harPath,
              },
            });
            proxyPort = recordingProxy.port;

            bridge = await startFrpEgressBridge({
              deployment,
              localTargetHost: "127.0.0.1",
              localTargetPort: proxyPort,
              frpcBin: process.env.JONASLAND_E2E_FRPC_BIN,
            });
            await deployment.setEnvVars({
              ITERATE_EGRESS_PROXY: bridge.dataProxyUrl,
            });
            await deploymentFixture.waitForShellSuccess({
              cmd: "curl -sS --max-time 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:27180/__iterate/health | grep -vq '^000$'",
              timeoutMs: 30_000,
            });

            const recordedConversation = await runPiConversation({
              deployment,
              sessionDir: "/tmp/pi-egress-record-session",
            });
            expect(recordedConversation).toMatchObject({
              turn1: {
                exitCode: 0,
                output: expect.stringContaining("add"),
              },
              turn2: {
                exitCode: 0,
                output: expect.stringContaining("number"),
              },
              turn3: {
                exitCode: 0,
                output: expect.stringContaining("vitest"),
              },
            });
            expect(recordedConversation.turn3.output.toLowerCase()).toContain("expect");

            await recordingProxy.writeHar(harPath);
            recordedHar = JSON.parse(await readFile(harPath, "utf8")) as HarWithExtensions;
            const recordedUrls = harRequestUrls(recordedHar);
            expect(recordedUrls.length).toBeGreaterThan(0);
            expect(assertReplayLooksLikeAiTraffic(recordedUrls)).toBe(true);
          }

          if (!recordedHar) {
            throw new Error("recorded HAR missing after recording phase");
          }

          {
            await using replayProxy = await useMockHttpServer({
              port: proxyPort,
              onUnhandledRequest: "error",
              recorder: {
                enabled: true,
                harPath: replayHarPath,
              },
            });
            replayProxy.use(...fromTrafficWithWebSocket(recordedHar));

            await deploymentFixture.waitForShellSuccess({
              cmd: "curl -sS --max-time 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:27180/__iterate/health | grep -vq '^000$'",
              timeoutMs: 30_000,
            });

            const replayedConversation = await runPiConversation({
              deployment,
              sessionDir: "/tmp/pi-egress-replay-session",
            });
            expect(replayedConversation).toMatchObject({
              turn1: {
                exitCode: 0,
                output: expect.stringContaining("add"),
              },
              turn2: {
                exitCode: 0,
                output: expect.stringContaining("number"),
              },
              turn3: {
                exitCode: 0,
                output: expect.stringContaining("vitest"),
              },
            });
            expect(replayedConversation.turn3.output.toLowerCase()).toContain("expect");

            await replayProxy.writeHar(replayHarPath);
            const replayHar = JSON.parse(
              await readFile(replayHarPath, "utf8"),
            ) as HarWithExtensions;
            expect(harRequestUrls(replayHar).length).toBeGreaterThan(0);
          }
        } finally {
          if (bridge) await bridge.stop().catch(() => {});
        }
      },
    );
  });
});
