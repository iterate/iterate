import { describe } from "vitest";
import {
  createDockerProvider,
  dockerDeploymentLocatorSchema,
  inspectDockerContainer,
} from "@iterate-com/shared/jonasland/deployment/docker-deployment.ts";
import { Deployment } from "@iterate-com/shared/jonasland/deployment/deployment.ts";
import { z } from "zod/v4";
import { test } from "../../test-support/e2e-test.ts";

/**
 * Docker-only provider coverage lives here.
 *
 * `01a` is the shared provider-contract file; this file is for Docker-specific
 * behavior that only makes sense when the concrete provider is Docker. Host
 * sync is the first such case.
 */
const nonEmptyString = z.string().trim().min(1);

const DockerHostSyncTestEnv = z
  .object({
    E2E_DOCKER_IMAGE_REF: nonEmptyString.optional(),
    JONASLAND_SANDBOX_IMAGE: nonEmptyString,
  })
  .transform(({ E2E_DOCKER_IMAGE_REF, JONASLAND_SANDBOX_IMAGE }) => ({
    image: E2E_DOCKER_IMAGE_REF ?? JONASLAND_SANDBOX_IMAGE,
  }));

describe("docker host sync", () => {
  test(
    "shared pnpm store volume mounts without host sync",
    {
      tags: ["docker", "no-internet"],
      timeout: 180_000,
    },
    async ({ expect, e2e }) => {
      const env = DockerHostSyncTestEnv.parse(process.env);
      const deployment = await Deployment.create({
        provider: createDockerProvider({}),
        opts: {
          slug: e2e.deploymentSlug,
          image: env.image,
        },
      });
      await using deploymentFixture = await e2e.useDeployment({
        deployment,
        waitUntilHealthyTimeoutMs: 120_000,
      });

      const locator = dockerDeploymentLocatorSchema.parse(deployment.locator);
      const inspect = await inspectDockerContainer({ locator });
      expect(inspect.Mounts ?? []).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            Type: "volume",
            Destination: "/home/iterate/.pnpm-store",
            Name: "iterate-pnpm-store",
          }),
        ]),
      );
      expect(inspect.Mounts ?? []).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            Type: "bind",
            Destination: "/host/repo-checkout",
          }),
        ]),
      );

      expect(deploymentFixture.snapshot().providerStatus).toMatchObject({
        state: "running",
      });
    },
  );

  test(
    "host sync mounts the shared pnpm store volume",
    {
      tags: ["docker", "no-internet"],
      timeout: 180_000,
    },
    async ({ expect, e2e }) => {
      const env = DockerHostSyncTestEnv.parse(process.env);
      const deployment = await Deployment.create({
        provider: createDockerProvider({}),
        opts: {
          slug: e2e.deploymentSlug,
          image: env.image,
          env: {
            DOCKER_HOST_SYNC_ENABLED: "true",
          },
        },
      });
      await using deploymentFixture = await e2e.useDeployment({
        deployment,
        waitUntilHealthyTimeoutMs: 120_000,
      });

      // This locks the cache optimization to the real jonasland host-sync boot
      // path instead of only checking the provider config in isolation.
      const configuredStoreDir = await deployment.shell({
        cmd: "cd /home/iterate/src/github.com/iterate/iterate && pnpm config get store-dir",
      });
      expect(configuredStoreDir.exitCode, configuredStoreDir.output).toBe(0);
      expect(configuredStoreDir.stdout.trim()).toBe("/home/iterate/.pnpm-store");

      const resolvedStorePath = await deployment.shell({
        cmd: "cd /home/iterate/src/github.com/iterate/iterate && pnpm store path",
      });
      expect(resolvedStorePath.exitCode, resolvedStorePath.output).toBe(0);
      expect(resolvedStorePath.stdout.trim()).toContain("/home/iterate/.pnpm-store");

      const writableStorePath = await deployment.shell({
        cmd: 'store_path="$(cd /home/iterate/src/github.com/iterate/iterate && pnpm store path)" && mkdir -p "$store_path" && test -w "$store_path"',
      });
      expect(writableStorePath.exitCode, writableStorePath.output).toBe(0);

      const runtimeEnvFile = await deployment.shell({
        cmd: 'cat "$HOME/.iterate/.env"',
      });
      expect(runtimeEnvFile.exitCode, runtimeEnvFile.output).toBe(0);
      expect(runtimeEnvFile.stdout).toContain('DOCKER_HOST_SYNC_ENABLED="true"');

      const locator = dockerDeploymentLocatorSchema.parse(deployment.locator);
      const inspect = await inspectDockerContainer({ locator });
      expect(inspect.Config?.Env ?? []).toEqual(
        expect.arrayContaining(["DOCKER_HOST_SYNC_ENABLED=true"]),
      );
      expect(inspect.Config?.Env ?? []).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/^DOCKER_HOST_GIT_REPO_ROOT=/)]),
      );
      expect(inspect.Mounts ?? []).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            Type: "volume",
            Destination: "/home/iterate/.pnpm-store",
            Name: "iterate-pnpm-store",
          }),
          expect.objectContaining({
            Type: "bind",
            Destination: "/host/repo-checkout",
          }),
        ]),
      );

      expect(deploymentFixture.snapshot().providerStatus).toMatchObject({
        state: "running",
      });
    },
  );
});
