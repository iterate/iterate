import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe } from "vitest";
import { HttpResponse, http } from "msw";
import { fromTrafficWithWebSocket, useMockHttpServer } from "@iterate-com/mock-http-proxy";
import type { HarWithExtensions } from "@iterate-com/mock-http-proxy";
import { Deployment } from "@iterate-com/shared/jonasland/deployment/deployment.ts";
import { createDockerProvider } from "@iterate-com/shared/jonasland/deployment/docker-deployment.ts";
import { createFlyProvider } from "@iterate-com/shared/jonasland/deployment/fly-deployment.ts";
import {
  DockerDeploymentTestEnv,
  FlyDeploymentTestEnv,
} from "../../test-helpers/deployment-test-env.ts";
import {
  configureFrpEgressProxy,
  harLooksLikeAiTraffic,
  harRequestUrls,
  replayFixtureOpenAiKey,
  runPiConversation,
  waitUntilFrpTunnelIsActive,
} from "../../test-helpers/pi-agent-egress.ts";
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
    tags: ["docker", "third-party"] as const,
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
    tags: ["fly", "slow", "third-party"] as const,
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
const replayFixtureHarPath = join(
  process.cwd(),
  "vitest",
  "02-networking",
  "fixtures",
  "docker-pi-conversation.har",
);

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
        await using _deploymentFixture = await e2e.useDeployment({
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
            await configureFrpEgressProxy({
              deployment,
              egressProxyURL: bridge.egressProxyURL,
            });
            await waitUntilFrpTunnelIsActive({
              deployment,
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
            expect(harLooksLikeAiTraffic(recordedUrls)).toBe(true);
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
            replayProxy.use(
              http.get("http://127.0.0.1:27180/__iterate/health", () => {
                return new HttpResponse("ok");
              }),
            );
            replayProxy.use(...fromTrafficWithWebSocket(recordedHar));

            await waitUntilFrpTunnelIsActive({
              deployment,
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
          await using _deploymentFixture = await e2e.useDeployment({
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
            replayProxy.use(
              http.get("http://127.0.0.1:27180/__iterate/health", () => {
                return new HttpResponse("ok");
              }),
            );
            replayProxy.use(...fromTrafficWithWebSocket(replayFixtureHar));

            bridge = await useFrpTunnelToDeployment({
              deployment,
              localTargetHost: "127.0.0.1",
              localTargetPort: replayProxy.port,
              frpcBin: process.env.JONASLAND_E2E_FRPC_BIN,
            });
            await configureFrpEgressProxy({
              deployment,
              egressProxyURL: bridge.egressProxyURL,
            });
            await waitUntilFrpTunnelIsActive({
              deployment,
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
      tags: ["docker", "third-party"],
    });
    describe.each([
      {
        id: "docker" as const,
        tags: ["docker", "no-internet"] as const,
      },
      {
        id: "fly" as const,
        tags: ["fly", "slow", "no-internet"] as const,
      },
    ])("$id", ({ tags }) => {
      test.todo("transparent egress tagging can be proven with an inline deployment-local proxy", {
        tags: [...tags],
      });
    });
  });
});
