import { readFile } from "node:fs/promises";
import { describe } from "vitest";
import { createDockerProvider } from "@iterate-com/shared/jonasland/deployment/docker-deployment.ts";
import { createFlyProvider } from "@iterate-com/shared/jonasland/deployment/fly-deployment.ts";
import { Deployment } from "@iterate-com/shared/jonasland/deployment/deployment.ts";
import type {
  DeploymentOpts,
  DeploymentProvider,
} from "@iterate-com/shared/jonasland/deployment/deployment-provider-manifest.ts";
import { parse as parseYaml } from "yaml";
import { FlyDeploymentTestEnv } from "../../test-helpers/deployment-test-env.ts";
import { test, type DeploymentLogsArtifact } from "../../test-support/e2e-test.ts";

// This file intentionally tests the deployment provider abstraction itself, not
// our sandbox image. It stays pinned to a minimal neutral Debian image on
// purpose so provider lifecycle, attach, exec, logs, and restart behavior are
// validated independently of jonasland sandbox boot logic.

type ProviderContractCase = {
  id: string;
  tags: readonly string[];
  extraTimeoutMs?: number;
  createProvider(): DeploymentProvider;
};

const baseAssertionTimeoutMs = 30_000;

const cases: readonly ProviderContractCase[] = [
  {
    id: "docker",
    tags: ["docker", "no-internet"] as const,
    createProvider: () => createDockerProvider({}),
  },
  {
    id: "fly",
    tags: ["fly", "slow"] as const,
    // creating fly machines can be sloooooow
    extraTimeoutMs: 150_000,
    createProvider: () => createFlyProvider(FlyDeploymentTestEnv.parse(process.env)),
  },
];

