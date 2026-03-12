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
import { useFrpTunnelToDeployment } from "../../test-helpers/old/frp-egress-bridge.ts";
import { test } from "../../test-support/e2e-test.ts";

/**
 * Legacy migration notes from deleted networking tests under
 * `jonasland/e2e/tests/clean/`.
 *
 * The current record/replay test covers the most important FRP-backed AI path,
 * but the deleted suite also covered a few narrower variants that are still
 * useful as TODOs here:
 *
 * - `docker-egress-host-proxy-minimal.e2e.ts`
 *   Docker-only host-side external proxy via `host.docker.internal`, including
 *   `pnpm install`, direct `curl` probes, HAR recording, and assertions that
 *   proxied requests carried `x-iterate-egress-mode: external-proxy` and
 *   `x-iterate-egress-proxy-seen: 1`.
 * - `network-smoke.e2e.test.ts`
 *   Provider-parameterized inline proxy logger on `127.0.0.1:19123` that also
 *   checked deployment env passthrough before asserting transparent egress tags.
 *
 * If either behavior comes back, prefer porting it into this file rather than
 * recreating a parallel legacy-only tree.
 */
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
const replayFixtureOpenAiKey =
  "sk-proj-XVqC7k9h6rEOfbSs8XP9qzlOELpRTFmbdEkkwejcF---sanitised-secret-acf2c7b4";
const replayFixtureHarPath = join(
  process.cwd(),
  "vitest",
  "02-networking",
  "fixtures",
  "docker-pi-conversation.har",
);

// [[ Something that the AI should discover later on. This should be on the deployment fixture that you get from `use deployment`, so that we can use it in other files as well and make it better over time.  ]]

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

        let bridge: Awaited<ReturnType<typeof useFrpTunnelToDeployment>> | null = null;
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

            bridge = await useFrpTunnelToDeployment({
              deployment,
              localTargetHost: "127.0.0.1",
              localTargetPort: proxyPort,
              frpcBin: process.env.JONASLAND_E2E_FRPC_BIN,
            });
            await deployment.updateEgressConfig({
              egressProxyURL: bridge.egressProxyURL,
            });
            await deployment.shellWithRetry({
              cmd: "curl -sS --max-time 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:27180/__iterate/health",
              timeoutMs: 30_000,
              retryIf: (result) => result.output.trim() === "000" || result.exitCode !== 0,
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

            // [[ Okay, so this here needs to be replaced with retry, somewhere we're waiting for a pnpm health check or something more coherent.  ]]
            await deployment.shellWithRetry({
              cmd: "curl -sS --max-time 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:27180/__iterate/health",
              timeoutMs: 30_000,
              retryIf: (result) => result.output.trim() === "000" || result.exitCode !== 0,
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

  describe.each(cases.filter((tc) => tc.id === "docker"))(
    "$id",
    ({ createDeployment, tags, timeoutMs }) => {
      test(
        "replays a checked-in pi HAR fixture fully offline through the FRP egress path",
        { tags: [...tags, "no-internet"], timeout: timeoutMs },
        async ({ expect, e2e }) => {
          const artifactsDir = join(e2e.outputDir, "egress-replay-only");
          await mkdir(artifactsDir, { recursive: true });
          const replayHarPath = join(artifactsDir, "docker-pi-conversation.replay.har");
          const replayFixtureHar = JSON.parse(
            await readFile(replayFixtureHarPath, "utf8"),
          ) as HarWithExtensions;

          const deployment = await createDeployment({
            slug: e2e.deploymentSlug,
            env: {
              OPENAI_API_KEY: replayFixtureOpenAiKey,
            },
          });
          await using deploymentFixture = await e2e.useDeployment({
            deployment,
          });
          await deployment.waitUntilAlive({
            signal: AbortSignal.timeout(timeoutMs),
          });

          let bridge: Awaited<ReturnType<typeof useFrpTunnelToDeployment>> | null = null;
          try {
            await using replayProxy = await useMockHttpServer({
              onUnhandledRequest: "error",
              recorder: {
                enabled: true,
                harPath: replayHarPath,
              },
            });
            replayProxy.use(...fromTrafficWithWebSocket(replayFixtureHar));

            bridge = await useFrpTunnelToDeployment({
              deployment,
              localTargetHost: "127.0.0.1",
              localTargetPort: replayProxy.port,
              frpcBin: process.env.JONASLAND_E2E_FRPC_BIN,
            });
            await deployment.updateEgressConfig({
              egressProxyURL: bridge.egressProxyURL,
            });
            await deployment.shellWithRetry({
              cmd: "curl -sS --max-time 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:27180/__iterate/health",
              timeoutMs: 30_000,
              retryIf: (result) => result.output.trim() === "000" || result.exitCode !== 0,
            });

            const replayedConversation = await runPiConversation({
              deployment,
              sessionDir: "/tmp/pi-egress-fixture-session",
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
          } finally {
            if (bridge) await bridge.stop().catch(() => {});
          }
        },
      );
    },
  );

  describe("legacy migration notes", () => {
    test.todo("docker host.docker.internal proxy path supports pnpm install and HAR capture", {
      tags: ["providers/docker", "third-party-dependency"],
    });
    describe.each([
      {
        id: "docker" as const,
        tags: ["providers/docker", "no-internet"] as const,
      },
      {
        id: "fly" as const,
        tags: ["providers/fly", "slow", "no-internet"] as const,
      },
    ])("$id", ({ tags }) => {
      test.todo("transparent egress tagging can be proven with an inline deployment-local proxy", {
        tags: [...tags],
      });
    });
  });
});
