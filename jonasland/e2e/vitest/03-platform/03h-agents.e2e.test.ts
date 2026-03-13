import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe } from "vitest";
import { HttpResponse, http } from "msw";
import { fromTrafficWithWebSocket, useMockHttpServer } from "@iterate-com/mock-http-proxy";
import type { HarWithExtensions } from "@iterate-com/mock-http-proxy";
import { Deployment } from "@iterate-com/shared/jonasland/deployment/deployment.ts";
import { createDockerProvider } from "@iterate-com/shared/jonasland/deployment/docker-deployment.ts";
import { DockerDeploymentTestEnv } from "../../test-helpers/deployment-test-env.ts";
import {
  configureFrpEgressProxy,
  harLooksLikeAiTraffic,
  harRequestUrls,
  runPiConversation,
  waitUntilFrpTunnelIsActive,
} from "../../test-helpers/pi-agent-egress.ts";
import { useFrpTunnelToDeployment } from "../../test-helpers/old/frp-egress-bridge.ts";
import { test } from "../../test-support/e2e-test.ts";

/**
 * Legacy migration notes from deleted `jonasland/e2e/tests/clean/agent-cli.e2e.test.ts`.
 *
 * That file verified that the real agent CLIs in the sandbox image could answer
 * a simple arithmetic prompt when given real API keys. It was parameterized
 * across Docker and Fly and used the same basic recipe for each CLI:
 *
 * - create deployment with `OPENAI_API_KEY` and `ANTHROPIC_API_KEY`
 * - `await deployment.waitUntilAlive(...)`
 * - invoke the CLI from a login shell so PATH and shell init match the image
 * - assert the output contains `42`
 *
 * Legacy command shapes worth keeping:
 *
 * - `opencode run 'what is 50 minus 8?'`
 * - `claude -p 'what is 50 minus 8?'`
 * - `pi -p 'what is 50 minus 8?'`
 * - `codex exec 'what is 50 minus 8?'`
 *
 * The old file explicitly skipped codex because the Responses API depends on
 * WebSocket traffic, and that path still broke through the caddy TLS MITM
 * egress layer. Keep that limitation documented until websocket egress is
 * proven green in the sandbox image.
 */
const cases = [
  {
    id: "docker" as const,
    tags: ["docker"] as const,
  },
  {
    id: "fly" as const,
    tags: ["fly", "slow"] as const,
  },
];

const dockerAgentCases = [
  {
    id: "docker" as const,
    tags: ["docker", "third-party"] as const,
    timeoutMs: 240_000,
    createDeployment: async ({ slug, env }: { slug: string; env: Record<string, string> }) => {
      const providerEnv = DockerDeploymentTestEnv.parse(process.env);
      return await Deployment.create({
        provider: createDockerProvider({}),
        opts: {
          slug,
          image: providerEnv.image,
          env,
        },
      });
    },
  },
];

const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const hasAiKeys = OPENAI_API_KEY.length > 0 && ANTHROPIC_API_KEY.length > 0;

describe("agents", () => {
  describe.runIf(hasAiKeys).each(dockerAgentCases)(
    "$id",
    ({ createDeployment, tags, timeoutMs }) => {
      test(
        "pi records and replays a multi-turn coding session through HAR-backed egress",
        { tags: [...tags], timeout: timeoutMs },
        async ({ expect, e2e }) => {
          const artifactsDir = join(e2e.outputDir, "pi-record-replay");
          await mkdir(artifactsDir, { recursive: true });
          const harPath = join(artifactsDir, "docker-pi-recording.har");
          const replayHarPath = join(artifactsDir, "docker-pi-replay.har");
          let proxyPort = 0;
          let recordedHar: HarWithExtensions | null = null;

          const deployment = await createDeployment({
            slug: e2e.deploymentSlug,
            env: {
              OPENAI_API_KEY,
              ANTHROPIC_API_KEY,
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
                sessionDir: "/tmp/pi-agent-record-session",
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
              throw new Error("recorded HAR missing after pi recording phase");
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
                sessionDir: "/tmp/pi-agent-replay-session",
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
              const replayUrls = harRequestUrls(replayHar);
              expect(replayUrls.length).toBeGreaterThan(0);
              expect(harLooksLikeAiTraffic(replayUrls)).toBe(true);
            }
          } finally {
            if (bridge) await bridge.stop().catch(() => {});
          }
        },
      );
    },
  );

  describe.each(cases)("$id", ({ tags }) => {
    // Start with the one-shot "answer a simple question" smoke checks from the
    // legacy suite before growing into richer prompt/replay coverage.
    test.todo("claude responds in supported provider cases", {
      tags: [...tags],
    });
    test.todo("pi responds in supported provider cases outside the HAR record/replay path", {
      tags: [...tags],
    });
    test.todo("opencode responds in supported provider cases", {
      tags: [...tags],
    });
    test.todo("codex responds in supported provider cases", {
      tags: [...tags],
    });
    test.todo(
      "agent coverage works both with live egress and with HAR-backed replay where feasible",
      {
        tags: [...tags],
      },
    );
  });
});