describe("deployment provider contract", () => {
  describe.concurrent.each(cases)("$id", (tc) => {
    test(
      "supports create, logs, exec/file IO, attach, stop, start, and rootfs persistence across restart",
      {
        tags: [...tc.tags],
        timeout: baseAssertionTimeoutMs * 2 + (tc.extraTimeoutMs ?? 0),
      },
      async ({ expect, e2e }) => {
        const provider = tc.createProvider();
        let locator!: unknown;
        let logsPath!: string;
        {
          // Keep the owning deployment + fixture in a dedicated block so they are
          // disposed before we assert that reconnecting by locator now fails.
          const deployment = await Deployment.create({
            provider,
            opts: {
              slug: e2e.deploymentSlug,
              image: "debian:trixie-slim",
              entrypoint: ["sh", "-ec"],
              cmd: [
                [
                  "echo provider-contract-startup-begin",
                  "echo provider-contract-writing-startup-log",
                  "echo provider-contract-entering-sleep",
                  "exec sleep infinity",
                ].join("\n"),
              ],
            } satisfies DeploymentOpts,
          });
          await using deploymentFixture = await e2e.useDeployment({
            deployment,
            waitUntilHealthy: false,
          });
          logsPath = deploymentFixture.artifacts.logsPath!;
          console.log(
            `[provider-contract] debug artifacts for ${e2e.deploymentSlug}: ${deploymentFixture.artifacts.dir} (test slug: ${e2e.testSlug}, console: ${deploymentFixture.artifacts.consoleLogPath}, raw logs: ${deploymentFixture.artifacts.logsPath})`,
          );

          await deploymentFixture.waitUntilExecAvailable({
            timeoutMs: baseAssertionTimeoutMs + (tc.extraTimeoutMs ?? 0),
          });

          // 1) deployment creates successfully
          const initialSnapshot = deploymentFixture.snapshot();
          expect(initialSnapshot).toMatchObject({
            state: "connected",
            slug: e2e.deploymentSlug,
            locator: expect.anything(),
            opts: {
              slug: e2e.deploymentSlug,
              image: expect.stringContaining("debian:trixie-slim"),
              entrypoint: ["sh", "-ec"],
            },
          });
          const initialStatus = await deployment.status();
          expect(initialStatus.state).toBe("running");
          expect(deploymentFixture.snapshot().providerStatus).toMatchObject({
            state: "running",
          });

          // 2) provider logs are available through the deployment log stream.
          // The fixture keeps history in memory for assertions and mirrors it to
          // the temp artifact directory for debugging.
          // The startup command emits this marker, but providers may wrap it in
          // their own process-launch logging. Assert that the log stream
          // surfaces a line containing the marker rather than requiring an
          // exact provider-specific log format.
          const observedLogEntry = await deploymentFixture.waitForLogLine({
            lineIncludes: "provider-contract-writing-startup-log",
            timeoutMs: baseAssertionTimeoutMs,
          });

          expect(observedLogEntry).toMatchObject({
            text: expect.stringContaining("provider-contract-writing-startup-log"),
            observedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
          });
          // The mirrored artifact file is what we inspect after failures, so the
          // fixture should persist log history there too.
          await deploymentFixture.waitForArtifactText({
            needle: "provider-contract-writing-startup-log",
            timeoutMs: baseAssertionTimeoutMs,
          });

          // 3) exec works and we can read/write files
          const exec = await deployment.shell({
            cmd: "echo provider-contract-ok && echo provider-contract-stderr >&2 && uname -s",
          });
          expect(exec.exitCode).toBe(0);
          expect(exec.stdout).toContain("provider-contract-ok");
          expect(exec.stderr).toContain("provider-contract-stderr");
          expect(exec.output).toContain("provider-contract-ok");
          expect(exec.output).toContain("provider-contract-stderr");

          // The rootfs marker lives at a normal filesystem path so the test can
          // prove provider restarts preserve ordinary runtime state.
          const writeMarker = await deployment.shell({
            cmd: `printf '%s' ${JSON.stringify(`rootfs-persist-${e2e.testId}`)} > /root/rootfs-persistence-marker.txt`,
          });
          expect(writeMarker.exitCode, writeMarker.output).toBe(0);

          const readMarkerBeforeAttach = await deployment.shell({
            cmd: "cat /root/rootfs-persistence-marker.txt",
          });
          expect(readMarkerBeforeAttach.exitCode, readMarkerBeforeAttach.output).toBe(0);
          expect(readMarkerBeforeAttach.output).toBe(`rootfs-persist-${e2e.testId}`);

          // 4) attach from a fresh deployment instance and verify it works
          const reconnectedDeployment = await Deployment.connect({
            provider,
            locator: deployment.locator,
          });

          const attachedRead = await reconnectedDeployment.shell({
            cmd: "cat /root/rootfs-persistence-marker.txt",
          });
          expect(attachedRead.exitCode, attachedRead.output).toBe(0);
          expect(attachedRead.output).toBe(`rootfs-persist-${e2e.testId}`);

          // 5) stop the deployment
          await reconnectedDeployment.stop();
          const stoppedStatus = await reconnectedDeployment.status();
          expect(stoppedStatus.state).toBe("stopped");

          // 6) start it again
          await reconnectedDeployment.start();
          await deploymentFixture.waitUntilExecAvailable({
            deployment: reconnectedDeployment,
            timeoutMs: baseAssertionTimeoutMs,
          });

          // 7) file written before stop/start is still there
          const afterRestart = await reconnectedDeployment.shell({
            cmd: "cat /root/rootfs-persistence-marker.txt",
          });
          expect(afterRestart.exitCode, afterRestart.output).toBe(0);
          expect(afterRestart.output).toBe(`rootfs-persist-${e2e.testId}`);
          locator = deployment.locator;
        }

        // 8) once the owning test fixture scope is gone, the runtime is destroyed
        // and a fresh connect attempt should fail.
        await expect(
          Deployment.connect({
            provider,
            locator,
          }),
        ).rejects.toThrow();

        const logsArtifact = await readFile(logsPath, "utf8");
        const artifact = parseYaml(logsArtifact) as DeploymentLogsArtifact;

        expect(artifact).toMatchObject({
          deployment: {
            slug: e2e.deploymentSlug,
            state: "destroyed",
            opts: null,
          },
        });

        expect(artifact.logs.length).toBeGreaterThanOrEqual(1);
        expect(artifact.logs).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              text: "provider-contract-startup-begin",
              observedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
            }),
            expect.objectContaining({
              text: "provider-contract-writing-startup-log",
              observedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
            }),
            expect.objectContaining({
              text: "provider-contract-entering-sleep",
              observedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
            }),
          ]),
        );
      },
    );
  });
});
